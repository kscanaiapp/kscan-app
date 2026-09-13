/**
 * Client-side commercial usability — the transaction floor (Build 35).
 *
 * DEFENCE IN DEPTH, NOT A SECOND AUTHORITY. The server classifies every offer
 * at the response boundary (`attachCommercialUsability`) and publishes the
 * answer as `commercialUsability`. This module trusts that field when it is
 * present and re-derives it from the same commercial facts when it is not —
 * a response from an older function version, a persisted snapshot, a locally
 * assembled row. The rules are identical on both sides on purpose: a Buy
 * control must not appear because two layers disagreed about who decides.
 *
 * WHAT IT REFUSES TO READ. Rank position, recommendation label, match score,
 * similarity percentage, and any model-authored text. A ranking defect must
 * never be enough to activate a transaction control (§19), so none of those
 * fields is an input here.
 */

import { isSafeCommerceUrl } from '../commerceDestination.ts';

export type CommercialUsability =
  | 'TRANSACTION_READY'
  | 'BROWSE_ONLY'
  | 'UNUSABLE'
  | 'UNKNOWN';

/** The commercial facts this decision may read. Nothing else is accepted. */
export interface UsabilityInput {
  /** Server-authored classification, when the response carried one. */
  commercialUsability?: unknown;
  /** SAME vs SIMILAR — the existing product contract's own distinction. */
  type?: unknown;
  price?: unknown;
  /** Provider-declared availability. Absent means unknown, never "in stock". */
  availability?: unknown;
  /** The destination a purchase would actually open. */
  destinationUrl?: string | null;
}

const VALID: ReadonlySet<string> = new Set([
  'TRANSACTION_READY', 'BROWSE_ONLY', 'UNUSABLE', 'UNKNOWN',
]);

const OUT_OF_STOCK: ReadonlySet<string> = new Set([
  'out_of_stock', 'out of stock', 'outofstock', 'sold_out', 'sold out',
]);

/** A price is real only when it parses to a positive amount. */
function hasRealPrice(price: unknown): boolean {
  if (price === undefined || price === null || price === '') return false;
  if (typeof price === 'number') return Number.isFinite(price) && price > 0;
  if (typeof price !== 'string') return false;
  const cleaned = price.trim().replace(/[^0-9.,-]/g, '').replace(/,/g, '');
  if (!cleaned) return false;
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0;
}

export function resolveCommercialUsability(input: UsabilityInput | null | undefined): CommercialUsability {
  if (!input || typeof input !== 'object') return 'UNUSABLE';

  // The server already decided. An unrecognised value is not trusted — it is
  // re-derived below rather than passed through as if it meant something.
  if (typeof input.commercialUsability === 'string' && VALID.has(input.commercialUsability)) {
    return input.commercialUsability as CommercialUsability;
  }

  if (!isSafeCommerceUrl(input.destinationUrl)) return 'UNUSABLE';

  const availability = typeof input.availability === 'string'
    ? input.availability.trim().toLowerCase()
    : '';
  if (OUT_OF_STOCK.has(availability)) return 'BROWSE_ONLY';

  if (input.type !== 'retail') return 'BROWSE_ONLY';
  if (!hasRealPrice(input.price)) return 'UNKNOWN';
  return 'TRANSACTION_READY';
}

/**
 * May this listing render an ACTIVE Buy/Shop control?
 *
 * Only TRANSACTION_READY. A BROWSE_ONLY listing still opens — looking at a
 * page is not a transaction — but it does not get a control that promises a
 * purchase the offer cannot complete.
 */
export function canActivateTransaction(usability: CommercialUsability): boolean {
  return usability === 'TRANSACTION_READY';
}

/**
 * Availability copy. UNKNOWN never becomes "In stock": the provider did not
 * say, and saying it for them is the fabrication this whole layer exists to
 * prevent. Returns null when there is nothing truthful to show.
 */
export function availabilityLabel(usability: CommercialUsability, availability: unknown): string | null {
  const declared = typeof availability === 'string' ? availability.trim().toLowerCase() : '';
  if (OUT_OF_STOCK.has(declared)) return 'Out of stock';
  if (usability === 'UNUSABLE') return null;
  return null;
}
