// Receipt & Purchase Intelligence V1 — the deterministic truth layer.
//
// One pure function from an extraction payload to a review model. Every rule
// that decides what the customer is SHOWN as a purchase lives here, in code
// that can be read and tested. None of it is left to the model:
//
//   BLOCK-RPI-25  merchant never becomes item brand without line evidence
//   BLOCK-RPI-26  card fragments are scrubbed from every free-text value
//   BLOCK-RPI-27  low document confidence produces zero candidates
//   BLOCK-RPI-28  returned / refunded lines are never ownership candidates
//   BLOCK-RPI-29  an unknown or ambiguous currency is never guessed
//   BLOCK-RPI-32  more lines than the bound is refused, never truncated
//
// The server has already bounded and sanitized the payload. This module does
// not trust that. It re-validates every field, because this is where purchase
// evidence becomes something a customer can turn into ownership.
//
// PURE: no I/O, no Date.now() unless injected, no Math.random.

import {
  PURCHASE_CLOSET_CATEGORIES,
  PURCHASE_CLOSET_LINE_CLASSES,
  PURCHASE_DOCUMENT_KINDS,
  PURCHASE_IMPORT_DOCUMENT_CONFIDENCE_FLOOR,
  PURCHASE_IMPORT_ITEM_CONFIDENCE_FLOOR,
  PURCHASE_IMPORT_ITEM_REVIEW_THRESHOLD,
  PURCHASE_IMPORT_MAX_ITEMS,
  PURCHASE_IMPORT_MAX_UNITS_PER_LINE,
  PURCHASE_LINE_CLASSES,
  PURCHASE_LINE_KINDS,
  type PurchaseClosetCategory,
  type PurchaseDocumentKind,
  type PurchaseFieldProvenance,
  type PurchaseLineClass,
  type PurchaseLineKind,
} from './purchaseImportContract';
import { isValidGtin, sanitizeIdentifier, scrubSensitiveText } from './purchaseImportSensitive';

// ── Review model ─────────────────────────────────────────────────────────────

export type ReviewField<T> = {
  value: T | null;
  provenance: PurchaseFieldProvenance;
  /** True when the customer should look at this value before confirming. */
  uncertain: boolean;
};

export type ReviewCandidateFlags = {
  lowConfidence: boolean;
  priceInconsistent: boolean;
  /** An exchange, or a line whose direction the document leaves unclear. */
  transactionAmbiguous: boolean;
  /** Only a symbol like "$" was printed, which several currencies share. */
  currencyAmbiguous: boolean;
  /**
   * An owned Closet item already carries this exact GTIN, or this exact SKU
   * from the same merchant. Deterministic evidence only (spec section 21):
   * never title, brand, colour or image similarity. The line starts
   * deselected, and the customer can still add it: owning two identical
   * garments is legitimate.
   */
  possibleDuplicate: boolean;
};

export type ReviewCandidate = {
  /** Stable within one import: the line's position in the document. */
  lineIndex: number;
  /** Verbatim, scrubbed item text. Shown to the customer. NEVER persisted. */
  sourceLine: string | null;
  selected: boolean;
  title: ReviewField<string>;
  brand: ReviewField<string>;
  category: ReviewField<string>;
  subtype: ReviewField<string>;
  primaryColor: ReviewField<string>;
  secondaryColors: string[];
  material: ReviewField<string[]>;
  size: ReviewField<string>;
  /** Per-unit price paid. Present only alongside a known currency. */
  unitPrice: ReviewField<number>;
  currency: ReviewField<string>;
  /** Currencies the printed symbol could mean, for the customer to choose. */
  currencyOptions: string[];
  /** Quantity printed on the line, or 1 when absent. */
  quantity: number;
  /** How many identical Closet records this line will add. 1..quantity. */
  unitsToAdd: number;
  sku: string | null;
  gtin: string | null;
  retailerProductRef: string | null;
  flags: ReviewCandidateFlags;
};

export type ExcludedLineReason =
  | 'not_closet_fashion'
  | 'non_fashion'
  | 'not_an_item'
  | 'returned'
  | 'unreadable_line';

export type ReviewDocument = {
  merchant: ReviewField<string>;
  purchaseDate: ReviewField<string>;
  returnDeadline: ReviewField<string>;
  documentKind: PurchaseDocumentKind;
  documentConfidence: number;
};

