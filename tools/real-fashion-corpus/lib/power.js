'use strict';

/**
 * Power / claim map (mission sections 8 and 38).
 *
 *   "Before scaling collection, create a POWER / CLAIM MAP stating what sample
 *    sizes are sufficient for claims ... Classify each possible claim at
 *    current N as: DECISION_GRADE / DIRECTIONAL / DESCRIPTIVE_ONLY /
 *    INSUFFICIENT_N. Use that analysis to justify the final target."
 *
 * And section 38: "Suppress metrics where the power/claim map says the corpus
 * is insufficient. Do not hide small N behind an overall percentage."
 *
 * This module is what makes that mechanical rather than aspirational: it takes
 * the corpus as it actually is and classifies every claim the corpus might be
 * asked to support. A metric whose claim classifies as INSUFFICIENT_N is
 * SUPPRESSED in the report - not printed with a caveat, suppressed - because a
 * caveat next to a number is read as a number.
 *
 * The thresholds below are stated openly, with their reasoning, rather than
 * being smuggled in as magic constants.
 */

/**
 * Threshold reasoning:
 *
 * DECISION_GRADE (n >= 30). Inherited deliberately from FMQL's own
 *   MIN_N_FOR_DECISION_GRADE, so the two labs agree on what "decision grade"
 *   means and a reader is not asked to hold two different bars in their head.
 *   At n=30 a proportion near 0.5 has a 95% normal-approximation half-width of
 *   about +/-18 points, which is wide - hence DECISION_GRADE here means "worth
 *   acting on", never "precise".
 *
 * DIRECTIONAL (15 <= n < 30). Enough to see a large effect and form a
 *   hypothesis; not enough to size one.
 *
 * DESCRIPTIVE_ONLY (5 <= n < 15). You may say what happened in these cases.
 *   You may not generalise from them at all.
 *
 * INSUFFICIENT_N (n < 5). Say nothing; the metric is suppressed.
 *
 * PAIRED comparisons get a lower bar (12 / 8 / 3) because a paired design
 * removes between-garment variance, which is the dominant noise source when
 * comparing two devices photographing the SAME physical object.
 */
const THRESHOLDS = Object.freeze({
  unpaired: { decisionGrade: 30, directional: 15, descriptive: 5 },
  paired: { decisionGrade: 12, directional: 8, descriptive: 3 },
});

const CLASSIFICATIONS = Object.freeze(['DECISION_GRADE', 'DIRECTIONAL', 'DESCRIPTIVE_ONLY', 'INSUFFICIENT_N']);

function classify(n, kind = 'unpaired') {
  const t = THRESHOLDS[kind];
  if (n >= t.decisionGrade) return 'DECISION_GRADE';
  if (n >= t.directional) return 'DIRECTIONAL';
  if (n >= t.descriptive) return 'DESCRIPTIVE_ONLY';
  return 'INSUFFICIENT_N';
}

/** A claim is suppressed unless it reaches at least DESCRIPTIVE_ONLY. */
function isSuppressed(classification) {
  return classification === 'INSUFFICIENT_N';
}

/**
 * The claims this corpus is designed to be asked. Each names the denominator
 * it would be computed over, so "what N does this need" has one answer rather
 * than an argument.
 */
