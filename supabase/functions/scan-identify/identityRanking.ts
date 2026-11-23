/**
 * Scanner Identity-Aware Ranking v1 (Build 42 Sprint 2, B42-SCAN-02).
 *
 * Problem (docs/build42/scanner-accuracy/04-defect-ledger.md, B42-SCAN-02):
 *   the v122 agreement score rewards attribute-shaped titles. A genuine listing
 *   titled "adidas Stan Smith" scores 0 (weak) while "White Leather Low-Top
 *   Sneakers" scores 80 (strong) and "Nike Court Legacy White Leather Sneakers"
 *   scores 70, so the real product loses to look-alikes. A different brand named
 *   only in the title is never penalised, and below-usable offers pad the shelf
 *   to three.
 *
 * What this module does (only when SCANNER_IDENTITY_RANKING_V1_ENABLED is on):
 *   assigns each scored offer one tier from evidence the pipeline already has,
 *   adjusts its agreement score to that tier, removes unsupported offers, and
 *   finally orders the shelf by tier (stable within a tier):
 *
 *     identity     — listing brand agrees with the Scanner-observed brand AND the
 *                    listing names the full hypothesised model AND the category
 *                    is compatible or simply not stated. "Likely the same
 *                    product" — never "verified": the model is a vision-model
 *                    hypothesis corroborated by the listing, not an independent
 *                    identification. `verified_exact` stays unreachable here.
 *     brand        — listing brand agrees and the category is compatible; the
 *                    model is unconfirmed (other model, variant, or no hypothesis).
 *     alternative  — no brand contradiction, attribute agreement at or above the
 *                    existing usable threshold.
 *     contradicted — names a different brand (declared or in the title); kept as
 *                    a visually similar alternative only if still usable after
 *                    the contradiction penalty, and ranked after brand-neutral
 *                    alternatives.
 *     unsupported  — invalid destination, category conflict, accessory/part,
 *                    replica/"inspired"/"compatible with", or below-usable.
 *                    Removed: the shelf is not padded to three with them.
 *
 * Evidence boundaries:
 *   - The scanned brand is `resolveScannerBrandEvidence(...).verified` only
 *     (wordmark, or high-confidence logo). `brand_guess` alone is a hypothesis
 *     and never earns brand agreement or asserts a contradiction.
 *   - The model hypothesis (`exact_item_hypothesis` / v124 commerce identity)
 *     only counts when the listing ALSO agrees on the observed brand, and a
 *     low-confidence hypothesis is ignored (`modelHypothesisAgreement`).
 *   - Retailer neutrality: source / retailer / destination host never decide a tier.
 *   - Non-fashion or unrecognised scanned categories are left exactly as v122.
 */
import { AGREEMENT_STRONG_THRESHOLD, AGREEMENT_USABLE_THRESHOLD, agreementBandFromScore, clampAgreementScore } from './commerceRelevanceAgreement.ts';
import { identityRankingCategory } from './identityRankingCategory.ts';
import type { ScoredProduct } from './commerceRelevanceDiversity.ts';
import { ANCILLARY_LISTING_CUE, collectOfferEvidence } from './matchConfidence.ts';
import type { CommerceIdentityEvidence } from './scannerQualityGate.ts';
import { isIdentityRankingEnabled } from './identityRankingConfig.ts';

export type IdentityRankingTier = 'identity' | 'brand' | 'alternative' | 'contradicted' | 'unsupported';

/** Lower rank sorts first. */
export const IDENTITY_TIER_RANK: Readonly<Record<IdentityRankingTier, number>> = Object.freeze({
  identity: 0,
  brand: 1,
  alternative: 2,
  contradicted: 3,
  unsupported: 4,
});

/** Score floor for a corroborated identity listing (strong band). */
export const IDENTITY_TIER_MIN_SCORE = 90;
/** Score floor for a same-brand, same-category listing (usable band). */
export const BRAND_TIER_MIN_SCORE = 60;
/** Penalty for a listing that names a different brand than the one observed. */
export const BRAND_CONTRADICTION_PENALTY = 20;

/**
 * "Rolex Submariner with box and papers" or "Aviator Sunglasses + case" sell the
 * product with an included extra. Only the clause after the connector is removed
 * before the accessory cue is re-checked, so "replacement band" still reads as a part.
 */
const INCLUDED_EXTRA_CLAUSE =
  /\b(with|w|includes?|including|plus|and)\s+(original\s+|its\s+|the\s+|a\s+|protective\s+|carrying\s+)*(box|boxes|case|cases|pouch|papers|dust bag|dustbag)\b/g;

const keyOf = (value: unknown): string =>
  typeof value === 'string'
    ? value.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9+]+/g, ' ').replace(/\+/g, ' plus ').trim()
    : '';

