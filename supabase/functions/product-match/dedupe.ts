/**
 * Product Match Foundation V1 — conservative cross-source deduplication.
 *
 * CONSERVATIVE MEANS: when two rows might be the same thing, they are only
 * merged on evidence that cannot be coincidental. Everything else stays
 * separate. The failure mode of aggressive dedupe is invisible — a real second
 * retailer silently disappears and nobody can tell from the output that it
 * existed. The failure mode of conservative dedupe is visible and recoverable:
 * a duplicate appears and can be merged later. Only one of those is safe to
 * ship without a labelled dataset, and this phase does not have one.
 *
 * THE THREE MERGE RULES, strongest first:
 *
 *   1. Same canonical product URL          → the same listing. Exact.
 *   2. Same exact product identifier       → the same variant. Exact.
 *   3. Same family key AND same colourway  → the same variant. Derived, and
 *                                            only from normalized text both
 *                                            rows independently carried.
 *
 * Rule 3 is the only inferential one, and it is bounded: it never merges across
 * different families, and it never merges when either side's colourway is
 * unknown. Two grey coats from different brands do not merge; two rows of the
 * same brand+model with unknown colour do not merge either, because "unknown"
 * is not agreement.
 *
 * WHAT IS NEVER USED AS A MERGE SIGNAL:
 *   - image URL similarity (different CDNs serve the same product image, and
 *     the same CDN path serves different products over time)
 *   - price (varies by retailer, by definition)
 *   - title string distance (retailer titles are marketing copy; edit distance
 *     between two different colourways is smaller than between two spellings
 *     of the same one)
 */

import type { ProductListing, ProductSource } from './contracts.ts';
import { sourceCanCarryExactId } from './contracts.ts';
import type { NormalizedRow } from './normalize.ts';

/**
 * Source preference when the same listing arrives from several places.
 *
 * First-party retailer surfaces outrank generic web search because their title,
 * price and identifier come from the retailer's own catalogue. `catalog` is
 * last among real sources: it is our own curated table, useful for coverage but
 * not authoritative about live price or availability.
 */
const SOURCE_RANK: Record<ProductSource, number> = {
  farfetch: 0,
  kickscrew: 1,
  serper: 2,
  brave: 3,
  catalog: 4,
};

export type DedupeStats = {
  rowsIn: number;
  listingsOut: number;
  variantsOut: number;
  familiesOut: number;
  /** Listings collapsed by rule 1 (identical canonical URL). */
  listingsMergedByUrl: number;
  /** Variants collapsed by rule 2 (identical exact product id). */
  variantsMergedByExactId: number;
  /** Variants collapsed by rule 3 (family + colourway agreement). */
  variantsMergedByColorway: number;
  /** Variants that more than one distinct source produced independently. */
  variantsWithCrossSourceAgreement: number;
};

export type DedupedVariant = {
  variantKey: string;
  familyKey: string;
  colorway: string | null;
  exactProductId: string | null;
  sizeHint: string | null;
  listings: ProductListing[];
  /** Distinct sources that produced this variant. Drives cross-source evidence. */
  sources: ProductSource[];
  /**
   * Distinct id-capable sources that independently supplied `exactProductId`.
   *
   * Tracked separately from `sources` because corroboration of an identifier is
   * a stronger and narrower claim than "two sources returned this variant": a
   * Serper card agreeing with a Farfetch page tells you the product exists at
   * two places, not that two catalogues agree on its identity. Two entries here
   * is the sole route to the EXACT tier.
   */
  exactIdSources: ProductSource[];
};

export type DedupedFamily = {
  familyKey: string;
  brand: string | null;
  model: string | null;
  canonicalCategory: string | null;
  displayName: string;
};

export type DedupeResult = {
  variants: DedupedVariant[];
  families: Map<string, DedupedFamily>;
  stats: DedupeStats;
};

function betterListing(a: ProductListing, b: ProductListing): ProductListing {
  const rankDelta = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
  if (rankDelta !== 0) return rankDelta < 0 ? a : b;
  // Same source rank: prefer the row carrying more usable detail. A listing
  // with a price and an image is strictly more renderable than one without.
  const score = (l: ProductListing) =>
    (l.productUrl ? 4 : 0) + (l.imageUrl ? 2 : 0) + (l.price ? 1 : 0);
  return score(b) > score(a) ? b : a;
}

/**
 * Collapses normalized rows into variants and families.
 *
 * Pure: same input order-insensitively yields the same output, because every
 * grouping key is content-derived and the final ordering is total.
 */
