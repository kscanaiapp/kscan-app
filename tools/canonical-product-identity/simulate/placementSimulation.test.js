'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { simulatePlacements } = require('./placementSimulation');
const { loadSyntheticCorpus } = require('../corpus/corpusLoader');

// spec section 43 (placement simulation, section 29): every placement is
// classified PROVEN/OBSERVED/MODELED - never presented as a production measurement.
test('PLACEMENT SIMULATION: every placement carries an explicit timingClass, and none claims PROVEN', () => {
  const corpus = loadSyntheticCorpus();
  const result = simulatePlacements(corpus);
  for (const key of Object.keys(result.placements)) {
    const p = result.placements[key];
    assert.ok(p.timingClass, `${key} missing timingClass`);
    assert.doesNotMatch(p.timingClass, /^PROVEN$/, `${key} must never claim PROVEN production timing`);
  }
});

test('PLACEMENT SIMULATION: evidenceClass is DERIVED_FROM_SOURCE (Curiosity Gap artifacts absent from this base per Addendum A.1)', () => {
  const corpus = loadSyntheticCorpus();
  const result = simulatePlacements(corpus);
  assert.match(result.evidenceClass, /DERIVED_FROM_SOURCE/);
});

test('PLACEMENT SIMULATION: P0 avoids strictly more (or equal) work than P1, which avoids strictly more (or equal) than P2', () => {
  const corpus = loadSyntheticCorpus();
  const result = simulatePlacements(corpus);
  const p0 = result.placements.P0_POST_RETRIEVAL_PRE_ENRICHMENT.modeledMsAvoided;
  const p1 = result.placements.P1_POST_ENRICHMENT_PRE_RANKING.modeledMsAvoided;
  const p2 = result.placements.P2_POST_RANKING_PRE_DISPLAY.modeledMsAvoided;
  assert.ok(p0 >= p1);
  assert.ok(p1 >= p2);
  assert.equal(p2, 0, 'P2 is purely a display-grouping concern - zero upstream compute avoided by construction');
});
