// Receipt & Purchase Intelligence V1 — review edits and Closet drafts.
//
// Pure functions over the review model produced by purchaseImportNormalizer.
// Nothing here writes anything. The only way a candidate becomes an owned item
// is purchaseImportCommit.ts, after the customer's explicit confirmation.
//
// BLOCK-RPI-30: an edited field carries USER_CONFIRMED provenance. The edit
// replaces the value AND the claim about where it came from. A corrected brand
// must never go on saying the receipt printed it.

import {
  PURCHASE_IMPORT_CONTRACT_VERSION,
  PURCHASE_IMPORT_MAX_UNITS_PER_LINE,
  type ClosetPurchaseProvenance,
  type PurchaseFieldProvenance,
  type PurchaseImportInputTier,
  type PurchaseProvenanceField,
} from './purchaseImportContract';
import type { ReviewCandidate, ReviewDocument, ReviewField } from './purchaseImportNormalizer';

/** Fields the customer can edit in review. */
export type EditableCandidateField =
  | 'title'
  | 'brand'
  | 'category'
  | 'subtype'
  | 'primaryColor'
  | 'size'
  | 'unitPrice'
  | 'currency';

/**
 * Coarse telemetry groups for corrections. Only group COUNTS are ever
 * reported. Field values never are.
 */
export const CORRECTION_GROUPS: Readonly<Record<EditableCandidateField, CorrectionGroup>> = Object.freeze({
  title: 'naming',
  brand: 'maker',
  category: 'classification',
  subtype: 'classification',
  primaryColor: 'appearance',
  size: 'fit',
  unitPrice: 'money',
  currency: 'money',
});
export type CorrectionGroup = 'naming' | 'maker' | 'classification' | 'appearance' | 'fit' | 'money';

const TEXT_BOUNDS: Readonly<Record<Exclude<EditableCandidateField, 'unitPrice' | 'currency'>, number>> =
  Object.freeze({ title: 200, brand: 120, category: 80, subtype: 80, primaryColor: 60, size: 40 });

function userText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s{2,}/g, ' ').trim();
  return text ? text.slice(0, max) : null;
}

function confirmed<T>(value: T | null): ReviewField<T> {
  // A cleared field is a real correction ("this has no brand"), recorded as
  // absent rather than kept as a document claim.
  return value === null
    ? { value: null, provenance: 'UNKNOWN', uncertain: false }
    : { value, provenance: 'USER_CONFIRMED', uncertain: false };
}

/**
 * Apply one customer edit. Returns a NEW candidate, or the same candidate when
 * the edit is invalid.
 *
 * Price and currency are edited together: a price the customer enters is only
 * meaningful with a currency, and choosing a currency for a printed "$" amount
 * confirms the amount too.
 */
export function applyCandidateEdit(
  candidate: ReviewCandidate,
  fieldName: EditableCandidateField,
  value: unknown,
): ReviewCandidate {
  if (fieldName === 'unitPrice') {
    if (value === null || value === '') {
      return { ...candidate, unitPrice: confirmed<number>(null), flags: { ...candidate.flags, priceInconsistent: false } };
    }
    const numeric = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
    if (!Number.isFinite(numeric) || numeric <= 0 || numeric >= 1_000_000) return candidate;
    return {
      ...candidate,
      unitPrice: confirmed(Math.round(numeric * 100) / 100),
      flags: { ...candidate.flags, priceInconsistent: false },
    };
  }
  if (fieldName === 'currency') {
    if (value === null || value === '') {
      return { ...candidate, currency: confirmed<string>(null) };
    }
    const code = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (!/^[A-Z]{3}$/.test(code)) return candidate;
    // Picking a currency for an amount the document printed is the customer
    // confirming that amount.
    const unitPrice =
      candidate.unitPrice.value !== null && candidate.unitPrice.provenance !== 'USER_CONFIRMED'
        ? { ...candidate.unitPrice, provenance: 'USER_CONFIRMED' as PurchaseFieldProvenance, uncertain: false }
        : candidate.unitPrice;
    return {
      ...candidate,
      currency: confirmed(code),
      unitPrice,
      flags: { ...candidate.flags, currencyAmbiguous: false, priceInconsistent: false },
    };
  }
  const text = userText(value, TEXT_BOUNDS[fieldName]);
  if (fieldName === 'title' && !text) return candidate; // a title cannot be cleared
  return { ...candidate, [fieldName]: confirmed(text) };
}

