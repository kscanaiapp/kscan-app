'use strict';

const { runL1ForFixture } = require('../l1/runL1');
const { scoreIdentity } = require('../evaluator/identityAxis');
const { scoreSubstitute } = require('../evaluator/substituteAxis');
const { compareScoreMaps, MIN_N_FOR_DECISION_GRADE } = require('../statistics/bootstrap');

const silhouetteBoost = require('./variants/silhouetteBoost');
const duplicateSuppression = require('./variants/duplicateSuppression');

const REGISTRY = [silhouetteBoost, duplicateSuppression];

function substituteRollupOrZero(candidate, groundTruth) {
  const result = scoreSubstitute(candidate, groundTruth);
  return typeof result.rollup === 'number' ? result.rollup : 0;
}

/**
 * Run one experiment variant across every headline-eligible, L1-available
 * fixture. Returns the structured record spec section 28 requires.
 */
function runExperiment(variant, fixtures) {
  const baselineByFixture = {};
  const candidateByFixture = {};
  let identityRegressions = 0;
  let identityImprovements = 0;
  let evaluated = 0;

  for (const fixture of fixtures) {
    if (fixture.groundTruth?.confidence !== 'authoritative') continue; // section 15
    const l1 = runL1ForFixture(fixture);
    if (!l1.ok) continue;

    evaluated += 1;
    const baselineTop = (l1.ranked || [])[0] || null;
    baselineByFixture[fixture.fixtureId] = substituteRollupOrZero(baselineTop, fixture.groundTruth);

    let variantRanked;
    if (typeof variant.rank === 'function') {
      variantRanked = variant.rank(l1.ranked, l1.normalized);
    } else if (typeof variant.suppressDuplicates === 'function') {
      variantRanked = variant.suppressDuplicates(l1.ranked);
    } else {
      variantRanked = l1.ranked;
    }
    const variantTop = variantRanked[0] || null;
    candidateByFixture[fixture.fixtureId] = substituteRollupOrZero(variantTop, fixture.groundTruth);

    const baselineIdentity = scoreIdentity(baselineTop, fixture.groundTruth).level;
    const variantIdentity = scoreIdentity(variantTop, fixture.groundTruth).level;
    const rank = { EXACT: 3, PROBABLE_EXACT: 2, UNKNOWN: 1, WRONG_IDENTITY: 0 };
    if (rank[variantIdentity] < rank[baselineIdentity]) identityRegressions += 1;
    if (rank[variantIdentity] > rank[baselineIdentity]) identityImprovements += 1;
  }

  const comparison = compareScoreMaps(baselineByFixture, candidateByFixture, {
    seed: `experiment::${variant.id}`,
  });

  let status;
  if (evaluated < MIN_N_FOR_DECISION_GRADE) {
    // Spec section 28: never call synthetic-only evidence PROMOTABLE.
    status = comparison.meanDelta > 0 ? 'PROMISING' : comparison.meanDelta < 0 ? 'REJECTED' : 'INCONCLUSIVE';
    if (Math.abs(comparison.meanDelta) < 0.02) status = 'INCONCLUSIVE';
  } else {
    status = comparison.status === 'DECISION_GRADE' && comparison.meanDelta > 0 ? 'PROMISING'
      : comparison.status === 'DECISION_GRADE' && comparison.meanDelta < 0 ? 'REJECTED'
      : 'NOT_DECISION_GRADE';
  }

  return {
    hypothesis: variant.hypothesis,
    why: variant.why,
    variant: variant.id,
    baseline: 'L1 real production ranker (scanHelpers.ts rankRecommendedProducts, unmodified)',
    corpus: `SYNTHETIC, n=${evaluated} headline-eligible fixtures`,
    result: {
      sampleCount: comparison.sampleCount,
      meanSubstituteRollupDelta: comparison.meanDelta,
      confidenceInterval: comparison.confidenceInterval,
      statisticalStatus: comparison.status,
      identityImprovements,
      identityRegressions,
    },
    confidence:
      evaluated < MIN_N_FOR_DECISION_GRADE
        ? `LOW - synthetic corpus n=${evaluated} is far below the ${MIN_N_FOR_DECISION_GRADE}-fixture minimum this lab treats as decision-grade (spec section 17/18); this is a plumbing/direction signal only.`
        : comparison.status,
    tradeoff:
      identityRegressions > 0
        ? `${identityRegressions} fixture(s) had a WORSE identity classification under this variant - a substitute-quality gain is not free here.`
        : 'No identity-axis regressions observed in this corpus.',
    status,
  };
}

function runAllExperiments(fixtures) {
  return REGISTRY.map((variant) => runExperiment(variant, fixtures));
}

module.exports = { REGISTRY, runExperiment, runAllExperiments };
