'use strict';

/**
 * Tier 2 - STRUCTURED (spec section 15). Combination of brand, style/model,
 * category, variant attributes, normalized title, and fashion attributes.
 * Produces an evidence-backed, explicitly labeled HEURISTIC SCORE (section
 * 16) - never presented as a calibrated probability.
 *
 * Conservative gate (mirrors the incumbent classifier -
 * tools/fashion-match-quality/duplicates/duplicateClassifier.js): brand AND
 * category must both be present and agree before ANY structured-evidence
 * score is computed. This is not a stylistic choice - it is the same gate
 * production's own conservative heuristic already uses, kept for
 * continuity and comparability (spec section 27 incumbent comparison).
 *
 * Any conflicting attribute (brand, category, color, material, pattern, or
 * construction detail) is HARD NEGATIVE evidence per section 17 and is
 * capable of blocking a merge on its own, regardless of how high the
 * supporting-evidence score is elsewhere.
 */

const { jaccard } = require('../lib/textNormalize');

const TITLE_OVERLAP_STRONG = 0.6;
const TITLE_OVERLAP_WEAK = 0.3;

const WEIGHTS = {
  brand_match: 0.3,
  category_match: 0.25,
  title_overlap_strong: 0.2,
  title_overlap_weak: 0.08,
  color_match: 0.1,
  material_match: 0.1,
  pattern_match: 0.05,
  construction_details_match: 0.03,
  identical_image_reference_supporting_only: 0.02,
};

function attrRelation(a, b) {
  if (!a || !b) return 'unknown';
  return a === b ? 'match' : 'differ';
}

function setRelation(setA, setB) {
  if (!setA || !setB || setA.size === 0 || setB.size === 0) return 'unknown';
  for (const v of setA) {
    if (setB.has(v)) return 'match';
  }
  return 'differ';
}

function tier2Structured(normA, normB) {
  const positive = [];
  const negative = [];
  const missing = [];

  const brandBothPresent = Boolean(normA.brand && normB.brand);
  const brandMatch = brandBothPresent && normA.brand === normB.brand;
  if (!brandBothPresent) missing.push('brand_missing_one_or_both_sides');
  else if (brandMatch) positive.push('brand_match');
  else negative.push('brand_conflict');

  const categoryBothPresent = Boolean(normA.category && normB.category);
  const categoryMatch = categoryBothPresent && normA.category === normB.category;
  if (!categoryBothPresent) missing.push('category_missing_one_or_both_sides');
  else if (categoryMatch) positive.push('category_match');
  else negative.push('category_conflict');

  // Conservative gate: without brand+category agreement, no structured
  // style-level claim is made at all (section 9 evidence: this mirrors the
  // incumbent's own "insufficient_brand_or_category_evidence" gate).
  if (!brandMatch || !categoryMatch) {
    return {
      styleScore: 0, styleEligible: false, positive, negative, missing,
      colorRelation: 'unknown', materialRelation: 'unknown', patternRelation: 'unknown',
      constructionRelation: 'unknown', titleOverlap: 0,
    };
  }

  const titleOverlap = jaccard(normA.titleTokens, normB.titleTokens);
  if (titleOverlap >= TITLE_OVERLAP_STRONG) positive.push('title_overlap_strong');
  else if (titleOverlap >= TITLE_OVERLAP_WEAK) positive.push('title_overlap_weak');
  else if (normA.titleTokens.size && normB.titleTokens.size) missing.push('title_overlap_low');

  const colorRelation = attrRelation(normA.color, normB.color);
  const materialRelation = attrRelation(normA.material, normB.material);
  const patternRelation = attrRelation(normA.pattern, normB.pattern);
  const constructionRelation = setRelation(normA.constructionDetails, normB.constructionDetails);

  if (colorRelation === 'match') positive.push('color_match');
  else if (colorRelation === 'differ') negative.push('color_conflict');
  else missing.push('color_missing_one_or_both_sides');

  if (materialRelation === 'match') positive.push('material_match');
  else if (materialRelation === 'differ') negative.push('material_conflict');
  else missing.push('material_missing_one_or_both_sides');

  if (patternRelation === 'match') positive.push('pattern_match');
  else if (patternRelation === 'differ') negative.push('pattern_conflict');

  if (constructionRelation === 'match') positive.push('construction_details_match');
  else if (constructionRelation === 'differ') negative.push('construction_details_conflict');

  // Supporting-only, per section 12: image evidence can raise confidence
  // but (a) only ever contributes a small weight, and (b) never fires when
  // there is already a conflict elsewhere - handled by resolvePair.js,
  // which checks `negative.length` before honoring styleScore at all.
  if (normA.imageUrl && normB.imageUrl && normA.imageUrl === normB.imageUrl) {
    positive.push('identical_image_reference_supporting_only');
  }

  let styleScore = 0;
  for (const p of positive) styleScore += WEIGHTS[p] || 0;
  styleScore = Math.min(1, styleScore);

  return {
    styleScore, styleEligible: true, positive, negative, missing,
    colorRelation, materialRelation, patternRelation, constructionRelation, titleOverlap,
  };
}

module.exports = { tier2Structured, TITLE_OVERLAP_STRONG, TITLE_OVERLAP_WEAK, WEIGHTS };