/** Toggle selection. A line can only be selected with at least one unit. */
export function setCandidateSelected(candidate: ReviewCandidate, selected: boolean): ReviewCandidate {
  return { ...candidate, selected: Boolean(selected) };
}

/** Units to add for a multi-quantity line: 1..min(quantity, bound). */
export function setCandidateUnits(candidate: ReviewCandidate, units: number): ReviewCandidate {
  const max = Math.min(candidate.quantity, PURCHASE_IMPORT_MAX_UNITS_PER_LINE);
  if (!Number.isInteger(units)) return candidate;
  return { ...candidate, unitsToAdd: Math.max(1, Math.min(units, max)) };
}

/** Physical units the confirmation would add. This is the number the button states. */
export function selectedUnitCount(candidates: readonly ReviewCandidate[]): number {
  return candidates.reduce((sum, c) => sum + (c.selected ? c.unitsToAdd : 0), 0);
}

// ── Drafts ───────────────────────────────────────────────────────────────────

export type PurchaseClosetDraft = {
  /** Lineage per physical unit. Retries and double taps dedupe on it. */
  sourceLineageId: string;
  lineIndex: number;
  unitIndex: number;
  draft: {
    origin: 'purchase_import';
    title: string;
    category: string | null;
    subtype: string | null;
    brand: string | null;
    primaryColor: string | null;
    secondaryColors: string[];
    material: string[];
    size: string | null;
    sourceLineageId: string;
    purchase: ClosetPurchaseProvenance;
  };
};

/**
 * The lineage id for one physical unit of one line in one import session.
 *
 * `sessionId` is random and minted on the device when the import starts. It is
 * derived from nothing in the document, so the lineage id is not a receipt
 * fingerprint. It cannot identify the receipt, and re-importing the same
 * receipt later is handled by Closet semantics, not by a receipt history
 * (spec section 22).
 */
export function purchaseLineageId(sessionId: string, lineIndex: number, unitIndex: number): string {
  return `purchase_import:${sessionId}:${lineIndex}:${unitIndex}`;
}

function fallbackTitle(candidate: ReviewCandidate): string {
  return (
    candidate.title.value ||
    candidate.subtype.value ||
    (candidate.category.value
      ? candidate.category.value.charAt(0).toUpperCase() + candidate.category.value.slice(1)
      : null) ||
    'Closet item'
  );
}

/**
 * Build the Closet drafts for every SELECTED unit.
 *
 * What is carried: the confirmed taxonomy (so Elise, Packing and the Concierge
 * learn about the garment through the Closet they already read) and bounded
 * purchase provenance. What is not: the source line, the document, confidence
 * scores, and anything identifying the receipt.
 *
 * A price is carried only with a known currency (BLOCK-RPI-29), and only when
 * it is not still flagged inconsistent. An arithmetic mismatch the customer
 * did not resolve is left out rather than persisted as fact.
 */