export type PurchaseReviewModel =
  | {
      state: 'ready';
      document: ReviewDocument;
      candidates: ReviewCandidate[];
      excluded: Record<ExcludedLineReason, number>;
    }
  | {
      state: 'no_fashion';
      document: ReviewDocument;
      candidates: [];
      excluded: Record<ExcludedLineReason, number>;
    }
  | { state: 'unreadable' }
  | { state: 'too_many_items' }
  | { state: 'invalid' };

// ── Small helpers ────────────────────────────────────────────────────────────

function field<T>(value: T | null, provenance: PurchaseFieldProvenance, uncertain = false): ReviewField<T> {
  return value === null || value === undefined
    ? { value: null, provenance: 'UNKNOWN', uncertain: false }
    : { value, provenance, uncertain };
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function confidenceOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1 ? value : null;
}

/** Lowercase, collapse whitespace and strip punctuation, for evidence comparison only. */
export function evidenceKey(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[’'`]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** True when `needle` appears in `haystack` as whole words after evidence normalization. */
export function appearsVerbatim(needle: string | null, haystack: string | null): boolean {
  if (!needle || !haystack) return false;
  const n = evidenceKey(needle);
  const h = evidenceKey(haystack);
  if (!n || !h) return false;
  return ` ${h} `.includes(` ${n} `);
}

function cleanList(value: unknown, maxLength: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = scrubSensitiveText(entry, maxLength);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/** ISO calendar date YYYY-MM-DD that actually exists. */
export function isoDateOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, y, m, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  if (
    date.getUTCFullYear() !== Number(y) ||
    date.getUTCMonth() !== Number(m) - 1 ||
    date.getUTCDate() !== Number(d)
  ) {
    return null;
  }
  if (Number(y) < 1990) return null;
  return `${y}-${m}-${d}`;
}

function money(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.abs(value) > 1_000_000) return null;
  return Math.round(value * 100) / 100;
}

// ── Currency ─────────────────────────────────────────────────────────────────

/**
 * Symbols that name exactly one currency. A symbol not in this table (for
 * example "$", "¥" or "kr") is AMBIGUOUS and is never resolved by K Scan. The
 * customer picks from SYMBOL_OPTIONS, which is a list of possibilities, not a
 * default.
 */
const UNAMBIGUOUS_SYMBOLS: Readonly<Record<string, string>> = Object.freeze({
  '€': 'EUR',
  '£': 'GBP',
  '₹': 'INR',
  '₩': 'KRW',
  '₺': 'TRY',
  '₪': 'ILS',
  '₫': 'VND',
  '₱': 'PHP',
  '₦': 'NGN',
});

const SYMBOL_OPTIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  $: ['USD', 'CAD', 'AUD', 'NZD', 'SGD', 'HKD', 'MXN'],
  'US$': ['USD'],
  'C$': ['CAD'],
  'A$': ['AUD'],
  'NZ$': ['NZD'],
  'HK$': ['HKD'],
  'S$': ['SGD'],
  '¥': ['JPY', 'CNY'],
  kr: ['SEK', 'NOK', 'DKK'],
  Fr: ['CHF'],
  CHF: ['CHF'],
  R$: ['BRL'],
});

/**
 * Only codes K Scan can format. An unknown three-letter string is not a
 * currency just because it has the right shape.
 */
function isKnownCurrencyCode(code: string): boolean {
  try {
    new Intl.NumberFormat('en-US', { style: 'currency', currency: code }).format(1);
    return /^[A-Z]{3}$/.test(code);
  } catch {
    return false;
  }
}

export type CurrencyResolution = {
  currency: string | null;
  provenance: PurchaseFieldProvenance;
  ambiguous: boolean;
  options: string[];
};

/**
 * BLOCK-RPI-29. A currency is known only when the document printed an ISO code,
 * or printed a symbol that names exactly one currency. Merchant identity,
 * device locale and the customer's country are never consulted.
 */
export function resolveDocumentCurrency(
  code: unknown,
  symbol: unknown,
  evidence: unknown,
): CurrencyResolution {
  const upper = typeof code === 'string' ? code.trim().toUpperCase() : '';
  if (evidence === 'explicit_code' && isKnownCurrencyCode(upper)) {
    return { currency: upper, provenance: 'RECEIPT_EXPLICIT', ambiguous: false, options: [] };
  }
  const sym = typeof symbol === 'string' ? symbol.trim() : '';
  if (evidence === 'explicit_symbol' && sym) {
    const single = UNAMBIGUOUS_SYMBOLS[sym];
    if (single) {
      return { currency: single, provenance: 'RECEIPT_EXPLICIT', ambiguous: false, options: [] };
    }
    const options = SYMBOL_OPTIONS[sym];
    if (options && options.length === 1) {
      return { currency: options[0], provenance: 'RECEIPT_EXPLICIT', ambiguous: false, options: [] };
    }
    if (options) {
      return { currency: null, provenance: 'UNKNOWN', ambiguous: true, options: [...options] };
    }
  }
  return { currency: null, provenance: 'UNKNOWN', ambiguous: false, options: [] };
}

