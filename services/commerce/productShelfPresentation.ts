/**
 * ProductShelf presentation facts (Build 35 Commerce UX refinement).
 *
 * PRESENTATION ONLY. Every answer here is read off facts the Commerce path
 * already produced -- the server-authored `commercialUsability`, the ranker's
 * `commerceRationale`, the offer's declared currency, the canonical offer
 * identity. Nothing here ranks, re-scores, calls a model, fetches, or infers a
 * fact the offer did not carry. A card that cannot say something truthfully
 * says nothing.
 *
 * It exists so the card and the Compare sheet answer the same five questions
 * (what is it, why is it here, what does it cost, can I buy it, what can I do)
 * from ONE derivation, rather than two components each deciding for itself.
 */

import {
  canActivateTransaction,
  resolveCommercialUsability,
  type CommercialUsability,
} from './commercialUsability.ts';
import { rationaleLines, type CommerceRationaleFacts } from './commerceRationale.ts';
import { collapseDuplicateOffers, productShelfIdentity } from './productIdentity.ts';
import { selectCommerceDestination } from '../commerceDestination.ts';
import {
  formatCommercePrice,
  normalizeCommerceCurrency,
  normalizePersistedCommerceUrl,
} from '../dressingRoomCommerce.ts';

/** The offer fields this module may read. Nothing else is an input. */
export interface ShelfOfferFacts {
  id?: string;
  title?: string;
  displayName?: string;
  name?: string;
  product_name?: string;
  brand?: string;
  category?: string | null;
  price?: string | number | null;
  currency?: string;
  availability?: string | null;
  productUrl?: string | null;
  purchaseUrl?: string | null;
  purchase_url?: string | null;
  product_url?: string | null;
  url?: string | null;
  link?: string | null;
  affiliateUrl?: string | null;
  commercialUsability?: CommercialUsability;
  type?: 'retail' | 'similar';
  commerceType?: 'retail' | 'resale';
  commerceRationale?: unknown;
}

// ── Destination ──────────────────────────────────────────────────────────────

/**
 * The one destination this offer may open. Same selector and the same
 * persisted-URL scrub the shelf has always used; never constructed from a
 * title, brand, or query.
 */
export function shelfDestinationUrl(product: ShelfOfferFacts | null | undefined): string | null {
  if (!product) return null;
  return selectCommerceDestination(
    [
      product.productUrl,
      product.purchaseUrl,
      product.affiliateUrl,
      product.product_url,
      product.purchase_url,
      product.url,
      product.link,
    ].map((candidate) => normalizePersistedCommerceUrl(candidate)),
  );
}

// ── Price truth ──────────────────────────────────────────────────────────────

export interface ShelfPriceView {
  /** Visible price text, or null when the offer carried no real price. */
  text: string | null;
  /** ISO-4217 code the offer declared, or null. Never inferred. */
  currency: string | null;
  /**
   * True when a price is shown whose currency the offer did not declare. The
   * card says so in words: "$120" from a provider string is the retailer's
   * representation, not a fact K Scan can vouch for (a dollar sign is not a
   * currency).
   */
  currencyUnconfirmed: boolean;
  /**
   * A single comparable amount, ONLY when the currency is declared and the
   * price is one unambiguous number. Ranges, free text and undeclared
   * currencies yield null, so nothing downstream can compare them.
   */
  amount: number | null;
  /** What a screen reader announces for the price. */
  accessibilityText: string | null;
}

const SINGLE_AMOUNT_RE = /^[^\d-]{0,4}\s?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?\s?[^\d]{0,4}$/;