function sellsPartOrAccessory(product: Record<string, unknown>): boolean {
  const text = keyOf([product.title, product.name, product.category, product.item_type].filter((v) => typeof v === 'string').join(' '));
  return ANCILLARY_LISTING_CUE.test(text.replace(INCLUDED_EXTRA_CLAUSE, ' '));
}

function scannedCategory(garment: Record<string, unknown>): string {
  return identityRankingCategory(String(garment.item_type ?? ''));
}

export type IdentityTierDecision = { tier: IdentityRankingTier; score: number };

/**
 * Tier and adjusted agreement score for one offer. `baseScore` is the v122/v124
 * agreement score the pipeline already computed for this offer.
 */
export function decideIdentityTier(
  product: Record<string, unknown>,
  garment: Record<string, unknown>,
  commerceIdentity: CommerceIdentityEvidence | null | undefined,
  baseScore: number,
): IdentityTierDecision {
  const e = collectOfferEvidence(product, { identification: garment, commerceIdentity: commerceIdentity ?? null, identityRanking: true });
  const unsupported = { tier: 'unsupported' as const, score: baseScore };
  if (e.destination === 'invalid' || e.clearCategoryConflict || e.nonIdentityListing) return unsupported;
  if (e.category === 'ancillary' && sellsPartOrAccessory(product)) return unsupported;
  // The listing names the product AND states an included extra: judge the product.
  const category = e.category === 'ancillary' ? 'compatible' : e.category;

  if (e.brand === 'agrees' && e.model === 'agrees' && (category === 'compatible' || category === 'absent')) {
    return { tier: 'identity', score: clampAgreementScore(Math.max(baseScore, IDENTITY_TIER_MIN_SCORE)) };
  }
  if (e.brand === 'agrees' && category === 'compatible') {
    // A same-brand listing never outranks a corroborated identity listing.
    return { tier: 'brand', score: clampAgreementScore(Math.min(Math.max(baseScore, BRAND_TIER_MIN_SCORE), AGREEMENT_STRONG_THRESHOLD + 10)) };
  }
  if (e.brand === 'contradicts') {
    const score = clampAgreementScore(baseScore - BRAND_CONTRADICTION_PENALTY);
    return score >= AGREEMENT_USABLE_THRESHOLD ? { tier: 'contradicted', score } : { tier: 'unsupported', score };
  }
  if (baseScore >= AGREEMENT_USABLE_THRESHOLD) return { tier: 'alternative', score: baseScore };
  // States the scanned category and every subtype word but the v122 vocabulary
  // could not score it ("Black Clogs"): an alternative at the usable floor.
  if (e.attributeSupported === true) return { tier: 'alternative', score: AGREEMENT_USABLE_THRESHOLD };
  return unsupported;
}

/**
 * Re-score the v122 scored list for identity ranking and drop unsupported offers.
 * Disabled, or a non-fashion/unrecognised scanned category → returns `scored`
 * itself (same array reference), so the v122 path is untouched.
 */
export function rescoreForIdentityRanking(
  scored: ScoredProduct[],
  garment: Record<string, unknown>,
  commerceIdentity: CommerceIdentityEvidence | null | undefined,
  onRemoved?: (reason: string) => void,
  enabled: boolean = isIdentityRankingEnabled(),
): ScoredProduct[] {
  if (!enabled || !scannedCategory(garment)) return scored;
  const out: ScoredProduct[] = [];
  for (const s of scored) {
    const decision = decideIdentityTier(s.product as unknown as Record<string, unknown>, garment, commerceIdentity, s.agreementScore);
    if (decision.tier === 'unsupported') {
      onRemoved?.('identity_ranking_unsupported');
      continue;
    }
    out.push({ ...s, agreementScore: decision.score, agreementBand: agreementBandFromScore(decision.score) });
  }
  return out;
}

/**
 * Final stable ordering by tier. Within a tier the incoming order (score,
 * retailer diversity, same-brand preference) is preserved exactly.
 * Disabled, or a non-fashion/unrecognised scanned category → returns `products` itself.
 */
export function orderByIdentityTier<T>(
  products: T[],
  garment: Record<string, unknown>,
  commerceIdentity: CommerceIdentityEvidence | null | undefined,
  enabled: boolean = isIdentityRankingEnabled(),
): T[] {
  if (!enabled || !scannedCategory(garment) || products.length <= 1) return products;
  return products
    .map((product, index) => ({
      product,
      index,
      // Usability was already decided (and unsupported offers removed) by
      // rescoreForIdentityRanking; a full base score asks only for the evidence tier.
      rank: IDENTITY_TIER_RANK[decideIdentityTier(product as unknown as Record<string, unknown>, garment, commerceIdentity, 100).tier],
    }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.product);
}