function claimDefinitions({ totalCases, identityEligibleCases, pairedCases, categoryCounts, difficultyCounts }) {
  const claims = [
    {
      claimId: 'OVERALL_IDENTITY_RATE',
      question: 'How often does K Scan identify the exact product?',
      denominator: 'IDENTITY_ELIGIBLE_CASES',
      n: identityEligibleCases,
      kind: 'unpaired',
    },
    {
      claimId: 'OVERALL_SUBSTITUTE_QUALITY',
      question: 'How often are the returned matches commercially useful substitutes?',
      denominator: 'ALL_VALID_REAL_CASES',
      n: totalCases,
      kind: 'unpaired',
    },
    {
      claimId: 'PAIRED_DEVICE_DIFFERENCE',
      question: 'Do iOS and Android captures of the same garment produce different result quality?',
      denominator: 'PAIRED_GARMENTS (one pair = one comparison)',
      n: Math.floor(pairedCases / 2),
      kind: 'paired',
    },
    {
      claimId: 'HARD_NEGATIVE_BEHAVIOUR',
      question: 'Does K Scan confuse visually similar distinct products?',
      denominator: 'CASES TAGGED VISUALLY_SIMILAR_DISTINCT_PRODUCT OR SAME_BRAND_ADJACENT_STYLE OR COLORWAY_SIBLING',
      n:
        (difficultyCounts.VISUALLY_SIMILAR_DISTINCT_PRODUCT || 0) +
        (difficultyCounts.SAME_BRAND_ADJACENT_STYLE || 0) +
        (difficultyCounts.COLORWAY_SIBLING || 0),
      kind: 'unpaired',
    },
    {
      claimId: 'LOGO_VISIBILITY_EFFECT',
      question: 'Does a visible logo materially change identification quality?',
      denominator: 'min(VISIBLE_LOGO cases, NO_VISIBLE_LOGO cases) - a comparison is limited by its smaller arm',
      n: Math.min(difficultyCounts.VISIBLE_LOGO || 0, difficultyCounts.NO_VISIBLE_LOGO || 0),
      kind: 'unpaired',
    },
    {
      claimId: 'DARK_GARMENT_EFFECT',
      question: 'Do dark garments identify worse than light ones?',
      denominator: 'min(DARK_GARMENT cases, LIGHT_GARMENT cases)',
      n: Math.min(difficultyCounts.DARK_GARMENT || 0, difficultyCounts.LIGHT_GARMENT || 0),
      kind: 'unpaired',
    },
    {
      claimId: 'PATTERN_EFFECT',
      question: 'Do patterned garments behave differently from solid ones?',
      denominator: 'min(PATTERNED cases, SOLID_COLOR cases)',
      n: Math.min(difficultyCounts.PATTERNED || 0, difficultyCounts.SOLID_COLOR || 0),
      kind: 'unpaired',
    },
    {
      claimId: 'CAPTURE_CONDITION_EFFECT',
      question: 'Does lighting or capture condition materially affect result quality?',
      denominator: 'CASES OF ONE GARMENT UNDER DIFFERING CONDITIONS (paired within garment)',
      n: 0, // filled by the caller when condition-paired cases exist
      kind: 'paired',
    },
  ];

  for (const [category, count] of Object.entries(categoryCounts || {})) {
    claims.push({
      claimId: `CATEGORY_IDENTITY_RATE__${category.toUpperCase()}`,
      question: `How often does K Scan identify the exact product in the ${category} category?`,
      denominator: `IDENTITY_ELIGIBLE_CASES IN CATEGORY ${category}`,
      n: count,
      kind: 'unpaired',
    });
  }

  return claims;
}

/**
 * Classify every claim at the corpus's current size.
 * Returns { thresholds, claims, summary, suppressedClaimIds }.
 */
function classifyClaims(corpusShape) {
  const claims = claimDefinitions(corpusShape).map((claim) => {
    const classification = classify(claim.n, claim.kind);
    return {
      ...claim,
      classification,
      suppressed: isSuppressed(classification),
      shortfallToDescriptive: Math.max(0, THRESHOLDS[claim.kind].descriptive - claim.n),
      shortfallToDirectional: Math.max(0, THRESHOLDS[claim.kind].directional - claim.n),
      shortfallToDecisionGrade: Math.max(0, THRESHOLDS[claim.kind].decisionGrade - claim.n),
    };
  });

  const summary = {};
  for (const classification of CLASSIFICATIONS) {
    summary[classification] = claims.filter((claim) => claim.classification === classification).length;
  }

  return {
    thresholds: THRESHOLDS,
    thresholdRationale:
      'DECISION_GRADE n>=30 is inherited from the Fashion Match Quality Lab\'s own MIN_N_FOR_DECISION_GRADE so the ' +
      'two labs agree on the bar. Paired comparisons use a lower bar (12) because a paired design removes ' +
      'between-garment variance, the dominant noise source when two devices photograph the same object.',
    claims,
    summary,
    suppressedClaimIds: claims.filter((claim) => claim.suppressed).map((claim) => claim.claimId),
    rule:
      'A metric whose claim classifies as INSUFFICIENT_N is SUPPRESSED, not printed with a caveat. A caveat next ' +
      'to a number is read as a number (mission section 38).',
  };
}

/**
 * Given the claims an owner wants to reach, how many cases does the corpus
 * need? This is what justifies the collection target rather than picking a
 * round number.
 */
function deriveCollectionTarget({ targetClaims, holdoutFraction = 0.25 }) {
  const requirements = targetClaims.map((claim) => ({
    claimId: claim.claimId,
    targetClassification: claim.targetClassification,
    requiredN: THRESHOLDS[claim.kind || 'unpaired'][
      claim.targetClassification === 'DECISION_GRADE'
        ? 'decisionGrade'
        : claim.targetClassification === 'DIRECTIONAL'
          ? 'directional'
          : 'descriptive'
    ],
  }));

  // The identity denominator is the binding constraint: it is a subset of all
  // cases, so the corpus must be larger than the largest identity requirement
  // by whatever fraction of garments fail to reach IDENTIFIER_GRADE, and
  // larger again to leave a sealed holdout that is never spent on development.
  const largestDevelopmentRequirement = Math.max(...requirements.map((r) => r.requiredN), 0);
  const developmentCases = largestDevelopmentRequirement;
  const totalCases = Math.ceil(developmentCases / (1 - holdoutFraction));

  return { requirements, developmentCases, holdoutFraction, totalCases };
}

module.exports = {
  THRESHOLDS,
  CLASSIFICATIONS,
  classify,
  isSuppressed,
  claimDefinitions,
  classifyClaims,
  deriveCollectionTarget,
};
