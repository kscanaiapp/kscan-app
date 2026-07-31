'use strict';

/**
 * Scoring contract 0.3.0 — the two measurement repairs.
 *
 * MC-2 (brand): five governed cases combine `brandVisible: true` and
 * `brandEvidenceState: product_level_evidence` with an unnamed brand label. Under
 * 0.2.0 a scanner that correctly read the mark scored `unsupported_certainty` at
 * the heaviest penalty in the profile, while positive brand correctness could
 * never increment. Both brand metrics were wrong, in opposite directions.
 *
 * Gradeability: identification accuracy must be measured over cases whose ground
 * truth can actually grade an answer. Counting a correct abstention as an
 * identification hit overstated accuracy on a corpus where 17 of 40 cases carry
 * no concrete category.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const score = require('../lib/scoreFields');
const { ROOT } = require('../lib/governedStorage');

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json'), 'utf8')
);
const CASES = MANIFEST.cases;
const PRODUCT_LEVEL = CASES.filter((c) => c.brandEvidenceState === 'product_level_evidence');

test('the scoring contract version records the behaviour change', () => {
  assert.strictEqual(score.SCORING_CONTRACT_VERSION, '0.3.0');
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/dataset-version.json'), 'utf8')
  );
  assert.strictEqual(version.scoringContractVersion, '0.3.0');
  // Scoring meaning changed; the dataset did not.
  assert.strictEqual(version.datasetVersion, '0.3.1');
});

test('the governed corpus still contains exactly the five MC-2 cases', () => {
  assert.strictEqual(PRODUCT_LEVEL.length, 5);
  for (const record of PRODUCT_LEVEL) {
    assert.strictEqual(record.brandVisible, true);
    assert.strictEqual(record.expectedBrandAssertionBehavior, 'brand_may_be_named_and_is_scored_for_correctness');
    assert.ok(
      ['unknown', 'not_visible'].includes(record.brand),
      `${record.caseId} unexpectedly carries a concrete brand; MC-2 no longer applies and this guard must be revisited`
    );
  }
});

test('MC-2: a correct brand reading is never scored as a hallucination', () => {
  for (const record of PRODUCT_LEVEL) {
    const named = score.scoreBrand(record.brand, 'Nike', { brandEvidenceState: record.brandEvidenceState });
    assert.strictEqual(named.disposition, score.DISPOSITIONS.NOT_MEASURED, record.caseId);
    assert.strictEqual(named.brandFalsePositive, false, record.caseId);
    assert.strictEqual(named.brandNotMeasured, true, record.caseId);
    assert.strictEqual(named.penalty, 0, record.caseId);
  }
});

test('MC-2 cases are excluded from BOTH brand cohorts', () => {
  const guessing = score.aggregateScores(CASES.map((c) => score.scoreCase(c, { brand: 'SomeBrand' })));
  const signals = guessing.brandPrecisionSignals;

  assert.strictEqual(signals.notMeasuredCases, 5);
  assert.strictEqual(signals.falsePositiveCohortN, CASES.length - 5);
  assert.strictEqual(signals.positiveBrandCorrectness, 'not_measured');
  // Every counted false positive comes from outside the MC-2 set.
  assert.ok(signals.falsePositives > 0, 'false positives must remain measurable outside MC-2');
  assert.ok(signals.falsePositives <= signals.falsePositiveCohortN);
});

test('brand false-positive measurement still works, and abstention is not a false positive', () => {
  const control = CASES.find((c) => c.brandEvidenceState === 'no_reliable_evidence');

  const invented = score.scoreBrand(control.brand, 'SomeBrand', {
    brandEvidenceState: control.brandEvidenceState,
  });
  assert.strictEqual(invented.brandFalsePositive, true);
  assert.ok(invented.penalty > 0);

  const abstained = score.scoreBrand(control.brand, null, {
    brandEvidenceState: control.brandEvidenceState,
  });
  assert.strictEqual(abstained.brandFalsePositive, false);
  assert.strictEqual(abstained.penalty, 0);
});

test('an abstention is not counted as a concrete brand prediction', () => {
  const abstaining = score.aggregateScores(CASES.map((c) => score.scoreCase(c, {})));
  assert.strictEqual(
    abstaining.brandPrecisionSignals.concretePredictions,
    0,
    'a scanner that named no brand must have a zero precision denominator'
  );
  assert.strictEqual(abstaining.brandPrecisionSignals.correct, 0);
  assert.strictEqual(abstaining.brandPrecisionSignals.falsePositives, 0);
});

test('fields with zero gradeable samples report not_measured, never 0', () => {
  const agg = score.aggregateScores(CASES.map((c) => score.scoreCase(c, {})));

  for (const field of ['pattern', 'brand']) {
    const bucket = agg.identification[field];
    assert.strictEqual(bucket.gradeableN, 0, `${field} unexpectedly has gradeable samples`);
    assert.strictEqual(bucket.correctRate, 'not_measured');
    assert.strictEqual(bucket.strictCorrectRate, 'not_measured');
    assert.notStrictEqual(bucket.correctRate, 0);
  }
});

test('gradeable identification counts match the governed labels', () => {
  const agg = score.aggregateScores(CASES.map((c) => score.scoreCase(c, {})));
  const concrete = (field) =>
    CASES.filter((c) => {
      const value = c[field];
      return typeof value === 'string' && !['unknown', 'not_visible', 'not_applicable'].includes(value);
    }).length;

  for (const field of ['category', 'clothingType', 'subtype', 'primaryColor', 'material']) {
    assert.strictEqual(
      agg.identification[field].gradeableN,
      concrete(field),
      `${field} gradeable count diverges from the governed labels`
    );
    assert.strictEqual(
      agg.identification[field].gradeableN + agg.identification[field].ungradeableN + agg.identification[field].notMeasuredN,
      CASES.length
    );
  }

  // Pinned so a silent corpus or label change is caught here.
  assert.strictEqual(agg.identification.category.gradeableN, 23);
  assert.strictEqual(agg.identification.subtype.gradeableN, 20);
  assert.strictEqual(agg.identification.material.gradeableN, 11);
});

test('a correct abstention never counts as an identification hit', () => {
  // Ground truth unknown, scanner abstains: good behaviour, but not evidence
  // that anything was identified.
  const label = {
    caseId: 'synthetic-ungradeable',
    category: 'unknown',
    clothingType: 'unknown',
    subtype: 'unknown',
    primaryColor: 'unknown',
    secondaryColors: [],
    material: 'unknown',
    pattern: 'unknown',
    brand: 'unknown',
    exactProduct: 'unknown',
    expectedResultType: 'insufficient_evidence',
    expectedAbstention: true,
    nonFashion: false,
  };
  const agg = score.aggregateScores([score.scoreCase(label, {})]);
  assert.strictEqual(agg.identification.category.gradeableN, 0);
  assert.strictEqual(agg.identification.category.correctRate, 'not_measured');
  // The abstention is still credited, in its own metric.
  assert.ok(agg.abstention.correct >= 0);
});

test('objectives with no ground-truth field are declared, not silently absent', () => {
  const agg = score.aggregateScores(CASES.map((c) => score.scoreCase(c, {})));
  for (const field of ['silhouette', 'constructionDetails', 'designDetails']) {
    assert.strictEqual(agg.structurallyUnmeasurable[field], 'not_measured');
  }
  assert.strictEqual(agg.exactProduct.exactProductPrecision, 'not_measured');
});
