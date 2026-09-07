/**
 * Commerce V2 "Where to Buy" summary (Build 35 §54-56).
 *
 * Does NOT require cross-retailer product grouping (§54) -- it is a neutral
 * count of retailers actually present among the offers already shown for
 * one item, built without any new ranking policy.
 */

import { resolveRetailerIdentity, type RetailerIdentityInput } from './retailerIdentity.ts';

export interface WhereToBuyRow {
  /** Registry key, or null when the retailer is not in the committed registry. */
  retailerKey: string | null;
  displayName: string;
  offerCount: number;
  /** True only when every offer under this retailer is resale. */
  allResale: boolean;
}

/**
 * Builds the retailer summary rows for one item's offers.
 *
 * Order (§55): first appearance in the given offer list, which is already
 * the existing ranked order -- never re-sorted by commission, logo
 * presence, price, or alphabetically. Offers with no resolvable retailer
 * (unknown) are counted separately under a null-keyed row rather than
 * silently dropped or merged into a real retailer's count.
 */
export function buildWhereToBuySummary(
  offers: readonly RetailerIdentityInput[],
  /**
   * Which identity resolver to use. Defaults to the live/approved one. A
   * surface that renders PERSISTED snapshots passes
   * `resolvePersistedRetailerIdentity` so the summary and the rows above it
   * cannot disagree about the same offer (closure §6).
   */
  resolve: (offer: RetailerIdentityInput) => ReturnType<typeof resolveRetailerIdentity> = resolveRetailerIdentity,
): WhereToBuyRow[] {
  const rows: WhereToBuyRow[] = [];
  const indexByKey = new Map<string, number>();

  for (const offer of offers ?? []) {
    const identity = resolve(offer);
    // Group by registry key when known; otherwise by the exact declared
    // display name (still real, just unregistered) so two different
    // unregistered retailers are never merged together. A fully unknown
    // retailer (no name at all) groups under a single "unknown" bucket.
    const groupKey = identity.retailerKey ?? (identity.displayName ? `declared:${identity.displayName}` : 'unknown');
    const displayName = identity.displayName ?? 'Unknown retailer';
    const isResale = identity.commerceType === 'resale';

    const existingIndex = indexByKey.get(groupKey);
    if (existingIndex === undefined) {
      indexByKey.set(groupKey, rows.length);
      rows.push({
        retailerKey: identity.retailerKey,
        displayName,
        offerCount: 1,
        allResale: isResale,
      });
    } else {
      const row = rows[existingIndex];
      row.offerCount += 1;
      row.allResale = row.allResale && isResale;
    }
  }

  return rows;
}

/** "1 offer" / "1 resale offer" / "3 offers" -- never "Best deal" (§53). */
export function whereToBuyRowLabel(row: WhereToBuyRow): string {
  const noun = row.allResale ? 'resale offer' : 'offer';
  return row.offerCount === 1 ? `1 ${noun}` : `${row.offerCount} ${noun}s`;
}
