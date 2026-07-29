'use strict';

/**
 * Phase 1 execution-gate regression coverage.
 *
 * Each test below pins one gate that Phase 1 requires and that the runner either
 * lacked entirely or enforced against the wrong quantity. They are deliberately
 * narrow: one gate, one failure mode, one assertion about the refusal.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const runBaseline = require('../run-baseline');
const capturePreparation = require('../lib/capturePreparation');
const costLedger = require('../lib/costLedger');
const runIdentity = require('../lib/runIdentity');
const providerAccounting = require('../lib/providerAccounting');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT;
const MANIFEST_REL = 'evals/scanner-accuracy/tier-a-manifest.v0.3.0.json';
const PRICING_REL = 'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json';
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));
const PRICING = JSON.parse(fs.readFileSync(path.join(ROOT, PRICING_REL), 'utf8'));

function withStorageRoot(fn) {
  assert.ok(STORAGE_ROOT, 'KSCAN_EVAL_STORAGE_ROOT is required for Phase 1 gate tests');
  const previous = process.env.KSCAN_EVAL_STORAGE_ROOT;
  process.env.KSCAN_EVAL_STORAGE_ROOT = STORAGE_ROOT;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.KSCAN_EVAL_STORAGE_ROOT;
    else process.env.KSCAN_EVAL_STORAGE_ROOT = previous;
  }
}

function tempDir(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase1-${label}-`));
}

// ── Capture preparation and the certified payload ceiling ────────────────────

test('the certified payload constants match the certified v140 source', (t) => {
  const certRoot = process.env.KSCAN_CERT_V140_ROOT;
  if (!certRoot) {
    t.skip('KSCAN_CERT_V140_ROOT not set; transcription re-derivation skipped');
    return;
  }
  const verification = capturePreparation.verifyAgainstCertifiedSource(certRoot);
  assert.equal(verification.ok, true, JSON.stringify(verification.mismatches));
});

test('base64 length is measured in base64 space, not decoded bytes', () => {
  // The certified guard compares the length of the base64 STRING. Measuring the
  // decoded size instead under-counts by a third and lets oversized payloads pass.
  assert.equal(capturePreparation.base64Length(3), 4);
  assert.equal(capturePreparation.base64Length(1_500_000), 2_000_000);
  assert.ok(capturePreparation.base64Length(1_600_000) > capturePreparation.CERTIFIED_CONTRACT.maxImageBase64Bytes);
  assert.throws(() => capturePreparation.base64Length(-1), /non-negative/);
});

test('an absent capture-preparation stage fails closed', () => {
  const evaluation = capturePreparation.evaluateImage({ byteLength: 100 }, {});
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.findings.some((f) => f.check === 'capture_preparation_absent'));
  assert.equal(evaluation.mode, capturePreparation.MODE_ABSENT);
});

test('posting governed originals is rejected as not production-equivalent', () => {
  const evaluation = capturePreparation.evaluateImage(
    { byteLength: 100 },
    { mode: capturePreparation.MODE_GOVERNED_ORIGINAL }
  );
  assert.equal(evaluation.ok, false);
  assert.ok(evaluation.findings.some((f) => f.check === 'capture_preparation_not_production_equivalent'));
});

test('a payload over the certified ceiling is blocked before any provider call', () => {
  const oversized = capturePreparation.CERTIFIED_CONTRACT.maxImageBase64Bytes; // raw bytes -> 4/3 in base64
  const evaluation = capturePreparation.evaluateImage(
    { byteLength: oversized, refValue: 'storage://bucket/tier-a/case/primary' },
    { mode: capturePreparation.MODE_CERTIFIED_CLIENT_EQUIVALENT }
  );
  assert.equal(evaluation.ok, false);
  const finding = evaluation.findings.find((f) => f.check === 'certified_payload_ceiling');
  assert.ok(finding, 'the certified ceiling must be enforced');
  assert.ok(finding.base64Length > finding.ceiling);
});

test('an unknown capture-preparation mode is rejected rather than defaulted', () => {
  assert.throws(
    () => capturePreparation.resolveMode('resize_however'),
    /unknown capture preparation mode/
  );
  assert.throws(
    () => runBaseline.parseArgs(['--capture-preparation', 'whatever']),
    /unknown capture preparation mode/
  );
});

test('the frozen corpus is measured against the certified ceiling with real denominators', () => {
  // The finding this pins: 25 of 56 governed images exceed the certified ceiling,
  // so a run without a preparation stage would report them as Scanner failures.
  const images = [];
  for (const caseRecord of MANIFEST.cases) {
    for (const ref of caseRecord.imageReferences) {
      const resolved = withStorageRoot(() => {
        const parts = ref.refValue.replace(/^[a-z0-9+.-]+:\/\//i, '').split('/').filter(Boolean);
        const idx = parts.findIndex((p) => p === 'tier-a');
        const tail = idx >= 0 ? parts.slice(idx + 1) : parts.slice(1);
        const candidate = path.join(STORAGE_ROOT, ...tail);
        for (const ext of ['', '.jpg', '.jpeg', '.png']) {
          if (fs.existsSync(candidate + ext)) return candidate + ext;
        }
        return null;
      });
      assert.ok(resolved, `governed image must resolve: ${ref.refValue}`);
      images.push({ byteLength: fs.statSync(resolved).size });
    }
  }
  const summary = capturePreparation.summarize(images, {
    mode: capturePreparation.MODE_CERTIFIED_CLIENT_EQUIVALENT,
  });
  assert.equal(summary.imageCount, 56);
  assert.equal(summary.imagesOverCertifiedCeiling, 25);
  assert.equal(summary.imagesWithinCertifiedCeiling, 31);
  assert.equal(summary.certifiedCeiling, 2 * 1024 * 1024);
});

// ── Spend ceiling and verified pricing ──────────────────────────────────────

test('a missing, malformed or negative spend ceiling fails closed', () => {
  for (const ceiling of [undefined, null, -1, Number.NaN, '10']) {
    assert.throws(
      () => new costLedger.CostLedger({ ceilingUsd: ceiling, pricing: PRICING }),
      /non-negative dollar ceiling/,
      `ceiling ${String(ceiling)} must be refused`
    );
  }
});

test('pricing without a source or retrieval timestamp is refused', () => {
  assert.equal(costLedger.validatePricing(null).ok, false);
  const noSource = costLedger.validatePricing({ retrievedAt: '2026-07-29T00:00:00.000Z', models: PRICING.models });
  assert.equal(noSource.ok, false);
  assert.ok(noSource.errors.some((e) => e.check === 'pricing_source'));

  const noStamp = costLedger.validatePricing({ source: 'x', models: PRICING.models });
  assert.equal(noStamp.ok, false);
  assert.ok(noStamp.errors.some((e) => e.check === 'pricing_retrieved_at'));

  const badRate = costLedger.validatePricing({
    source: 'x',
    retrievedAt: '2026-07-29T00:00:00.000Z',
    models: { 'gemini-3.6-flash': { inputPerMillionUsd: -1, outputPerMillionUsd: 7.5 } },
  });
  assert.equal(badRate.ok, false);
  assert.ok(badRate.errors.some((e) => e.check === 'pricing_rate'));
});

test('the verified pricing record is well-formed and prices both certified models', () => {
  assert.equal(costLedger.validatePricing(PRICING).ok, true);
  assert.equal(PRICING.models['gemini-3.6-flash'].inputPerMillionUsd, 1.5);
  assert.equal(PRICING.models['gemini-3.6-flash'].outputPerMillionUsd, 7.5);
  assert.equal(PRICING.models['gemini-3.5-flash-lite'].inputPerMillionUsd, 0.3);
  assert.equal(PRICING.models['gemini-3.5-flash-lite'].outputPerMillionUsd, 2.5);
});

test('an unpriced model cannot be charged for and therefore cannot be called', () => {
  const ledger = new costLedger.CostLedger({ ceilingUsd: 10, pricing: PRICING });
  assert.throws(
    () => ledger.authorize('gemini-9.9-imaginary', { inputTokens: 10, maxOutputTokens: 10 }),
    /has no verified price/
  );
});

test('an attempt that would breach the dollar ceiling is refused before it is made', () => {
  const ledger = new costLedger.CostLedger({ ceilingUsd: 0.02, pricing: PRICING });
  const usage = { inputTokens: 2532, maxOutputTokens: 2048 };
  // First attempt fits.
  const authorized = ledger.authorize('gemini-3.6-flash', usage);
  assert.ok(authorized.projectedUsd <= 0.02);
  ledger.charge('gemini-3.6-flash', usage);
  // Second would breach, and is refused rather than charged.
  assert.throws(
    () => ledger.authorize('gemini-3.6-flash', usage),
    costLedger.CostCeilingExceeded
  );
  assert.equal(ledger.entries.length, 1, 'the refused attempt must not be charged');
});

test('cumulative cost and remaining budget are recorded after every attempt', () => {
  const ledger = new costLedger.CostLedger({ ceilingUsd: 10, pricing: PRICING });
  const usage = { inputTokens: 1000, maxOutputTokens: 1000 };
  const first = ledger.charge('gemini-3.6-flash', usage, { caseId: 'a' });
  const second = ledger.charge('gemini-3.5-flash-lite', usage, { caseId: 'b' });
  assert.ok(second.cumulativeUsd > first.cumulativeUsd);
  assert.equal(
    Number((second.cumulativeUsd + second.remainingUsd).toFixed(6)),
    10,
    'cumulative plus remaining must equal the ceiling'
  );
  // Flash-Lite is cheaper than Flash for identical usage.
  assert.ok(second.costUsd < first.costUsd);
});

test('the run projection bounds worst case across the full attempt budget', () => {
  const projection = costLedger.projectRun({
    callCount: 47,
    attemptsPerCall: 2,
    primaryModel: 'gemini-3.6-flash',
    fallbackModel: 'gemini-3.5-flash-lite',
    perCall: { inputTokens: 2532, maxOutputTokens: 2048 },
    fallbackPerCall: { inputTokens: 2532, maxOutputTokens: 2048 },
    pricing: PRICING,
    ceilingUsd: 10,
  });
  assert.equal(projection.ok, true);
  assert.equal(projection.maxAttemptCount, 94);
  assert.ok(projection.worstCaseUsd > projection.expectedUsd);
  assert.equal(projection.withinCeiling, true);
  assert.equal(projection.pricingSource, PRICING.source);
});

test('execute mode requires an explicit spend ceiling and a verified pricing record', () => {
  const outputDir = tempDir('no-spend-ceiling');
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--execute',
      '--manifest', MANIFEST_REL,
      '--output-dir', outputDir,
      '--max-calls', '10',
    ], { executor: () => ({ observations: [], consolidated: {} }) })),
    /explicit --max-usd spend ceiling/
  );

  const second = tempDir('no-pricing');
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--execute',
      '--manifest', MANIFEST_REL,
      '--output-dir', second,
      '--max-calls', '10',
      '--max-usd', '10',
    ], { executor: () => ({ observations: [], consolidated: {} }) })),
    /--pricing-record/
  );
});

test('a negative or malformed --max-usd is rejected at parse time', () => {
  assert.throws(() => runBaseline.parseArgs(['--max-usd', '-0.01']), /non-negative number/);
  assert.throws(() => runBaseline.parseArgs(['--max-usd', 'ten']), /non-negative number/);
});

// ── Development / holdout isolation and the holdout seal ─────────────────────

test('execute mode requires an explicit split, so no run spans both', () => {
  const outputDir = tempDir('no-split');
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--execute',
      '--manifest', MANIFEST_REL,
      '--output-dir', outputDir,
      '--max-calls', '10',
      '--max-usd', '10',
      '--pricing-record', PRICING_REL,
    ], { executor: () => ({ observations: [], consolidated: {} }) })),
    /--split development\|holdout/
  );
});

test('an unknown split is refused at parse time', () => {
  assert.throws(() => runBaseline.parseArgs(['--split', 'both']), /--split must be one of/);
  assert.throws(() => runBaseline.parseArgs(['--split', 'test']), /--split must be one of/);
});

test('the frozen split partitions all 41 cases with none unassigned', () => {
  const partition = runIdentity.partitionBySplit(MANIFEST.cases, MANIFEST.split);
  assert.equal(partition.development.length, 33);
  assert.equal(partition.holdout.length, 8);
  assert.deepEqual(partition.unassigned, []);
  const overlap = partition.development.filter((c) => partition.holdout.includes(c));
  assert.deepEqual(overlap, [], 'development and holdout must be disjoint');
});

test('a development run selects only development cases', () => {
  const outputDir = tempDir('dev-scope');
  const result = withStorageRoot(() => runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
  ], { now: '2026-07-29T00:00:00.000Z' }));
  process.exitCode = 0;
  assert.equal(result.selectedCaseCount, 33);
  const holdoutIds = new Set(MANIFEST.split.holdout);
  const leaked = result.blocked.filter((b) => holdoutIds.has(b.caseId));
  assert.deepEqual(leaked, [], 'no holdout case may appear in a development run');
});

test('a holdout run without a seal record is refused', () => {
  const outputDir = tempDir('unsealed-holdout');
  const result = withStorageRoot(() => runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'holdout',
  ], { now: '2026-07-29T00:00:00.000Z' }));
  process.exitCode = 0;
  assert.equal(result.ok, false);
  assert.equal(result.stage, 'holdout_seal');
  assert.ok(result.errors.some((e) => e.check === 'holdout_seal_present'));
});

test('a holdout seal is invalidated by any post-seal label change', () => {
  const partition = runIdentity.partitionBySplit(MANIFEST.cases, MANIFEST.split);
  const holdout = partition.holdout;
  const seal = {
    sealedAt: '2026-07-29T00:00:00.000Z',
    reviewerACompletedAt: '2026-07-29T00:00:00.000Z',
    reviewerBCompletedAt: '2026-07-29T00:00:00.000Z',
    adjudicationCompletedAt: '2026-07-29T00:00:00.000Z',
    reviewArtifactSha256: 'a'.repeat(64),
    holdoutCaseIds: holdout.map((c) => c.caseId),
    lockedLabelSha256: runIdentity.lockedLabelHash(holdout),
  };
  assert.equal(runIdentity.verifyHoldoutSeal(seal, holdout).ok, true);

  // Editing a ground-truth label invalidates the seal.
  const tampered = holdout.map((c, i) => (i === 0 ? { ...c, primaryColor: 'chartreuse' } : c));
  const afterEdit = runIdentity.verifyHoldoutSeal(seal, tampered);
  assert.equal(afterEdit.ok, false);
  assert.ok(afterEdit.errors.some((e) => e.check === 'holdout_seal_labels'));

  // Editing a non-label note does NOT invalidate it.
  const noteOnly = holdout.map((c, i) => (i === 0 ? { ...c, notes: 'reworded' } : c));
  assert.equal(runIdentity.verifyHoldoutSeal(seal, noteOnly).ok, true);
});

test('a holdout seal that omits either reviewer or adjudication is refused', () => {
  const partition = runIdentity.partitionBySplit(MANIFEST.cases, MANIFEST.split);
  const holdout = partition.holdout;
  const base = {
    sealedAt: '2026-07-29T00:00:00.000Z',
    reviewerACompletedAt: '2026-07-29T00:00:00.000Z',
    reviewerBCompletedAt: '2026-07-29T00:00:00.000Z',
    adjudicationCompletedAt: '2026-07-29T00:00:00.000Z',
    reviewArtifactSha256: 'a'.repeat(64),
    holdoutCaseIds: holdout.map((c) => c.caseId),
    lockedLabelSha256: runIdentity.lockedLabelHash(holdout),
  };
  for (const omitted of ['reviewerACompletedAt', 'reviewerBCompletedAt', 'adjudicationCompletedAt']) {
    const seal = { ...base };
    delete seal[omitted];
    const verified = runIdentity.verifyHoldoutSeal(seal, holdout);
    assert.equal(verified.ok, false, `${omitted} must be required`);
    assert.ok(verified.errors.some((e) => e.check === 'holdout_seal_completeness'));
  }
});

test('a holdout seal taken against a different dataset aggregate is refused', () => {
  const partition = runIdentity.partitionBySplit(MANIFEST.cases, MANIFEST.split);
  const holdout = partition.holdout;
  const seal = {
    sealedAt: '2026-07-29T00:00:00.000Z',
    reviewerACompletedAt: '2026-07-29T00:00:00.000Z',
    reviewerBCompletedAt: '2026-07-29T00:00:00.000Z',
    adjudicationCompletedAt: '2026-07-29T00:00:00.000Z',
    reviewArtifactSha256: 'a'.repeat(64),
    datasetAggregateSha256: 'b'.repeat(64),
    holdoutCaseIds: holdout.map((c) => c.caseId),
    lockedLabelSha256: runIdentity.lockedLabelHash(holdout),
  };
  const verified = runIdentity.verifyHoldoutSeal(seal, holdout, { datasetAggregateSha256: 'c'.repeat(64) });
  assert.equal(verified.ok, false);
  assert.ok(verified.errors.some((e) => e.check === 'holdout_seal_dataset'));
});

// ── Run identity and resume ─────────────────────────────────────────────────

test('a run identifier carries dataset, adapter, timestamp, sha, split and mode', () => {
  const runId = runIdentity.buildRunId({
    datasetVersion: '0.3.0',
    adapterId: 'v140',
    timestamp: '2026-07-29T13:45:00.000Z',
    mode: 'execute',
    researchSha: '4c398e4fb7ae9b34caa7971859f22aa70c63703f',
    split: 'development',
  });
  assert.match(runId, /^baseline-v0\.3\.0-v140-\d{8}-\d{4}-4c398e4-development-exec$/);
  for (const field of ['datasetVersion', 'adapterId', 'timestamp', 'mode', 'researchSha', 'split']) {
    const parts = {
      datasetVersion: '0.3.0',
      adapterId: 'v140',
      timestamp: '2026-07-29T13:45:00.000Z',
      mode: 'execute',
      researchSha: 'abcdef1234',
      split: 'development',
    };
    delete parts[field];
    assert.throws(() => runIdentity.buildRunId(parts), new RegExp(field));
  }
});

test('a run identifier rejects an unknown split', () => {
  assert.throws(
    () => runIdentity.buildRunId({
      datasetVersion: '0.3.0',
      adapterId: 'v140',
      timestamp: '2026-07-29T13:45:00.000Z',
      mode: 'execute',
      researchSha: 'abcdef1',
      split: 'everything',
    }),
    /split must be one of/
  );
});

test('resume rejects a change to any field that changes what a result means', () => {
  const prior = {
    runId: 'baseline-v0.3.0-v140-20260729-1345-4c398e4-development-exec',
    datasetVersion: '0.3.0',
    datasetAggregateSha256: 'agg',
    adapterId: 'v140',
    certifiedBundleSha256: 'bundle',
    split: 'development',
    scoringContractVersion: '0.2.0',
    capturePreparationMode: 'certified_client_equivalent',
    hardCallCeiling: 100,
    spendCeilingUsd: 10,
  };
  assert.equal(runIdentity.assertResumable(prior, { ...prior }).ok, true);

  for (const [field, changed] of Object.entries({
    datasetVersion: '0.3.1',
    datasetAggregateSha256: 'different',
    adapterId: 'v141',
    certifiedBundleSha256: 'other',
    split: 'holdout',
    scoringContractVersion: '0.3.0',
    capturePreparationMode: 'governed_original',
    hardCallCeiling: 200,
    spendCeilingUsd: 25,
  })) {
    assert.throws(
      () => runIdentity.assertResumable(prior, { ...prior, [field]: changed }),
      new RegExp(field),
      `${field} must invalidate a resume`
    );
  }
});

test('resume against a fresh output directory is permitted as a first run', () => {
  const result = runIdentity.assertResumable(null, { datasetVersion: '0.3.0' });
  assert.equal(result.ok, true);
  assert.equal(result.firstRun, true);
});

test('cross-version resume is still rejected through the runner', () => {
  const resumeDir = tempDir('cross-version-resume');
  fs.writeFileSync(
    path.join(resumeDir, 'run-manifest.json'),
    `${JSON.stringify({ runId: 'prior', datasetVersion: '0.2.0' }, null, 2)}\n`,
    'utf8'
  );
  assert.throws(
    () => withStorageRoot(() => runBaseline.main([
      '--dry-run',
      '--manifest', MANIFEST_REL,
      '--output-dir', resumeDir,
      '--resume',
      '--split', 'development',
    ], { now: '2026-07-29T00:00:00.000Z' })),
    /invalid resume state/
  );
});

// ── Provider-attempt accounting ─────────────────────────────────────────────

test('a provider-attempt ceiling is required and validated', () => {
  assert.throws(() => new providerAccounting.ProviderAccount({}), /ceiling is required/);
  assert.throws(() => new providerAccounting.ProviderAccount({ maxAttempts: -1 }), /non-negative integer/);
  assert.throws(() => new providerAccounting.ProviderAccount({ maxAttempts: 1.5 }), /non-negative integer/);
});

test('the ceiling bounds provider ATTEMPTS, so retries and fallbacks cannot exceed it', () => {
  // The defect this pins: budget was consumed once per planned call, so the
  // certified two-attempt route could double real provider usage invisibly.
  const account = new providerAccounting.ProviderAccount({ maxAttempts: 2 });
  account.recordRouteInvocation();
  account.authorizeAttempt();
  account.recordProviderAttempt({
    model: 'gemini-3.6-flash', attemptIndex: 1, isFallback: false, outcome: 'failed_retryable', latencyMs: 12,
  });
  account.authorizeAttempt();
  account.recordProviderAttempt({
    model: 'gemini-3.5-flash-lite', attemptIndex: 2, isFallback: true, outcome: 'ok', latencyMs: 20,
  });
  assert.equal(account.counters.providerAttempts, 2);
  assert.equal(account.counters.fallbackAttempts, 1);
  assert.equal(account.counters.primaryAttempts, 1);
  assert.equal(account.remainingAttempts(), 0);
  assert.throws(() => account.authorizeAttempt(), providerAccounting.AttemptCeilingExceeded);
});

test('a mock route invocation is not counted as a provider call', () => {
  const account = new providerAccounting.ProviderAccount({ maxAttempts: 10 });
  account.recordRouteInvocation({ mock: true });
  account.recordRouteInvocation({ mock: true });
  assert.equal(account.counters.routeInvocations, 2);
  assert.equal(account.counters.mockRouteInvocations, 2);
  assert.equal(account.counters.providerAttempts, 0, 'a mock must never register as provider usage');
  assert.equal(account.summary().fallback.rate, 0);
});

test('logical calls, provider attempts, fallbacks and retries are counted separately', () => {
  const account = new providerAccounting.ProviderAccount({ maxAttempts: 10 });
  account.recordRouteInvocation();
  account.authorizeAttempt();
  account.recordProviderAttempt({
    model: 'gemini-3.6-flash', attemptIndex: 1, isFallback: false, isRetry: false, outcome: 'failed_retryable', latencyMs: 5,
  });
  account.authorizeAttempt();
  account.recordProviderAttempt({
    model: 'gemini-3.6-flash', attemptIndex: 2, isFallback: false, isRetry: true, outcome: 'ok', latencyMs: 7,
  });
  account.recordCallOutcome(true);
  const summary = account.summary();
  assert.equal(summary.routeInvocations, 1);
  assert.equal(summary.providerAttempts, 2);
  assert.equal(summary.retries, 1);
  assert.equal(summary.fallbackAttempts, 0);
  assert.equal(summary.completedCalls, 1);
  assert.equal(summary.failedCalls, 0);
  assert.equal(summary.fallback.denominator, 1, 'fallback rate denominator must be stated');
});

test('an unknown attempt outcome or negative latency is rejected', () => {
  const account = new providerAccounting.ProviderAccount({ maxAttempts: 5 });
  assert.throws(
    () => account.recordProviderAttempt({ model: 'm', attemptIndex: 1, outcome: 'probably_fine', latencyMs: 1 }),
    /unknown provider attempt outcome/
  );
  assert.throws(
    () => account.recordProviderAttempt({ model: 'm', attemptIndex: 1, outcome: 'ok', latencyMs: -1 }),
    /latencyMs must be a non-negative/
  );
});

test('the attempt ledger records no prompt, payload, token or credential', () => {
  const account = new providerAccounting.ProviderAccount({ maxAttempts: 5 });
  account.authorizeAttempt();
  account.recordProviderAttempt({
    caseId: 'case-1',
    imageRef: 'storage://bucket/tier-a/case-1/primary',
    model: 'gemini-3.6-flash',
    attemptIndex: 1,
    isFallback: false,
    outcome: 'ok',
    latencyMs: 9,
  });
  const serialized = JSON.stringify(account.attempts);
  for (const key of ['prompt', 'imageBase64', 'base64', 'apiKey', 'key=', 'GEMINI']) {
    assert.equal(serialized.includes(key), false, `attempt ledger must not carry ${key}`);
  }
  assert.deepEqual(Object.keys(account.attempts[0]).sort(), [
    'attemptIndex', 'caseId', 'imageRef', 'isFallback', 'isRetry', 'latencyMs', 'model', 'outcome',
  ]);
});

test('latency distribution reports real quantiles and an explicit empty state', () => {
  const empty = new providerAccounting.ProviderAccount({ maxAttempts: 5 });
  assert.deepEqual(empty.latencyDistribution(), {
    count: 0, minMs: null, p50Ms: null, p95Ms: null, maxMs: null, meanMs: null,
  });

  const account = new providerAccounting.ProviderAccount({ maxAttempts: 100 });
  for (const latencyMs of [10, 20, 30, 40, 1000]) {
    account.authorizeAttempt();
    account.recordProviderAttempt({
      model: 'gemini-3.6-flash', attemptIndex: 1, isFallback: false, outcome: 'ok', latencyMs,
    });
  }
  const distribution = account.latencyDistribution();
  assert.equal(distribution.count, 5);
  assert.equal(distribution.minMs, 10);
  assert.equal(distribution.maxMs, 1000);
  assert.equal(distribution.p50Ms, 30);
});

// ── Emergency stop and boundary properties ──────────────────────────────────

test('an unexpected network attempt is recorded as an emergency-stop signal', () => {
  const account = new providerAccounting.ProviderAccount({ maxAttempts: 5 });
  assert.equal(account.counters.unexpectedNetworkAttempts, 0);
  account.recordUnexpectedNetworkAttempt();
  assert.equal(account.summary().unexpectedNetworkAttempts, 1);
});

test('a dry run against the frozen corpus makes zero provider calls and costs nothing', () => {
  const outputDir = tempDir('zero-spend-dry-run');
  const result = withStorageRoot(() => runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
    '--pricing-record', PRICING_REL,
  ], {
    executor: () => { throw new Error('a dry run must never reach the executor'); },
    now: '2026-07-29T00:00:00.000Z',
  }));
  process.exitCode = 0;
  assert.equal(result.actualProviderCallCount, 0);
  assert.equal(result.fallbackAttemptCount, 0);
  assert.equal(result.retryCount, 0);
  assert.equal(result.unexpectedNetworkAttemptCount, 0);
  assert.equal(result.adapterInvoked, false);
  assert.equal(result.costUsd, '0.00');
  assert.equal(fs.existsSync(path.join(outputDir, 'cases')), false, 'a dry run writes no case results');
});

test('the review gate blocks every frozen case while reviewStatus is draft', () => {
  // The Phase 1 blocker, pinned so a future change cannot silently open it.
  const drafts = MANIFEST.cases.filter((c) => c.reviewStatus !== 'approved');
  assert.equal(drafts.length, 41, 'all 41 cases are still draft; paid execution stays blocked');

  const outputDir = tempDir('review-gate');
  const result = withStorageRoot(() => runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
    '--capture-preparation', 'certified_client_equivalent',
  ], { now: '2026-07-29T00:00:00.000Z' }));
  process.exitCode = 0;
  assert.equal(result.ok, false);
  assert.equal(result.blockedCaseCount, 33);
  assert.ok(result.blocked.every((b) => b.findings.some((f) => f.check === 'review_status')));
});

test('exact-product suppression and pilot limitations propagate into the plan', () => {
  const outputDir = tempDir('limitations');
  const result = withStorageRoot(() => runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
  ], { now: '2026-07-29T00:00:00.000Z' }));
  process.exitCode = 0;
  const limits = result.planDocument.measurementLimits;
  assert.equal(limits.exactProductPrecision, 'not_measured');
  assert.equal(limits.incorrectExactMatchRate, 'not_measured');
  assert.equal(limits.exactProductMeasurementCeiling, 'MC-1');
  assert.equal(limits.benchmarkClassification, 'LICENSED-WEB-IMAGE PILOT BENCHMARK');
  assert.equal(limits.notARealWorldSmartGlassesBenchmark, true);
  assert.equal(limits.notAComprehensiveBrandAccuracyCorpus, true);
  assert.equal(limits.positiveBrandSupport, 'EXPLORATORY');
});

test('no production endpoint or production credential appears in the evaluation path', () => {
  const evalDir = path.join(ROOT, 'tools/scanner-evaluation');
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        // The scan covers the RUNNABLE harness. `__tests__` is excluded because a
        // test that asserts a host is absent must be able to name that host, and
        // `deno` holds vendored certified-source material, not runner code.
        if (entry.name === 'deno' || entry.name === '__tests__') continue;
        walk(full);
        continue;
      }
      if (!/\.(js|json)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      // A literal provider endpoint or a real project ref in the runner path would
      // mean the harness can reach production without an injected adapter.
      if (/generativelanguage\.googleapis\.com/.test(source)
        || /wyyuqfdxucjksghsmhry/.test(source)
        || /\.supabase\.co\/functions/.test(source)) {
        offenders.push(path.relative(ROOT, full).replace(/\\/g, '/'));
      }
    }
  };
  walk(evalDir);
  assert.deepEqual(offenders, [], 'the evaluation path must contain no production endpoint or project reference');
});