// ── Price arithmetic ─────────────────────────────────────────────────────────

export type PriceCheck = {
  unitPrice: number | null;
  consistent: boolean;
  /** True when the line carries any negative amount. */
  negative: boolean;
};

/**
 * Deterministic consistency check (spec section 18). With quantity, unit price
 * and line total all present, unit x quantity must equal the total to within
 * one cent per unit (rounding). A mismatch is NOT repaired. The values are
 * kept, marked uncertain, and left for the customer to correct. A line total
 * alone is converted to a unit price only when the quantity is 1.
 */
export function checkLinePrices(
  quantity: number | null,
  unitPrice: number | null,
  totalPrice: number | null,
): PriceCheck {
  const negative = (unitPrice !== null && unitPrice < 0) || (totalPrice !== null && totalPrice < 0);
  const qty = quantity ?? 1;
  if (unitPrice !== null && totalPrice !== null && quantity !== null) {
    const expected = Math.round(unitPrice * qty * 100) / 100;
    const consistent = Math.abs(expected - totalPrice) <= 0.01 * qty + 1e-9;
    return { unitPrice, consistent, negative };
  }
  if (unitPrice !== null) return { unitPrice, consistent: true, negative };
  if (totalPrice !== null && qty === 1) return { unitPrice: totalPrice, consistent: true, negative };
  // A total spread over several units without a printed unit price would be
  // arithmetic K Scan did, not a price the document printed.
  return { unitPrice: null, consistent: true, negative };
}

// ── Line classification ──────────────────────────────────────────────────────

function exclusionReasonFor(lineClass: PurchaseLineClass): ExcludedLineReason | null {
  if ((PURCHASE_CLOSET_LINE_CLASSES as readonly string[]).includes(lineClass)) return null;
  if (lineClass === 'beauty' || lineClass === 'fragrance') return 'not_closet_fashion';
  if (lineClass === 'non_fashion' || lineClass === 'gift_card') return 'non_fashion';
  if (lineClass === 'unknown') return 'unreadable_line';
  return 'not_an_item';
}

/**
 * Direction of one line in the context of its document (BLOCK-RPI-28).
 *   returned  — never a candidate
 *   ambiguous — a candidate, but deselected and flagged for the customer
 *   purchase  — a normal candidate
 */
export function lineDirection(
  lineKind: PurchaseLineKind,
  documentKind: PurchaseDocumentKind,
  negative: boolean,
): 'purchase' | 'returned' | 'ambiguous' {
  if (negative || lineKind === 'return' || lineKind === 'refund') return 'returned';
  if (lineKind === 'exchange') return 'ambiguous';
  if (lineKind === 'purchase') return 'purchase';
  // lineKind unknown: the document decides, conservatively.
  if (documentKind === 'return') return 'returned';
  if (documentKind === 'purchase') return 'purchase';
  return 'ambiguous';
}

// ── Brand ────────────────────────────────────────────────────────────────────

/**
 * BLOCK-RPI-25. A brand is kept only when the model says the brand is printed
 * on the ITEM (not in the document header) AND the brand text actually appears
 * in that item's own source line. The merchant that sold the item is never a
 * reason to believe anything about who made it.
 *
 * A retailer's private label ("Nordstrom Signature Cashmere Crew") is kept,
 * because the label is printed on the line. "Nordstrom" beside an unbranded
 * "BLK RIB TOP" is not.
 */
export function resolveBrand(
  brand: string | null,
  evidence: unknown,
  sourceLine: string | null,
): ReviewField<string> {
  if (!brand) return field<string>(null, 'UNKNOWN');
  if (evidence !== 'on_item_line') return field<string>(null, 'UNKNOWN');
  if (!appearsVerbatim(brand, sourceLine)) return field<string>(null, 'UNKNOWN');
  return field(brand, 'RECEIPT_EXPLICIT');
}

