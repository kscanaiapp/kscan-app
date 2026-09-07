'use strict';

/**
 * Tier 1 - EXACT (spec section 15). Strong, validated identifiers only:
 * GTIN, MPN, manufacturer style code. AUTO-MERGE ELIGIBLE subject to
 * contradiction checks performed by the caller (resolvePair.js) - this
 * module only reports positive/negative/missing evidence, it never itself
 * decides the final pairwise decision.
 */

function tier1Exact(normA, normB) {
  const positive = [];
  const negative = [];
  const missing = [];

  // GTIN - only comparable when BOTH sides supplied one; only trustworthy
  // when BOTH validate (section 12 "matching VALIDATED GTIN").
  if (normA.gtinPresent && normB.gtinPresent) {
    if (normA.gtinValid && normB.gtinValid) {
      if (normA.gtin === normB.gtin) positive.push('validated_gtin_match');
      else negative.push('validated_gtin_conflict');
    } else {
      missing.push('gtin_present_but_not_both_validated');
    }
  } else if (normA.gtinPresent || normB.gtinPresent) {
    missing.push('gtin_present_one_side_only');
  }

  // Manufacturer style code.
  if (normA.manufacturerStyleCode && normB.manufacturerStyleCode) {
    if (normA.manufacturerStyleCode === normB.manufacturerStyleCode) positive.push('manufacturer_style_code_match');
    else negative.push('manufacturer_style_code_conflict');
  } else if (normA.manufacturerStyleCode || normB.manufacturerStyleCode) {
    missing.push('manufacturer_style_code_present_one_side_only');
  }

  // MPN.
  if (normA.mpn && normB.mpn) {
    if (normA.mpn === normB.mpn) positive.push('mpn_match');
    else negative.push('mpn_conflict');
  } else if (normA.mpn || normB.mpn) {
    missing.push('mpn_present_one_side_only');
  }

  const eligible = negative.length > 0 ? 'BLOCKED' : positive.length > 0 ? 'AUTO_MERGE_ELIGIBLE' : 'NO_TIER1_EVIDENCE';

  return { eligible, positive, negative, missing };
}

module.exports = { tier1Exact };
