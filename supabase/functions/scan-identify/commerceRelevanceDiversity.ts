/**
 * Soft retailer / product diversity (v122).
 * Relevance remains primary. Deterministic two-pass reranking — never randomize.
 */

import {
  MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY,
  MIN_DIVERSITY_AGREEMENT_SCORE,
  MIN_RELEVANCE_RESULTS_FOR_COVERAGE,
  PRICE_BAND_COUNT,
} from './commerceRelevanceConfig.ts';
import {
  AGREEMENT_USABLE_THRESHOLD,
  type AgreementBand,
  parseNumericPrice,
} from './commerceRelevanceAgreement.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

export type ScoredProduct = {
  product: RecommendedProduct;
  agreementScore: number;
  agreementBand: AgreementBand;
  clearCategoryConflict: boolean;
  /** Stable original index for equal-score tie-break. */
  originalIndex: number;
};

function retailerKey(p: RecommendedProduct): string {
  const src = typeof p.source === 'string' ? p.source.trim().toLowerCase() : '';
  return src || 'unknown';
}

function priceBandIndex(
  price: number | null,
  sortedValidPrices: number[],
): number | null {
  if (price == null || !Number.isFinite(price) || sortedValidPrices.length < PRICE_BAND_COUNT) {
    return null;
  }
  const n = sortedValidPrices.length;
  // Approximate tertiles from sorted unique-ish prices
  const lowerCut = sortedValidPrices[Math.floor((n - 1) / 3)]!;
  const upperCut = sortedValidPrices[Math.floor((2 * (n - 1)) / 3)]!;
  if (price <= lowerCut) return 0;
  if (price >= upperCut) return 2;
  return 1;
}

/**
 * Deterministic diversity-aware ordering.
 * Never discards held products solely due to soft retailer cap.
 * Never promotes products below MIN_DIVERSITY_AGREEMENT_SCORE for diversity.
 */
export function applySoftDiversityRerank(scored: ScoredProduct[]): RecommendedProduct[] {
  if (scored.length <= 1) return scored.map((s) => s.product);

  // 1. Sort by agreement desc, then original index asc (stable)
  const sorted = [...scored].sort((a, b) => {
    if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
    return a.originalIndex - b.originalIndex;
  });

  // Tertiary price-band signal among near-equal scores (±3)
  const validPrices = sorted
    .map((s) => parseNumericPrice(s.product.price))
    .filter((p) => p.kind === 'valid' && p.value != null)
    .map((p) => p.value as number)
    .sort((a, b) => a - b);

  const withBand = sorted.map((s) => {
    const parsed = parseNumericPrice(s.product.price);
    const band = parsed.kind === 'valid'
      ? priceBandIndex(parsed.value, validPrices)
      : null;
    return { ...s, priceBand: band };
  });

  // Light re-sort: among scores within 3 points, prefer underrepresented price band
  // without overriding material relevance gaps.
  withBand.sort((a, b) => {
    if (Math.abs(b.agreementScore - a.agreementScore) > 3) {
      return b.agreementScore - a.agreementScore;
    }
    if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
    // Prefer filling different bands when both have bands
    if (a.priceBand != null && b.priceBand != null && a.priceBand !== b.priceBand) {
      return a.priceBand - b.priceBand;
    }
    return a.originalIndex - b.originalIndex;
  });

  const selected: ScoredProduct[] = [];
  const held: ScoredProduct[] = [];
  const retailerCounts = new Map<string, number>();

  const retailerSet = new Set(withBand.map((s) => retailerKey(s.product)));
  const singleRetailer = retailerSet.size <= 1;

  for (const item of withBand) {
    const key = retailerKey(item.product);
    const count = retailerCounts.get(key) || 0;

    if (singleRetailer || count < MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY) {
      selected.push(item);
      retailerCounts.set(key, count + 1);
      continue;
    }

    // Over soft cap — hold for later
    held.push(item);
  }

  // Promote usable alternative-retailer products from held when beneficial
  if (!singleRetailer && held.length > 0) {
    const promoted: ScoredProduct[] = [];
    const stillHeld: ScoredProduct[] = [];

    for (const item of held) {
      const key = retailerKey(item.product);
      const eligible = item.agreementScore >= MIN_DIVERSITY_AGREEMENT_SCORE &&
        item.agreementScore >= AGREEMENT_USABLE_THRESHOLD;
      const count = retailerCounts.get(key) || 0;
      // Only promote if this adds a retailer that is underrepresented vs dominating ones
      const maxSelectedRetailer = Math.max(0, ...retailerCounts.values());
      if (eligible && count < maxSelectedRetailer && count < MAX_RESULTS_PER_RETAILER_BEFORE_DIVERSITY) {
        // Insert after last selected product with higher or equal score — keep relevance order
        promoted.push(item);
        retailerCounts.set(key, count + 1);
      } else {
        stillHeld.push(item);
      }
    }

    // Merge promoted back in agreement order
    const merged = [...selected, ...promoted].sort((a, b) => {
      if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
      return a.originalIndex - b.originalIndex;
    });

    // Restore held for coverage / completeness — never discard
    const usableStrong = merged.filter((s) =>
      s.agreementBand === 'strong' || s.agreementBand === 'usable'
    );
    const needCoverage = usableStrong.length < MIN_RELEVANCE_RESULTS_FOR_COVERAGE;

    if (needCoverage || stillHeld.length > 0) {
      const restored = [...stillHeld].sort((a, b) => {
        if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
        return a.originalIndex - b.originalIndex;
      });
      return [...merged, ...restored].map((s) => s.product);
    }

    return merged.map((s) => s.product);
  }

  // Single-retailer safeguard or no held: append held in score order
  if (held.length > 0) {
    const restored = [...held].sort((a, b) => {
      if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
      return a.originalIndex - b.originalIndex;
    });
    return [...selected, ...restored].map((s) => s.product);
  }

  return selected.map((s) => s.product);
}

/**
 * Coverage-aware selection after scoring:
 * - suppress clear category conflicts
 * - keep strong/usable first
 * - retain highest-scoring weak products when coverage < MIN
 * - never retain clear category conflicts just to fill the shelf
 */
export function selectByAgreementCoverage(scored: ScoredProduct[]): ScoredProduct[] {
  const valid = scored.filter((s) => !s.clearCategoryConflict);
  const strongUsable = valid.filter((s) =>
    s.agreementBand === 'strong' || s.agreementBand === 'usable'
  );
  const weak = valid.filter((s) => s.agreementBand === 'weak')
    .sort((a, b) => {
      if (b.agreementScore !== a.agreementScore) return b.agreementScore - a.agreementScore;
      return a.originalIndex - b.originalIndex;
    });

  if (strongUsable.length >= MIN_RELEVANCE_RESULTS_FOR_COVERAGE) {
    // Still keep weak below for completeness after diversity — caller may slice
    return [...strongUsable, ...weak];
  }

  const needed = MIN_RELEVANCE_RESULTS_FOR_COVERAGE - strongUsable.length;
  // v122 repair: this previously read `Math.max(needed, weak.length)`, which is
  // always >= weak.length by construction and therefore never truncated —
  // every weak product was retained regardless of `needed`. Cap to `needed`.
  return [...strongUsable, ...weak.slice(0, Math.max(needed, 0))];
}