// ── Main entry ───────────────────────────────────────────────────────────────

function emptyExcluded(): Record<ExcludedLineReason, number> {
  return { not_closet_fashion: 0, non_fashion: 0, not_an_item: 0, returned: 0, unreadable_line: 0 };
}

/**
 * Normalize one extraction payload into a review model.
 *
 * `today` is injected so date checks are deterministic. It is an ISO date.
 */
export function normalizePurchaseExtraction(
  payload: unknown,
  { today }: { today: string },
): PurchaseReviewModel {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { state: 'invalid' };
  const p = payload as Record<string, unknown>;
  const doc = p.document as Record<string, unknown> | undefined;
  if (!doc || typeof doc !== 'object' || !Array.isArray(p.items)) return { state: 'invalid' };

  const documentConfidence = confidenceOf(doc.documentConfidence);
  if (documentConfidence === null) return { state: 'invalid' };
  // BLOCK-RPI-27, before anything else is looked at.
  if (documentConfidence < PURCHASE_IMPORT_DOCUMENT_CONFIDENCE_FLOOR) return { state: 'unreadable' };
  // BLOCK-RPI-32: refused, never truncated.
  if (p.items.length > PURCHASE_IMPORT_MAX_ITEMS) return { state: 'too_many_items' };

  const documentKind = oneOf(doc.documentKind, PURCHASE_DOCUMENT_KINDS, 'unknown');
  const merchant = scrubSensitiveText(doc.merchant, 120);
  const purchaseDate = isoDateOrNull(doc.purchaseDate);
  const validPurchaseDate = purchaseDate && purchaseDate <= today ? purchaseDate : null;
  const returnDeadlineRaw = isoDateOrNull(doc.explicitReturnDeadline);
  const returnDeadline =
    returnDeadlineRaw && (!validPurchaseDate || returnDeadlineRaw >= validPurchaseDate)
      ? returnDeadlineRaw
      : null;
  const currency = resolveDocumentCurrency(doc.currencyCode, doc.currencySymbol, doc.currencyEvidence);

  const document: ReviewDocument = {
    merchant: field(merchant, 'RECEIPT_EXPLICIT'),
    purchaseDate: field(validPurchaseDate, 'RECEIPT_EXPLICIT'),
    returnDeadline: field(returnDeadline, 'RECEIPT_EXPLICIT'),
    documentKind,
    documentConfidence,
  };

  const excluded = emptyExcluded();
  const candidates: ReviewCandidate[] = [];

  p.items.forEach((rawItem, lineIndex) => {
    if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
      excluded.unreadable_line += 1;
      return;
    }
    const item = rawItem as Record<string, unknown>;
    const confidence = confidenceOf(item.confidence);
    if (confidence === null || confidence < PURCHASE_IMPORT_ITEM_CONFIDENCE_FLOOR) {
      excluded.unreadable_line += 1;
      return;
    }

    const lineClass = oneOf(item.lineClass, PURCHASE_LINE_CLASSES, 'unknown');
    const exclusion = exclusionReasonFor(lineClass);
    const quantityRaw =
      typeof item.quantity === 'number' && Number.isInteger(item.quantity) ? item.quantity : null;
    const unitPriceRaw = money(item.unitPrice);
    const totalPriceRaw = money(item.totalPrice);
    const prices = checkLinePrices(quantityRaw, unitPriceRaw, totalPriceRaw);
    const direction = lineDirection(
      oneOf(item.lineKind, PURCHASE_LINE_KINDS, 'unknown'),
      documentKind,
      prices.negative || (quantityRaw !== null && quantityRaw < 0),
    );

    // Returned lines are counted as returned whatever their class, so a
    // returned jacket is reported as "returned", not silently dropped.
    if (direction === 'returned') {
      excluded.returned += 1;
      return;
    }
    if (exclusion) {
      excluded[exclusion] += 1;
      return;
    }

    const sourceLine = scrubSensitiveText(item.sourceLine, 300);
    const titleText = scrubSensitiveText(item.title, 200);
    const brandText = scrubSensitiveText(item.brand, 120);
    const subtypeText = scrubSensitiveText(item.subtype, 80);
    const colorText = scrubSensitiveText(item.primaryColor, 60);
    const materials = cleanList(item.material, 60, 8);
    // Size is a purchase fact kept exactly as printed (spec section 9). The
    // only thing done to it is bounding. It must appear on the line, or the
    // model supplied it from somewhere other than the document.
    const sizeText = scrubSensitiveText(item.sizeRaw, 40);
    const size = sizeText && appearsVerbatim(sizeText, sourceLine) ? sizeText : null;

    const category = oneOf<PurchaseClosetCategory | 'none'>(
      item.category,
      [...PURCHASE_CLOSET_CATEGORIES, 'none'],
      'none',
    );

    const skuRaw = sanitizeIdentifier(item.sku, 40);
    const sku = skuRaw && appearsVerbatim(skuRaw, sourceLine) ? skuRaw : null;
    const gtinRaw = typeof item.gtin === 'string' ? item.gtin.replace(/[\s-]/g, '') : '';
    const gtin =
      gtinRaw && isValidGtin(gtinRaw) && sourceLine && sourceLine.replace(/[\s-]/g, '').includes(gtinRaw)
        ? gtinRaw
        : null;
    const refRaw = sanitizeIdentifier(item.retailerProductRef, 60);
    const retailerProductRef = refRaw && appearsVerbatim(refRaw, sourceLine) ? refRaw : null;

    const quantity =
      quantityRaw !== null && quantityRaw >= 1 ? Math.min(quantityRaw, 99) : 1;
    const unitsToAdd = Math.min(quantity, PURCHASE_IMPORT_MAX_UNITS_PER_LINE);

    const priceKnown = prices.unitPrice !== null && prices.unitPrice > 0;
    const priceUncertain = !prices.consistent;
    const currencyUsable = priceKnown ? currency : { ...currency, ambiguous: false, options: [] };

    const lowConfidence = confidence < PURCHASE_IMPORT_ITEM_REVIEW_THRESHOLD;
    const ambiguous = direction === 'ambiguous';

    // Title: a document title is RECEIPT_EXPLICIT only if printed on the line.
    // Otherwise it is the model's reading of an abbreviation ("BLK RIB TOP M"
    // -> "Black ribbed top") and says so.
    const title = titleText
      ? field(titleText, appearsVerbatim(titleText, sourceLine) ? 'RECEIPT_EXPLICIT' : 'MODEL_NORMALIZED')
      : sourceLine
        ? field(sourceLine.slice(0, 200), 'RECEIPT_EXPLICIT')
        : field<string>(null, 'UNKNOWN');

    candidates.push({
      lineIndex,
      sourceLine,
      // Ambiguous direction is surfaced, never assumed: it starts deselected.
      selected: !ambiguous,
      title: { ...title, uncertain: title.value !== null && lowConfidence },
      brand: resolveBrand(brandText, item.brandEvidence, sourceLine),
      category: category === 'none' ? field<string>(null, 'UNKNOWN') : field<string>(category, 'MODEL_NORMALIZED'),
      subtype: field(subtypeText, 'MODEL_NORMALIZED'),
      primaryColor: field(
        colorText,
        colorText && appearsVerbatim(colorText, sourceLine) ? 'RECEIPT_EXPLICIT' : 'MODEL_NORMALIZED',
      ),
      secondaryColors: cleanList(item.secondaryColors, 60, 8),
      material: materials.length
        ? {
            value: materials,
            provenance: materials.every((m) => appearsVerbatim(m, sourceLine))
              ? 'RECEIPT_EXPLICIT'
              : 'MODEL_NORMALIZED',
            uncertain: false,
          }
        : { value: null, provenance: 'UNKNOWN', uncertain: false },
      size: field(size, 'RECEIPT_EXPLICIT'),
      unitPrice: priceKnown
        ? { value: prices.unitPrice, provenance: 'RECEIPT_EXPLICIT', uncertain: priceUncertain }
        : { value: null, provenance: 'UNKNOWN', uncertain: false },
      currency: priceKnown && currency.currency
        ? { value: currency.currency, provenance: currency.provenance, uncertain: false }
        : { value: null, provenance: 'UNKNOWN', uncertain: currencyUsable.ambiguous },
      currencyOptions: currencyUsable.options,
      quantity,
      unitsToAdd,
      sku,
      gtin,
      retailerProductRef,
      flags: {
        lowConfidence,
        priceInconsistent: priceUncertain,
        transactionAmbiguous: ambiguous,
        currencyAmbiguous: currencyUsable.ambiguous,
        possibleDuplicate: false,
      },
    });
  });

  if (candidates.length === 0) {
    return { state: 'no_fashion', document, candidates: [], excluded };
  }
  return { state: 'ready', document, candidates, excluded };
}
