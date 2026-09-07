'use strict';

const { assertBaselinesComparable } = require('../baseline/baselineStore');
const { compareScoreMaps } = require('./bootstrap');

/**
 * Compare a baseline against a candidate baseline-shaped result (spec
 * sections 18 + 23). Rejects incompatible baselines outright (mismatched
 * fixture manifest / rubric / schema / corpus tier) rather than producing a
 * misleading number.
 */
function compareBaselines(baseline, candidate, opts = {}) {
  assertBaselinesComparable(baseline, candidate);

  const seed = opts.seed || `${baseline.contentHash}::${candidate.contentHash}`;
  const comparison = compareScoreMaps(baseline.perFixtureScore, candidate.perFixtureScore, {
    ...opts,
    seed,
  });

  return {
    baselineContentHash: baseline.contentHash,
    candidateContentHash: candidate.contentHash,
    fixtureManifestHash: baseline.fixtureManifestHash,
    rubricVersion: baseline.rubricVersion,
    ...comparison,
  };
}

module.exports = { compareBaselines };