export function dedupeRows(rows: NormalizedRow[]): DedupeResult {
  const stats: DedupeStats = {
    rowsIn: rows.length,
    listingsOut: 0,
    variantsOut: 0,
    familiesOut: 0,
    listingsMergedByUrl: 0,
    variantsMergedByExactId: 0,
    variantsMergedByColorway: 0,
    variantsWithCrossSourceAgreement: 0,
  };

  const families = new Map<string, DedupedFamily>();

  // ── Rule 1: collapse listings that share a canonical URL ──────────────────
  const byListingKey = new Map<string, { listing: ProductListing; row: NormalizedRow }>();
  for (const row of rows) {
    if (!row) continue;
    if (!families.has(row.family.familyKey)) {
      families.set(row.family.familyKey, {
        familyKey: row.family.familyKey,
        brand: row.family.brand,
        model: row.family.model,
        canonicalCategory: row.family.canonicalCategory,
        displayName: row.family.displayName,
      });
    }
    const existing = byListingKey.get(row.listing.listingKey);
    if (!existing) {
      byListingKey.set(row.listing.listingKey, { listing: row.listing, row });
      continue;
    }
    stats.listingsMergedByUrl += 1;
    const winner = betterListing(existing.listing, row.listing);
    byListingKey.set(row.listing.listingKey, {
      listing: winner,
      row: winner === existing.listing ? existing.row : row,
    });
  }

  // ── Rule 2 / 3: group listings into variants ──────────────────────────────
  // `exactId` is checked first and independently of colourway, so a SKU match
  // wins even when two retailers spell the colour differently.
  const variantByKey = new Map<string, DedupedVariant>();
  const keyByExactId = new Map<string, string>();
  const keyByFamilyColor = new Map<string, string>();

  for (const { listing, row } of byListingKey.values()) {
    const exactId = row.variant.exactProductId;
    const colorway = row.variant.colorway;

    let targetKey: string | null = null;

    if (exactId) {
      const exactBucket = `${row.family.familyKey}#${exactId.toLowerCase()}`;
      const found = keyByExactId.get(exactBucket);
      if (found) {
        targetKey = found;
        stats.variantsMergedByExactId += 1;
      }
    }

    if (targetKey === null && colorway) {
      const colorBucket = `${row.family.familyKey}#${colorway}`;
      const found = keyByFamilyColor.get(colorBucket);
      if (found) {
        targetKey = found;
        stats.variantsMergedByColorway += 1;
      }
    }

    if (targetKey === null) {
      targetKey = row.variant.variantKey;
      if (!variantByKey.has(targetKey)) {
        variantByKey.set(targetKey, {
          variantKey: targetKey,
          familyKey: row.family.familyKey,
          colorway,
          exactProductId: exactId,
          sizeHint: row.variant.sizeHint,
          listings: [],
          sources: [],
          exactIdSources: [],
        });
      }
    }

    if (exactId) keyByExactId.set(`${row.family.familyKey}#${exactId.toLowerCase()}`, targetKey);
    if (colorway) keyByFamilyColor.set(`${row.family.familyKey}#${colorway}`, targetKey);

    const variant = variantByKey.get(targetKey);
    if (!variant) continue;

    // A variant that started without an exact id adopts one when a capable
    // source later supplies it. This only ever sharpens identity.
    if (!variant.exactProductId && exactId) variant.exactProductId = exactId;
    if (!variant.colorway && colorway) variant.colorway = colorway;

    variant.listings.push({ ...listing, variantKey: targetKey });
    if (!variant.sources.includes(listing.source)) variant.sources.push(listing.source);
    if (
      exactId &&
      sourceCanCarryExactId(listing.source) &&
      !variant.exactIdSources.includes(listing.source)
    ) {
      variant.exactIdSources.push(listing.source);
    }
  }

  const variants = [...variantByKey.values()];
  for (const variant of variants) {
    variant.listings.sort((a, b) => {
      const rank = SOURCE_RANK[a.source] - SOURCE_RANK[b.source];
      if (rank !== 0) return rank;
      return a.listingKey.localeCompare(b.listingKey);
    });
    variant.sources.sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b]);
    variant.exactIdSources.sort((a, b) => SOURCE_RANK[a] - SOURCE_RANK[b]);
    if (variant.sources.length > 1) stats.variantsWithCrossSourceAgreement += 1;
    stats.listingsOut += variant.listings.length;
  }

  variants.sort((a, b) => a.variantKey.localeCompare(b.variantKey));

  stats.variantsOut = variants.length;
  // Only families that survived with at least one listing are counted.
  const liveFamilyKeys = new Set(variants.map((v) => v.familyKey));
  for (const key of [...families.keys()]) {
    if (!liveFamilyKeys.has(key)) families.delete(key);
  }
  stats.familiesOut = families.size;

  return { variants, families, stats };
}
