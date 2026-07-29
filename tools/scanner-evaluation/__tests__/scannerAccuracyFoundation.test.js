'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  validateCase,
  validateManifest,
} = require('../lib/datasetValidate');
const {
  DISPOSITIONS,
  scoreField,
  scoreBrand,
  scoreExactProduct,
  scoreAbstention,
  scoreCase,
  isBroadMatch,
} = require('../lib/scoreFields');
const {
  validateExperimentRecord,
  assertDatasetVersionMatch,
  REQUIRED_EXPERIMENT_FIELDS,
} = require('../lib/experimentMeta');
const {
  compareExperiments,
  runRegressionGate,
  GATE_CATEGORIES,
} = require('../lib/compareCandidates');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SEED_MANIFEST = path.join(
  ROOT,
  'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json'
);

function baseCase(overrides = {}) {
  return {
    caseId: 'qa-test-001',
    datasetVersion: '0.1.0',
    imageReferences: [
      { refType: 'governed_qa_fixture', refValue: 'assets/qa_fixtures/top.jpg' },
    ],
    imageHashes: [
      'sha256:592ede7f86ecdc99d93e6e7785123e61f4e385b79e19a727636986caf51d3677',
    ],
    imageCount: 1,
    sameItemAcrossImages: 'not_applicable',
    category: 'tops',
    clothingType: 'unknown',
    subtype: 'unknown',
    primaryColor: 'unknown',
    secondaryColors: 'unknown',
    material: 'unknown',
    pattern: 'unknown',
    brand: 'unknown',
    exactProduct: 'unknown',
    expectedResultType: 'identified_style',
    expectedAbstention: false,
    reviewStatus: 'approved',
    reviewerCount: 1,
    labelConfidence: 'medium',
    sourceClass: 'kscan_qa_fixture',
    authorizationStatus: 'approved_qa_fixture',
    privacyDisposition: 'governed_fixture_reference',
    notes: 'unit test case',
    ...overrides,
  };
}

function completeExperiment(overrides = {}) {
  const base = {
    experimentId: 'exp-test-1',
    sourceSha: '4b36878798d16b925e163aae5ed7ed1e0b896198',
    scanIdentifyTreeHash: '1e6ec21160ec3bc9c3f834ba59677acb6e3c9e2c',
    sharedContractTreeHash: '1e8acdd4ebf3b6de480352c23d06597ded6ee44d',
    datasetVersion: '0.1.0',
    pipelineVersion: 'static-harness-0.1.0',
    promptVersion: 'none',
    modelConfiguration: { provider: 'none' },
    schemaVersion: 'fashion-identification-v2',
    preprocessingVersion: 'none',
    thresholdVersion: 'none',
    retrievalVersion: 'none',
    rerankingVersion: 'none',
    startedAt: '2026-07-29T00:00:00.000Z',
    completedAt: '2026-07-29T00:00:01.000Z',
    caseCount: 1,
    metrics: {
      meanPenalty: 1,
      categoryCorrectRate: 0.9,
      brandPrecisionSignals: { falsePositives: 0 },
      exactProductSignals: { incorrectExactMatchClaims: 0 },
      abstention: { incorrect: 0 },
      schemaParseFailureRate: 0,
      similarResultRelevance: 0.8,
      commerceLinkValidity: 0.9,
    },
    latency: { totalMs: 0 },
    modelCallCount: 0,
    costEstimate: { currency: 'USD', amount: 0 },
    notes: 'test',
  };
  return { ...base, ...overrides, metrics: { ...base.metrics, ...(overrides.metrics || {}) } };
}

test('dataset schema validation accepts seed manifest', () => {
  const manifest = JSON.parse(fs.readFileSync(SEED_MANIFEST, 'utf8'));
  const result = validateManifest(manifest, { expectedDatasetVersion: '0.1.0' });
  assert.equal(result.ok, true);
  assert.equal(result.cases.length, 8);
});

test('unknown field handling is valid on labels', () => {
  const result = validateCase(baseCase({ brand: 'unknown', material: 'unknown' }));
  assert.equal(result.ok, true);
});

