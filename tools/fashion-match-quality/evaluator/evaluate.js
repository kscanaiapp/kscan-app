'use strict';

const { scoreIdentity } = require('./identityAxis');
const { scoreSubstitute } = require('./substituteAxis');
const { RUBRIC_VERSION } = require('./rubric');
const { applyCaptureProfileToFixture } = require('../captureProfiles/profiles');
const { summarizeDuplicatesAndRetailers } = require('../duplicates/duplicateClassifier');
const { runL1ForFixture } = require('../l1/runL1');

/**
 * Evaluate one fixture end to end:
 *   1. Run the REAL production ranker (L1, via Deno) if available.
 *   2. Score the top-ranked candidate on both independent axes (identity,
 *      substitute) against the fixture's ground truth.
 *   3. Classify duplicates/retailer concentration across the full candidate
 *      set actually considered.
 *   4. Tag with the fixture's capture profile.
 *
 * Returns a single evaluation record. Never throws for an ordinary
 * evaluation outcome (a missing L1 result is recorded as a blocker on the
 * record, not an exception) so one fixture's issue never aborts a batch.
 */
function evaluateFixture(fixture) {
  const l1Result = runL1ForFixture(fixture);
  const withProfile = applyCaptureProfileToFixture(fixture);

  const record = {
    fixtureId: fixture.fixtureId,
    corpusTier: fixture.corpusTier,
    captureProfile: fixture.captureProfile,
    captureProfileMeta: withProfile.captureProfileMeta,
    pairedFixtureId: fixture.pairedFixtureId || null,
    rubricVersion: RUBRIC_VERSION,
    groundTruthSource: fixture.groundTruth?.source,
    groundTruthConfidence: fixture.groundTruth?.confidence,
    excludedFromHeadlineMetrics: fixture.groundTruth?.confidence !== 'authoritative',
  };

  if (!l1Result.ok) {
    return {
      ...record,
      l1Status: 'BLOCKED',
      l1Blocker: l1Result.blocker,
      l1BlockerDetail: l1Result.detail,
      identity: { level: 'UNKNOWN', reason: 'l1_unavailable' },
      substitute: { level: null, reason: 'l1_unavailable', insufficientEvidence: true },
      duplicates: null,
      topCandidateId: null,
    };
  }

  const ranked = l1Result.ranked || [];
  const top = ranked[0] || null;

  const identity = scoreIdentity(top, fixture.groundTruth);
  const substitute = scoreSubstitute(top, fixture.groundTruth);
  const duplicates = summarizeDuplicatesAndRetailers(ranked);

  return {
    ...record,
    l1Status: 'OK',
    l1MergedCandidateCount: l1Result.mergedCandidateCount,
    topCandidateId: top ? top.id : null,
    topCandidateScore: top ? top.matchScore : null,
    topCandidateConfidenceTier: top ? top.confidenceTier : null,
    identity,
    substitute,
    duplicates,
    rankedCandidateCount: ranked.length,
  };
}

function evaluateCorpus(fixtures) {
  return fixtures.map(evaluateFixture);
}

module.exports = { evaluateFixture, evaluateCorpus };
