'use strict';

/**
 * EXTRACTION OPERATING CURVE — spec section 28.
 *
 * Sweeps the extractor's tolerance settings (alias resolution on/off,
 * partial-name/category-only matching on/off) and reports DETECTION RECALL,
 * FALSE POSITIVE RATE, and UNDECIDABLE VOLUME at each point. This module
 * does NOT select a production operating point -- that is an owner decision
 * for later (spec section 28 is explicit about this).
 */

const { buildCorpus } = require('../metrics/corpusRunner');
const { computeVerdictReproduction } = require('../metrics/verdictReproduction');

const OPERATING_POINTS = [
  { id: 'alias_on_partial_on', aliasTolerance: true, partialNameTolerance: true },
  { id: 'alias_off_partial_on', aliasTolerance: false, partialNameTolerance: true },
  { id: 'alias_on_partial_off', aliasTolerance: true, partialNameTolerance: false },
  { id: 'alias_off_partial_off', aliasTolerance: false, partialNameTolerance: false },
];

function runOperatingCurve() {
  return OPERATING_POINTS.map((point) => {
    const { cases } = buildCorpus({ aliasTolerance: point.aliasTolerance, partialNameTolerance: point.partialNameTolerance });
    const metrics = computeVerdictReproduction(cases);
    const undecidableVolume = cases.filter((c) => c.actualVerdict === 'UNDECIDABLE').length;
    return {
      operatingPoint: point.id,
      aliasTolerance: point.aliasTolerance,
      partialNameTolerance: point.partialNameTolerance,
      detectionRecall: metrics.overall.rate,
      falsePositiveRate: metrics.evaluatorFalsePositiveRate.rate,
      undecidableVolume,
      undecidableAccuracy: metrics.undecidableAccuracy.rate,
    };
  });
}

module.exports = { runOperatingCurve, OPERATING_POINTS };
