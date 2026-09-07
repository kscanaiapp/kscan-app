'use strict';

const { IDENTITY_LEVELS } = require('./rubric');

/**
 * Axis A - product identity (spec section 13).
 * "Did we find the actual item?" - independent of whether the result is
 * otherwise a useful shopping substitute.
 *
 * groundTruth.identitySku, when present, is the authoritative identity key
 * (spec section 15 - SKU/manufacturer/retailer-PDP provenance only; never a
 * model-generated guess). For synthetic fixtures, the generator's own
 * construction parameters ARE the ground truth (section 15's synthetic
 * carve-out).
 */
function scoreIdentity(candidate, groundTruth) {
  if (!groundTruth || groundTruth.identitySku === undefined) {
    return { level: 'UNKNOWN', reason: 'no_ground_truth_identity_sku' };
  }
  if (!candidate) {
    return { level: 'UNKNOWN', reason: 'no_candidate_returned' };
  }

  const candidateSku = candidate.identitySku ?? candidate.sku ?? null;
  if (candidateSku && candidateSku === groundTruth.identitySku) {
    return { level: 'EXACT', reason: 'sku_exact_match' };
  }

  // Probable-exact: no durable SKU match, but brand + normalized title agree
  // closely and category matches - strong but not certain identity signal.
  const brandMatch =
    candidate.brandNormalized &&
    groundTruth.brandNormalized &&
    candidate.brandNormalized === groundTruth.brandNormalized;
  const categoryMatch =
    candidate.category && groundTruth.category && candidate.category === groundTruth.category;
  const titleOverlap =
    typeof candidate.titleNormalized === 'string' &&
    typeof groundTruth.titleNormalized === 'string' &&
    groundTruth.titleNormalized.length > 0 &&
    candidate.titleNormalized.includes(groundTruth.titleNormalized);

  if (brandMatch && categoryMatch && titleOverlap) {
    return { level: 'PROBABLE_EXACT', reason: 'brand_title_category_match_no_sku' };
  }

  // Wrong identity: category itself disagrees - this is not "we found a
  // different colorway", this is "we found the wrong garment entirely".
  if (candidate.category && groundTruth.category && candidate.category !== groundTruth.category) {
    return { level: 'WRONG_IDENTITY', reason: 'category_mismatch' };
  }

  return { level: 'UNKNOWN', reason: 'insufficient_identity_evidence' };
}

function isValidIdentityLevel(level) {
  return IDENTITY_LEVELS.includes(level);
}

module.exports = { scoreIdentity, isValidIdentityLevel, IDENTITY_LEVELS };
