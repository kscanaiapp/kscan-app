'use strict';

const { IDENTITY_LEVELS } = require('../evaluator/identityAxis');
const { SUBSTITUTE_LEVELS } = require('../evaluator/substituteAxis');

function emptyCounter(levels) {
  const out = {};
  for (const level of levels) out[level] = 0;
  return out;
}

/**
 * Aggregate a list of per-fixture evaluation records (see evaluator/evaluate.js)
 * into corpus-level metrics. Fixtures flagged excludedFromHeadlineMetrics
 * (non-authoritative ground truth, per spec section 15) are counted
 * separately and never folded into the headline distributions.
 */
function aggregateMetrics(evaluations) {
  const headline = evaluations.filter((e) => !e.excludedFromHeadlineMetrics && e.l1Status === 'OK');
  const excluded = evaluations.filter((e) => e.excludedFromHeadlineMetrics || e.l1Status !== 'OK');

  const identityDistribution = emptyCounter(IDENTITY_LEVELS);
  const substituteDistribution = { ...emptyCounter(SUBSTITUTE_LEVELS), INSUFFICIENT_EVIDENCE: 0 };

  for (const e of headline) {
    if (e.identity && IDENTITY_LEVELS.includes(e.identity.level)) {
      identityDistribution[e.identity.level] += 1;
    }
    if (e.substitute) {
      if (e.substitute.insufficientEvidence || e.substitute.level === null) {
        substituteDistribution.INSUFFICIENT_EVIDENCE += 1;
      } else if (SUBSTITUTE_LEVELS.includes(e.substitute.level)) {
        substituteDistribution[e.substitute.level] += 1;
      }
    }
  }

  // Fashion-component averages (identity never hides behind these, and
  // vice versa - reported as its own block, per spec section 14).
  const componentSums = {};
  const componentCounts = {};
  for (const e of headline) {
    const components = e.substitute?.components || {};
    for (const [name, score] of Object.entries(components)) {
      if (score === null || score === undefined) continue;
      componentSums[name] = (componentSums[name] || 0) + score;
      componentCounts[name] = (componentCounts[name] || 0) + 1;
    }
  }
  const fashionComponentAverages = {};
  for (const name of Object.keys(componentSums)) {
    fashionComponentAverages[name] = componentSums[name] / componentCounts[name];
  }

  // Capture-profile stratification.
  const byCaptureProfile = {};
  for (const e of headline) {
    const profile = e.captureProfile || 'unknown';
    if (!byCaptureProfile[profile]) {
      byCaptureProfile[profile] = {
        count: 0,
        identityDistribution: emptyCounter(IDENTITY_LEVELS),
        substituteDistribution: { ...emptyCounter(SUBSTITUTE_LEVELS), INSUFFICIENT_EVIDENCE: 0 },
      };
    }
    const bucket = byCaptureProfile[profile];
    bucket.count += 1;
    if (e.identity && IDENTITY_LEVELS.includes(e.identity.level)) {
      bucket.identityDistribution[e.identity.level] += 1;
    }
    if (e.substitute) {
      if (e.substitute.insufficientEvidence || e.substitute.level === null) {
        bucket.substituteDistribution.INSUFFICIENT_EVIDENCE += 1;
      } else if (SUBSTITUTE_LEVELS.includes(e.substitute.level)) {
        bucket.substituteDistribution[e.substitute.level] += 1;
      }
    }
  }

  // Duplicate + retailer-neutrality metrics, summed across fixtures.
  let totalDuplicatePairs = { CONFIRMED_DUPLICATE: 0, LIKELY_DUPLICATE: 0, DISTINCT_VARIANT: 0 };
  let totalCandidates = 0;
  let concentrationSum = 0;
  let concentrationCount = 0;
  for (const e of headline) {
    if (!e.duplicates) continue;
    totalCandidates += e.duplicates.totalCandidates || 0;
    for (const key of Object.keys(totalDuplicatePairs)) {
      totalDuplicatePairs[key] += e.duplicates.duplicatePairCounts?.[key] || 0;
    }
    if (e.duplicates.retailerDiversity) {
      concentrationSum += e.duplicates.retailerDiversity.concentrationIndex;
      concentrationCount += 1;
    }
  }

  // Platform-parity pairing coverage.
  const paired = headline.filter((e) => e.pairedFixtureId);

  return {
    sampleCounts: {
      totalFixturesEvaluated: evaluations.length,
      headlineEligible: headline.length,
      excludedFromHeadline: excluded.length,
      pairedForPlatformParity: paired.length,
    },
    identityDistribution,
    substituteDistribution,
    fashionComponentAverages,
    duplicateMetrics: {
      totalCandidatesConsidered: totalCandidates,
      pairClassificationCounts: totalDuplicatePairs,
    },
    retailerNeutralityMetrics: {
      averageConcentrationIndex: concentrationCount > 0 ? concentrationSum / concentrationCount : null,
      note: 'Concentration is descriptive, not a quality judgment (spec section 21) - it may reflect real catalogue availability rather than a ranking defect.',
    },
    captureProfileStratification: byCaptureProfile,
  };
}

module.exports = { aggregateMetrics };