test('not_visible field handling is valid', () => {
  const result = validateCase(baseCase({ brand: 'not_visible', material: 'not_visible' }));
  assert.equal(result.ok, true);
});

test('not_applicable field handling is valid', () => {
  const result = validateCase(
    baseCase({
      category: 'not_applicable',
      brand: 'not_applicable',
      expectedResultType: 'insufficient_evidence',
      expectedAbstention: true,
    })
  );
  assert.equal(result.ok, true);
});

test('invalid case IDs are rejected', () => {
  const result = validateCase(baseCase({ caseId: 'BAD ID!' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'caseId'));
});

test('duplicate case IDs are rejected', () => {
  const c = baseCase({ caseId: 'qa-dup-001' });
  const result = validateManifest({ datasetVersion: '0.1.0', cases: [c, { ...c }] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /duplicate caseId/.test(e.message)));
});

test('missing authorization status is rejected', () => {
  const c = baseCase();
  delete c.authorizationStatus;
  const result = validateCase(c);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'authorizationStatus'));
});

test('invalid expected-result states are rejected', () => {
  const result = validateCase(baseCase({ expectedResultType: 'exact_product_guess' }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'expectedResultType'));
});

test('prohibition on raw user identifiers in manifests', () => {
  const result = validateCase(
    baseCase({ notes: 'linked to actor_id=abc and user@example.com' })
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.path === 'privacy'));
});

test('prohibition on local file-system paths in governed manifests', () => {
  const result = validateCase(
    baseCase({
      imageReferences: [
        { refType: 'governed_qa_fixture', refValue: 'C:\\Users\\jsmit\\secret\\photo.jpg' },
      ],
    })
  );
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /absolute local filesystem paths/.test(e.message)));
});

test('deterministic scoring is stable', () => {
  const label = baseCase({
    category: 'outerwear',
    clothingType: 'jacket',
    subtype: 'chore jacket',
    brand: 'unknown',
  });
  const prediction = {
    category: 'outerwear',
    clothingType: 'jacket',
    subtype: 'jacket',
    brand: 'Chanel',
    expectedResultType: 'identified_style',
  };
  const a = scoreCase(label, prediction);
  const b = scoreCase(label, prediction);
  assert.deepEqual(a, b);
});

test('acceptably broad classification for subtype', () => {
  assert.equal(isBroadMatch('jacket', 'chore jacket'), true);
  const scored = scoreField('subtype', 'chore jacket', 'jacket');
  assert.equal(scored.disposition, DISPOSITIONS.ACCEPTABLY_BROAD);
});

