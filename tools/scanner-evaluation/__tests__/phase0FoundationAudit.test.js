'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runBaseline = require('../run-baseline');
const { verifyFrozenDataset } = require('../lib/frozenDataset');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT;
const MANIFEST = path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json');
const FREEZE = path.join(ROOT, 'evals/scanner-accuracy/tier-a-freeze.v0.3.0.json');

function withStorageRoot(fn) {
  assert.ok(STORAGE_ROOT, 'KSCAN_EVAL_STORAGE_ROOT is required for frozen-dataset tests');
  const previous = process.env.KSCAN_EVAL_STORAGE_ROOT;
  process.env.KSCAN_EVAL_STORAGE_ROOT = STORAGE_ROOT;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.KSCAN_EVAL_STORAGE_ROOT;
    else process.env.KSCAN_EVAL_STORAGE_ROOT = previous;
  }
}

test('active dataset metadata names the governed v0.3.0 freeze', () => {
  const version = require('../../../evals/scanner-accuracy/dataset-version.json');
  assert.equal(version.datasetVersion, '0.3.0');
  assert.equal(version.activeFreeze.manifest, 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json');
  assert.equal(version.activeFreeze.freezeRecord, 'evals/scanner-accuracy/tier-a-freeze.v0.3.0.json');
});

test('frozen verifier reproduces all inputs and all 56 governed image hashes', () => {
  const report = withStorageRoot(() => verifyFrozenDataset(MANIFEST, FREEZE));
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.aggregateSha256, 'ddc939dca91d202c3d0ee306b9421e1d71f1348c1fb8f035097ae91d2972c3db');
  assert.equal(report.caseCount, 41);
  assert.equal(report.imageCount, 56);
  assert.equal(report.imageHashVerified, 56);
  assert.equal(report.development, 33);
  assert.equal(report.holdout, 8);
  assert.equal(report.imagesInGit, 0);
});

test('a changed or non-canonical frozen manifest fails closed', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-freeze-mutation-'));
  const mutatedPath = path.join(temp, 'tier-a-manifest.v0.3.0.json');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  manifest.cases[0].notes = `${manifest.cases[0].notes} mutation`;
  fs.writeFileSync(mutatedPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  const report = withStorageRoot(() => verifyFrozenDataset(mutatedPath, FREEZE));
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.check === 'canonical_manifest'));
});

test('missing governed storage fails frozen verification closed', () => {
  const previous = process.env.KSCAN_EVAL_STORAGE_ROOT;
  delete process.env.KSCAN_EVAL_STORAGE_ROOT;
  try {
    const report = verifyFrozenDataset(MANIFEST, FREEZE);
    assert.equal(report.ok, false);
    assert.ok(report.errors.some((error) => error.check === 'storage_root'));
    assert.equal(report.imageHashVerified, 0);
  } finally {
    if (previous !== undefined) process.env.KSCAN_EVAL_STORAGE_ROOT = previous;
  }
});

test('v0.3.0 dry run verifies the freeze then blocks all drafts with explicit zero-call accounting', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-dry-run-'));
  let adapterInvocations = 0;
  const result = withStorageRoot(() => runBaseline.main([
    '--dry-run',
    '--manifest', 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json',
    '--output-dir', outputDir,
  ], {
    executor: () => { adapterInvocations += 1; },
    now: '2026-07-29T00:00:00.000Z',
  }));
  process.exitCode = 0;
  assert.equal(result.ok, false);
  assert.equal(result.blockedCaseCount, 41);
  assert.equal(result.plannedCallCount, 0);
  assert.equal(result.executedCallCount, 0);
  assert.equal(result.actualProviderCallCount, 0);
  assert.equal(result.unexpectedNetworkAttemptCount, 0);
  assert.equal(result.costUsd, '0.00');
  assert.equal(adapterInvocations, 0);
  assert.equal(fs.existsSync(path.join(outputDir, 'cases')), false);
  assert.deepEqual(result.planDocument.measurementLimits, {
    benchmarkClassification: 'LICENSED-WEB-IMAGE PILOT BENCHMARK',
    notARealWorldSmartGlassesBenchmark: true,
    notAComprehensiveBrandAccuracyCorpus: true,
    positiveBrandSupport: 'EXPLORATORY',
    exactProductPrecision: 'not_measured',
    incorrectExactMatchRate: 'not_measured',
    exactProductMeasurementCeiling: 'MC-1',
  });
});

test('execute mode refuses draft cases without writing a successful execution artifact', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-execute-refusal-'));
  let adapterInvocations = 0;
  // Execution is now split-scoped, so the denominator is the 33 development cases
  // rather than all 41. A run that spanned both splits would break the holdout seal.
  const result = withStorageRoot(() => runBaseline.main([
    '--execute',
    '--manifest', 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json',
    '--output-dir', outputDir,
    '--max-calls', '0',
    '--max-usd', '10.00',
    '--pricing-record', 'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json',
    '--split', 'development',
    '--capture-preparation', 'certified_client_equivalent',
  ], {
    executor: () => { adapterInvocations += 1; },
    now: '2026-07-29T00:00:00.000Z',
  }));
  process.exitCode = 0;
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'preflight');
  assert.equal(result.blockedCaseCount, 33);
  assert.equal(result.executedCallCount, 0);
  assert.equal(adapterInvocations, 0);
  assert.equal(fs.existsSync(path.join(outputDir, 'run-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'baseline-report.json')), false);
});

test('execute mode without an injected adapter is refused before output creation', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-no-adapter-'));
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--execute',
      '--manifest', 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json',
      '--output-dir', outputDir,
      '--max-calls', '0',
    ])),
    /No execution adapter is installed/
  );
  assert.equal(fs.existsSync(path.join(outputDir, 'run-manifest.json')), false);
  assert.equal(fs.existsSync(path.join(outputDir, 'baseline-report.json')), false);
});

test('execute mode requires a valid explicit hard call ceiling', () => {
  assert.throws(() => runBaseline.parseArgs(['--execute', '--max-calls', 'unbounded']), /non-negative integer/);
  assert.throws(() => runBaseline.parseArgs(['--execute', '--max-calls', '-1']), /non-negative integer/);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-no-ceiling-'));
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--execute',
      '--manifest', 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json',
      '--output-dir', outputDir,
    ], { executor: () => ({ observations: [], consolidated: {} }) })),
    /explicit --max-calls ceiling/
  );
});

test('dry-run output collision and cross-version resume state fail closed', () => {
  const collisionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-output-collision-'));
  fs.writeFileSync(path.join(collisionDir, 'dry-run-plan.json'), '{}\n', 'utf8');
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--dry-run',
      '--manifest', 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json',
      '--output-dir', collisionDir,
    ])),
    /output path collision/
  );

  const resumeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0-invalid-resume-'));
  fs.writeFileSync(
    path.join(resumeDir, 'run-manifest.json'),
    `${JSON.stringify({ datasetVersion: '0.2.0' }, null, 2)}\n`,
    'utf8'
  );
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--dry-run',
      '--resume',
      '--manifest', 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json',
      '--output-dir', resumeDir,
    ])),
    /invalid resume state/
  );
});