function singleAmount(price: unknown): number | null {
  if (typeof price === 'number') return Number.isFinite(price) && price > 0 ? price : null;
  if (typeof price !== 'string') return null;
  const match = SINGLE_AMOUNT_RE.exec(price.trim());
  if (!match) return null;
  const n = Number(`${match[1].replace(/,/g, '')}${match[2] ? `.${match[2]}` : ''}`);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function shelfPriceView(product: ShelfOfferFacts | null | undefined): ShelfPriceView {
  const empty: ShelfPriceView = {
    text: null,
    currency: null,
    currencyUnconfirmed: false,
    amount: null,
    accessibilityText: null,
  };
  if (!product) return empty;
  const text = formatCommercePrice(product.price, product.currency);
  if (!text) return empty;
  const currency = normalizeCommerceCurrency(product.currency);
  const amount = currency ? singleAmount(product.price) : null;
  if (currency) {
    // A bare symbol is shared by several currencies ("$" is USD, CAD, AUD...).
    // When the formatted text carries no letters to disambiguate it, the code
    // is shown alongside: "$120.00 USD". "CA$129.99" already names itself.
    const visible = /[a-z]/i.test(text) ? text : `${text} ${currency}`;
    return {
      text: visible,
      currency,
      currencyUnconfirmed: false,
      amount,
      accessibilityText: visible.includes(currency) ? `Price ${visible}` : `Price ${visible} ${currency}`,
    };
  }
  return {
    text,
    currency: null,
    currencyUnconfirmed: true,
    amount: null,
    accessibilityText: `Listed price ${text}, currency not confirmed`,
  };
}

/**
 * The price text a Watch is created with.
 *
 * The Watchlist server reads the currency OUT OF THIS STRING (it has no
 * separate currency field) and refuses a Watch it cannot denominate. An offer
 * that declared its currency as a field but carried a bare amount ("129.99",
 * currency "USD") used to be sent as "129.99" and refused, so a watchable,
 * correctly-priced listing could not be watched. Appending the offer's OWN
 * declared code ("129.99 USD") is the server's documented readable form; a
 * string that already names the code is sent untouched. With no declared
 * currency nothing is added -- the server decides, and a guess is never sent.
 */
export function watchListingPrice(product: ShelfOfferFacts | null | undefined): string | undefined {
  if (!product || product.price === null || product.price === undefined) return undefined;
  const raw = String(product.price).trim();
  if (!raw) return undefined;
  const currency = normalizeCommerceCurrency(product.currency);
  if (!currency) return raw;
  return new RegExp(`(^|[^A-Z])${currency}([^A-Z]|$)`).test(raw.toUpperCase()) ? raw : `${raw} ${currency}`;
}

/**
 * "$30.00 less" / "$12.00 more" -- or null.
 *
 * Only when both offers declare the SAME currency and each carries one
 * unambiguous amount. No conversion, no cross-currency arithmetic, and no
 * judgement: cheaper is a fact, not a recommendation.
 */
export function relativePriceText(
  subject: ShelfOfferFacts | null | undefined,
  reference: ShelfOfferFacts | null | undefined,
): string | null {
  const a = shelfPriceView(subject);
  const b = shelfPriceView(reference);
  if (a.amount === null || b.amount === null || !a.currency || a.currency !== b.currency) return null;
  const delta = Math.round((a.amount - b.amount) * 100) / 100;
  if (delta === 0) return 'Same price';
  const symbolic = formatCommercePrice(Math.abs(delta), a.currency);
  if (!symbolic) return null;
  const formatted = /[a-z]/i.test(symbolic) ? symbolic : `${symbolic} ${a.currency}`;
  return delta < 0 ? `${formatted} less` : `${formatted} more`;
}

// ── Buyability ───────────────────────────────────────────────────────────────

/**
 * What the card's primary commercial control may be.
 *
 *  - `shop`         TRANSACTION_READY and a verified destination: SHOP.
 *  - `view`         a verified destination that is not transaction-ready
 *                   (similar item, unknown price): VIEW AT RETAILER, never SHOP.
 *  - `out_of_stock` the provider declared it unavailable; the page still opens.
 *  - `no_link`      no verified purchase path at all: no control, and the card
 *                   says so instead of looking identical to a buyable one.
 */
export type ShelfBuyability = 'shop' | 'view' | 'out_of_stock' | 'no_link';

const OUT_OF_STOCK = new Set(['out_of_stock', 'out of stock', 'outofstock', 'sold_out', 'sold out']);

export function shelfUsability(product: ShelfOfferFacts | null | undefined): CommercialUsability {
  return resolveCommercialUsability({
    commercialUsability: product?.commercialUsability,
    type: product?.type,
    price: product?.price,
    availability: product?.availability,
    destinationUrl: product ? shelfDestinationUrl(product) : null,
  });
}

export function shelfBuyability(product: ShelfOfferFacts | null | undefined): ShelfBuyability {
  if (!product || !shelfDestinationUrl(product)) return 'no_link';
  const declared = typeof product.availability === 'string' ? product.availability.trim().toLowerCase() : '';
  if (OUT_OF_STOCK.has(declared)) return 'out_of_stock';
  return canActivateTransaction(shelfUsability(product)) ? 'shop' : 'view';
}

export const BUYABILITY_COPY: Readonly<Record<ShelfBuyability, { action: string | null; status: string | null }>> = {
  shop: { action: 'SHOP', status: null },
  view: { action: 'VIEW AT RETAILER', status: null },
  out_of_stock: { action: 'VIEW AT RETAILER', status: 'Out of stock' },
  no_link: { action: null, status: 'Purchase link unavailable' },
};

/** Did ANY offer on this shelf earn an active Shop control? */
export function shelfHasBuyableOffer(products: readonly ShelfOfferFacts[] | null | undefined): boolean {
  return (products ?? []).some((product) => shelfBuyability(product) === 'shop');
}

// ── Why this ─────────────────────────────────────────────────────────────────

function rationaleFacts(product: ShelfOfferFacts | null | undefined): CommerceRationaleFacts | null {
  const raw = product?.commerceRationale;
  if (!raw || typeof raw !== 'object') return null;
  const facts = raw as Partial<CommerceRationaleFacts>;
  if (!Array.isArray(facts.factCodes)) return null;
  return facts as CommerceRationaleFacts;
}

/**
 * The card's reason lines: the ranker's own facts through the existing copy
 * table, capped for a narrow card. A product with no rationale shows no reason
 * -- absent evidence is never captioned as a match.
 */
export function shelfReasonLines(product: ShelfOfferFacts | null | undefined, max = 2): string[] {
  return rationaleLines(rationaleFacts(product)).slice(0, Math.max(0, max));
}

/** Attributes the ranker recorded as matching the request (e.g. "black"). */
export function shelfMatchedAttributes(product: ShelfOfferFacts | null | undefined): string[] {
  const facts = rationaleFacts(product);
  if (!facts || !Array.isArray(facts.matchedAttributes)) return [];
  return facts.matchedAttributes.filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

// ── Identity ─────────────────────────────────────────────────────────────────

/**
 * Collapse exact duplicate offers using the EXISTING canonical offer identity
 * (`collapseDuplicateOffers`). No title/price/image heuristics: an offer
 * without a canonical identity is kept as its own candidate.
 */
export function presentableShelf<T extends ShelfOfferFacts>(products: readonly T[] | null | undefined): T[] {
  return collapseDuplicateOffers(Array.isArray(products) ? products : []);
}

/**
 * A stable per-card key. Every action a card renders is bound to the product
 * object at this key; the key only has to be unique and stable within one
 * shelf so selection and action state cannot slide to a neighbour.
 */
export function shelfCardKey(product: ShelfOfferFacts, index: number): string {
  return productShelfIdentity(product) ?? (typeof product.id === 'string' && product.id ? `id:${product.id}:${index}` : `i:${index}`);
}

// ── Compare ──────────────────────────────────────────────────────────────────

export const COMPARE_MAX = 3;
export const COMPARE_MIN = 2;

/** Toggle one key in a bounded selection. Order of selection is preserved. */
export function toggleCompareSelection(selection: readonly string[], key: string): string[] {
  if (selection.includes(key)) return selection.filter((k) => k !== key);
  if (selection.length >= COMPARE_MAX) return [...selection];
  return [...selection, key];
}

export interface CompareRow {
  label: string;
  /** One cell per compared offer, in selection order. null = not known. */
  values: (string | null)[];
}

const NOT_LISTED = null;

function titleOf(product: ShelfOfferFacts): string | null {
  const t = String(product.displayName || product.name || product.title || product.product_name || '').trim();
  return t || null;
}

/**
 * The comparison table. Only facts the offers actually carry; a cell with no
 * source data is null and renders as "Not listed" -- never estimated, never
 * filled from the title. Rows where NO offer carries the fact are omitted.
 */
export function buildCompareRows(
  products: readonly ShelfOfferFacts[],
  retailerOf: (product: ShelfOfferFacts) => string | null,
): CompareRow[] {
  // Relative price against the FIRST selected offer, same declared currency
  // only. The first column is the reference itself, labelled as such only when
  // at least one other column produced a real comparison.
  const deltas = products.map((p, i) => (i === 0 ? null : relativePriceText(p, products[0])));
  const anyDelta = deltas.some((value) => value !== null);
  const priceDifference = (index: number): string | null => {
    if (!anyDelta) return null;
    return index === 0 ? 'Reference' : deltas[index];
  };
  const rows: CompareRow[] = [
    { label: 'Item', values: products.map((p) => titleOf(p)) },
    {
      label: 'Price',
      values: products.map((p) => {
        const view = shelfPriceView(p);
        if (!view.text) return NOT_LISTED;
        return view.currencyUnconfirmed ? `${view.text} (currency not confirmed)` : view.text;
      }),
    },
    { label: 'Price vs option 1', values: products.map((_, i) => priceDifference(i)) },
    { label: 'Retailer', values: products.map((p) => retailerOf(p)) },
    { label: 'Brand', values: products.map((p) => (typeof p.brand === 'string' && p.brand.trim() ? p.brand.trim() : NOT_LISTED)) },
    { label: 'Category', values: products.map((p) => (typeof p.category === 'string' && p.category.trim() ? p.category.trim() : NOT_LISTED)) },
    {
      label: 'Listing',
      values: products.map((p) =>
        p.commerceType === 'resale' ? 'Resale' : p.commerceType === 'retail' ? 'Retail' : NOT_LISTED,
      ),
    },
    {
      label: 'Matches your request',
      values: products.map((p) => {
        const matched = shelfMatchedAttributes(p);
        return matched.length ? matched.join(' · ') : NOT_LISTED;
      }),
    },
    {
      label: 'Why it’s here',
      values: products.map((p) => {
        const lines = shelfReasonLines(p, 3);
        return lines.length ? lines.join('. ') : NOT_LISTED;
      }),
    },
    {
      label: 'Purchase',
      values: products.map((p) => {
        const state = shelfBuyability(p);
        if (state === 'shop') return 'Ready to shop';
        if (state === 'view') return 'View at retailer';
        return BUYABILITY_COPY[state].status;
      }),
    },
  ];
  return rows.filter((row) => row.label === 'Item' || row.values.some((value) => value !== null));
}
