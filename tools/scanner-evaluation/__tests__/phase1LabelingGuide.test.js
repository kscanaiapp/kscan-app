'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const guide = require('../lib/labelingGuide');
const { aggregateScores } = require('../lib/scoreFields');

test('G-1 ambiguous multi-item cases abstain and use canonical unknown item fields', () => {
  assert.deepEqual(guide.designateSubject(), {
    designation: 'ambiguous_no_dominant',
    subject: null,
    expectedResultType: 'insufficient_evidence',
    itemFieldValue: 'unknown',
  });
  assert.equal(guide.designateSubject({ manifestSubject: 'left garment' }).designation, 'manifest_specified');
  assert.equal(guide.designateSubject({ dominantSubject: 'central boot' }).designation, 'unambiguously_dominant');
});

test('G-2 non-fashion labels use one canonical unavailable token and retain the abstention flag', () => {
  const labels = guide.canonicalNonFashionLabels();
  for (const field of guide.NON_FASHION_FIELDS) assert.equal(labels[field], 'not_applicable');
  assert.equal(labels.nonFashion, true);
  assert.equal(labels.expectedResultType, 'insufficient_evidence');
  assert.equal(labels.expectedAbstention, true);
});

test('G-3 color uses a supportable shade, then family, then unknown', () => {
  assert.equal(guide.selectVisibleColor({ specificShade: 'navy', broaderFamily: 'blue' }), 'navy');
  assert.equal(guide.selectVisibleColor({ broaderFamily: 'blue' }), 'blue');
  assert.equal(guide.selectVisibleColor(), 'unknown');
});

test('G-4 product-level evidence permits a brand but contextual cues do not', () => {
  assert.deepEqual(guide.classifyBrandEvidence({ legibleWordmark: true, contextualCue: true }), {
    state: 'product_level_evidence',
    positiveBrandAllowed: true,
  });
  assert.deepEqual(guide.classifyBrandEvidence({ contextualCue: true }), {
    state: 'contextual_cue_only',
    positiveBrandAllowed: false,
  });
  assert.equal(guide.classifyBrandEvidence().state, 'no_reliable_evidence');
});

test('G-5 not_visible means missing evidence; unknown means visible but unmappable evidence', () => {
  assert.equal(guide.unavailableFromEvidence({ evidencePresent: false }), 'not_visible');
  assert.equal(guide.unavailableFromEvidence({ evidencePresent: true, mapsToAllowedValue: false }), 'unknown');
  assert.equal(guide.unavailableFromEvidence({ evidencePresent: true, mapsToAllowedValue: true }), null);
});

test('G-6 exact-product metrics remain structurally not_measured', () => {
  assert.deepEqual(guide.exactProductMetricDisposition(), {
    exactProductPrecision: 'not_measured',
    incorrectExactMatchRate: 'not_measured',
  });
  assert.equal(aggregateScores([]).exactProduct.exactProductPrecision, 'not_measured');
  assert.equal(aggregateScores([]).exactProduct.incorrectExactMatchRate, 'not_measured');
});

test('G-7 live body parts and live reflections set visiblePerson; likenesses do not', () => {
  assert.equal(guide.visiblePerson({ liveHand: true }), true);
  assert.equal(guide.visiblePerson({ livePersonReflection: true }), true);
  assert.equal(guide.visiblePerson({ mannequin: true, statue: true, printedPhotograph: true }), false);
});

test('G-8 same-item identity needs an explicit set or a unique physical identity signal', () => {
  assert.equal(guide.samePhysicalItem({ signals: ['same_brand', 'same_sku', 'same_color'] }), false);
  assert.equal(guide.samePhysicalItem({ signals: ['matching_damage'] }), true);
  assert.equal(guide.samePhysicalItem({ explicitlyDesignatedSameItem: true }), true);
});