test('unsupported certainty on uncertain ground truth', () => {
  const scored = scoreField('material', 'unknown', 'cashmere');
  assert.equal(scored.disposition, DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.ok(scored.penalty > 0);
});

test('brand false-positive scoring', () => {
  const scored = scoreBrand('unknown', 'Gucci');
  assert.equal(scored.disposition, DISPOSITIONS.UNSUPPORTED_CERTAINTY);
  assert.equal(scored.brandFalsePositive, true);
});

// Phase 0C reclassified MC-1: exact product is NOT MEASURED under the deployed
// contract, which hardcodes exactProduct: null. Scoring it produced a number
// that described the contract rather than the model. A prediction that does
// carry an exact product cannot have come from the certified v140 path, so it
// is surfaced as a runner-fidelity fault instead of a model error.
test('exact product is not_measured, and a claim is flagged as a runner fault', () => {
  const scored = scoreExactProduct('unknown', 'Nike Air Force 1', 'insufficient_evidence');
  assert.equal(scored.disposition, DISPOSITIONS.NOT_MEASURED);
  assert.equal(scored.unexpectedExactProductClaim, true);
  assert.equal(scored.penalty, 0);
});

test('correct abstention', () => {
  const scored = scoreAbstention(
    { expectedAbstention: true },
    { status: 'insufficient_visual_evidence' }
  );
  assert.equal(scored.disposition, DISPOSITIONS.CORRECT_ABSTENTION);
});

test('incorrect abstention', () => {
  const scored = scoreAbstention(
    { expectedAbstention: true },
    { expectedResultType: 'likely_exact_match', exactProduct: 'Something' }
  );
  assert.equal(scored.disposition, DISPOSITIONS.INCORRECT_ABSTENTION);
});

// Phase 0B section 4.6 changed this deliberately. Phase 0A returned UNSCORABLE
// when both sides were uncertain, which dropped the case from the denominator
// and so flattered any model that abstained. Declining an attribute that is
// genuinely not visible is a CORRECT answer and is now counted as one.
test('abstention against a not_visible label is correct, not unscorable', () => {
  const scored = scoreField('pattern', 'not_visible', 'unknown');
  assert.equal(scored.disposition, DISPOSITIONS.CORRECT);
  assert.equal(scored.penalty, 0);
});

test('experiment metadata completeness', () => {
  const record = completeExperiment();
  const result = validateExperimentRecord(record);
  assert.equal(result.ok, true);
  for (const field of REQUIRED_EXPERIMENT_FIELDS) {
    assert.ok(field in record);
  }
});

test('dataset-version mismatch is detected', () => {
  const result = assertDatasetVersionMatch(
    completeExperiment({ datasetVersion: '0.2.0' }),
    '0.1.0'
  );
  assert.equal(result.ok, false);
});

test('candidate/baseline comparison requires identical dataset version', () => {
  const baseline = completeExperiment({ experimentId: 'base' });
  const candidate = completeExperiment({
    experimentId: 'cand',
    datasetVersion: '9.9.9',
  });
  const compared = compareExperiments(baseline, candidate);
  assert.equal(compared.ok, false);
});

test('regression-gate report mode surfaces regressions without hard fail semantics', () => {
  const baseline = completeExperiment({
    experimentId: 'base',
    metrics: {
      meanPenalty: 1,
      categoryCorrectRate: 0.95,
      brandPrecisionSignals: { falsePositives: 0 },
      exactProductSignals: { incorrectExactMatchClaims: 0 },
      abstention: { incorrect: 0 },
      schemaParseFailureRate: 0,
      similarResultRelevance: 0.8,
      commerceLinkValidity: 0.9,
    },
  });
  const candidate = completeExperiment({
    experimentId: 'cand',
    metrics: {
      meanPenalty: 2,
      categoryCorrectRate: 0.5,
      brandPrecisionSignals: { falsePositives: 3 },
      exactProductSignals: { incorrectExactMatchClaims: 2 },
      abstention: { incorrect: 2 },
      schemaParseFailureRate: 0.2,
      similarResultRelevance: 0.4,
      commerceLinkValidity: 0.5,
    },
  });
  const report = runRegressionGate(baseline, candidate, { mode: 'report_only' });
  assert.equal(report.mode, 'report_only');
  assert.equal(report.status, 'report_regression');
  assert.equal(report.blocking, false);
  assert.equal(report.wouldRejectIfBlocking, true);
  assert.ok(report.concernCount > 0);
  assert.ok(GATE_CATEGORIES.includes('core_category_accuracy'));
});

test('no production imports from evaluation paths', () => {
  const productionRoots = [
    path.join(ROOT, 'app'),
    path.join(ROOT, 'services'),
    path.join(ROOT, 'hooks'),
    path.join(ROOT, 'supabase/functions'),
    path.join(ROOT, 'constants'),
  ];
  const banned = [
    'evals/scanner-accuracy',
    'tools/scanner-evaluation',
    'experiments/scanner-accuracy-v2',
    'docs/scanner-accuracy',
  ];
  const offenders = [];

  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(js|jsx|ts|tsx)$/.test(entry.name)) continue;
      // Allow this test file itself under tools/scanner-evaluation.
      if (full.includes(`${path.sep}tools${path.sep}scanner-evaluation${path.sep}`)) continue;
      const text = fs.readFileSync(full, 'utf8');
      for (const needle of banned) {
        if (text.includes(needle)) {
          offenders.push({ file: path.relative(ROOT, full), needle });
        }
      }
    }
  }

  for (const root of productionRoots) walk(root);
  assert.deepEqual(offenders, []);
});