export function buildClosetDrafts(
  candidates: readonly ReviewCandidate[],
  document: ReviewDocument,
  { sessionId, inputTier }: { sessionId: string; inputTier: PurchaseImportInputTier },
): PurchaseClosetDraft[] {
  const drafts: PurchaseClosetDraft[] = [];
  for (const candidate of candidates) {
    if (!candidate.selected || candidate.unitsToAdd < 1) continue;

    const priced =
      candidate.unitPrice.value !== null &&
      candidate.currency.value !== null &&
      !(candidate.flags.priceInconsistent && candidate.unitPrice.provenance !== 'USER_CONFIRMED');

    const fieldProvenance: Partial<Record<PurchaseProvenanceField, PurchaseFieldProvenance>> = {
      title: candidate.title.value ? candidate.title.provenance : 'MODEL_NORMALIZED',
      brand: candidate.brand.provenance,
      category: candidate.category.provenance,
      subtype: candidate.subtype.provenance,
      primaryColor: candidate.primaryColor.provenance,
      material: candidate.material.provenance,
      size: candidate.size.provenance,
      merchant: document.merchant.provenance,
      purchaseDate: document.purchaseDate.provenance,
      returnDeadline: document.returnDeadline.provenance,
      sku: candidate.sku ? 'RECEIPT_EXPLICIT' : 'UNKNOWN',
      gtin: candidate.gtin ? 'RECEIPT_EXPLICIT' : 'UNKNOWN',
      retailerProductRef: candidate.retailerProductRef ? 'RECEIPT_EXPLICIT' : 'UNKNOWN',
    };
    if (priced) {
      fieldProvenance.pricePaid = candidate.unitPrice.provenance;
      fieldProvenance.currency = candidate.currency.provenance;
    }

    const purchase: ClosetPurchaseProvenance = {
      source: 'purchase_import',
      contractVersion: PURCHASE_IMPORT_CONTRACT_VERSION,
      inputTier,
      merchant: document.merchant.value,
      purchaseDate: document.purchaseDate.value,
      pricePaid: priced ? candidate.unitPrice.value : null,
      currency: priced ? candidate.currency.value : null,
      sku: candidate.sku,
      gtin: candidate.gtin,
      retailerProductRef: candidate.retailerProductRef,
      // One document-level deadline, inherited by every confirmed item from
      // this document and recorded as such. Never an item-specific deadline.
      returnDeadline: document.returnDeadline.value,
      returnDeadlineScope: document.returnDeadline.value ? 'document' : null,
      fieldProvenance,
    };

    for (let unitIndex = 0; unitIndex < candidate.unitsToAdd; unitIndex += 1) {
      const sourceLineageId = purchaseLineageId(sessionId, candidate.lineIndex, unitIndex);
      drafts.push({
        sourceLineageId,
        lineIndex: candidate.lineIndex,
        unitIndex,
        draft: {
          origin: 'purchase_import',
          title: fallbackTitle(candidate),
          category: candidate.category.value,
          subtype: candidate.subtype.value,
          brand: candidate.brand.value,
          primaryColor: candidate.primaryColor.value,
          secondaryColors: [...candidate.secondaryColors],
          material: candidate.material.value ? [...candidate.material.value] : [],
          size: candidate.size.value,
          sourceLineageId,
          purchase: { ...purchase, fieldProvenance: { ...fieldProvenance } },
        },
      });
    }
  }
  return drafts;
}

/** The purchase identifiers an owned Closet item may carry. */
export type OwnedPurchaseIdentity = {
  purchase?: { sku?: unknown; gtin?: unknown; merchant?: unknown } | null;
};

function sameText(a: unknown, b: unknown): boolean {
  return (
    typeof a === 'string' &&
    typeof b === 'string' &&
    a.trim().length > 0 &&
    a.trim().toLowerCase() === b.trim().toLowerCase()
  );
}

/**
 * Flag lines whose EXPLICIT identifier matches an item the actor already owns.
 *
 * GTIN is a global identifier, so it matches alone. A SKU is a retailer's own
 * code, so it matches only together with the same merchant. Nothing fuzzy is
 * consulted. A flagged line is deselected and says why, and the customer can
 * select it again: this is a hint, never a suppression.
 */
export function markOwnedDuplicates(
  candidates: readonly ReviewCandidate[],
  merchant: string | null,
  owned: readonly OwnedPurchaseIdentity[],
): ReviewCandidate[] {
  const gtins = new Set<string>();
  const skus = new Set<string>();
  for (const item of owned ?? []) {
    const p = item?.purchase;
    if (!p) continue;
    if (typeof p.gtin === 'string' && p.gtin) gtins.add(p.gtin);
    if (typeof p.sku === 'string' && p.sku && sameText(p.merchant, merchant)) {
      skus.add(p.sku.trim().toLowerCase());
    }
  }
  return candidates.map((candidate) => {
    const duplicate =
      (candidate.gtin !== null && gtins.has(candidate.gtin)) ||
      (candidate.sku !== null && merchant !== null && skus.has(candidate.sku.trim().toLowerCase()));
    if (!duplicate) return candidate;
    return {
      ...candidate,
      selected: false,
      flags: { ...candidate.flags, possibleDuplicate: true },
    };
  });
}

/** Count corrections per coarse group, for telemetry. Values never leave. */
export function countCorrections(
  original: readonly ReviewCandidate[],
  current: readonly ReviewCandidate[],
): Record<CorrectionGroup, number> {
  const counts: Record<CorrectionGroup, number> = {
    naming: 0,
    maker: 0,
    classification: 0,
    appearance: 0,
    fit: 0,
    money: 0,
  };
  const byLine = new Map(original.map((c) => [c.lineIndex, c]));
  for (const candidate of current) {
    const before = byLine.get(candidate.lineIndex);
    if (!before) continue;
    for (const key of Object.keys(CORRECTION_GROUPS) as EditableCandidateField[]) {
      if (candidate[key].provenance === 'USER_CONFIRMED' && before[key].provenance !== 'USER_CONFIRMED') {
        counts[CORRECTION_GROUPS[key]] += 1;
      }
    }
  }
  return counts;
}
