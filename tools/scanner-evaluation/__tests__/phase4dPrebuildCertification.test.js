'use strict';

/** Build 4 pre-build wiring certification. All provider transport is mocked. */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const baselineInputSelection = require('../lib/baselineInputSelection');
const build4Funnel = require('../lib/build4Funnel');
const governedStorage = require('../lib/governedStorage');
const imagePreparation = require('../lib/imagePreparation');
const liveAdapter = require('../lib/liveAdapter');
const runnerState = require('../lib/runnerState');

const ROOT = governedStorage.ROOT;
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT || 'C:/Users/jsmit/KScan-eval-storage-private';
const SNAPSHOT_ROOT = path.join(STORAGE_ROOT, 'snapshots', 'certified-v140-f5f4ed2');
const MANIFEST_PATH = path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json');
const MANIFEST = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
const SELECTION = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/execution/baseline-input-selection.v1.json'), 'utf8')
);
const PRICING = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json'), 'utf8')
);
const MANIFEST_SHA256 = baselineInputSelection.sha256Hex(fs.readFileSync(MANIFEST_PATH));

test('selection verification detects selected-ref, hash, provenance and contract-hash mutations', () => {
  const mutations = [
    (artifact) => { artifact.selections[0].selectedRef += '-changed'; },
    (artifact) => { artifact.selections[0].selectedHash = `sha256:${'0'.repeat(64)}`; },
    (artifact) => { artifact.selections[0].nonExecutedRefs = []; },
    (artifact) => { artifact.selectionContractSha256 = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const artifact = structuredClone(SELECTION);
    mutate(artifact);
    assert.equal(
      baselineInputSelection.verifyArtifact(artifact, MANIFEST, { manifestSha256: MANIFEST_SHA256 }).ok,
      false
    );
  }
});

test('certified quota metadata and exhausted fallback produce distinct terminal categories', () => {
  const quota = liveAdapter.classifyOutcome({
    providerAttempts: [{ httpStatus: 429, certifiedFailureKind: 'http_429_quota' }],
  });
  assert.equal(quota.status, 'provider_quota_exhausted');
  assert.equal(quota.retryable, false);

  const exhausted = liveAdapter.classifyOutcome({
    providerAttempts: [
      { httpStatus: 503, certifiedFailureKind: 'http_5xx_transient' },
      { httpStatus: 503, certifiedFailureKind: 'http_5xx_transient' },
    ],
  });
  assert.equal(exhausted.status, 'provider_exhausted');
  assert.equal(exhausted.retryable, false);
});

test('a cached token count cannot survive a governing-identity mutation', () => {
  const outputRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build4-token-cache-'));
  const call = { imageHash: `sha256:${'1'.repeat(64)}` };
  const identity = {
    runId: 'cache-selftest',
    datasetVersion: '0.3.1',
    datasetManifestSha256: 'manifest-a',
    certifiedSnapshotSha256: 'certified-a',
    selectionContractSha256: 'selection-a',
    modelConfigurationId: 'certified-v140',
  };
  const ledger = { countTokens: { requests: 0, successes: 0, failures: 0, cacheHits: 0, cacheMisses: 0 } };
  const countTokens = ({ model }) => ({
    inputTokens: 100,
    serializedRequestPayload: model,
    systemInstructionSha256: 'system',
    promptSha256: 'prompt',
    toolDeclarationsSha256: 'tools',
    generationConfigSha256: 'generation',
  });
  try {
    build4Funnel.tokenCountsForCase({
      outputRoot,
      countTokens,
      caseRecord: { caseId: 'cache-case' },
      call,
      identity,
      ledger,
    });
    assert.throws(
      () => build4Funnel.tokenCountsForCase({
        outputRoot,
        countTokens: () => { throw new Error('mutated identity must not use transport'); },
        caseRecord: { caseId: 'cache-case' },
        call,
        identity: { ...identity, certifiedSnapshotSha256: 'certified-b' },
        ledger,
      }),
      /cache identity differs/
    );
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
  }
});

test('governed manifest entry reaches certified v140, terminal private result and aggregate score', async () => {
  assert.equal(fs.existsSync(SNAPSHOT_ROOT), true, 'certified snapshot is required for the funnel test');
  const selected = SELECTION.selections.find((entry) => entry.caseId === 'set-501xx-jeans');
  assert.equal(selected.imageCount, 2, 'the test must exercise a real multi-image Path B case');
  const caseRecord = MANIFEST.cases.find((entry) => entry.caseId === selected.caseId);
  const sourcePath = governedStorage.resolveImageRef(selected.selectedRef, { storageRoot: STORAGE_ROOT });
  const derivativeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'build4-e2e-derivative-'));
  const outputRoot = governedStorage.privateResultsRoot('build4-e2e-selftest', STORAGE_ROOT);
  fs.rmSync(outputRoot, { recursive: true, force: true });

  try {
    const prepared = await imagePreparation.prepareImage({
      sourcePath,
      expectedSourceSha256: selected.selectedHash,
      viewId: 'path-b-selected',
      derivativeRoot,
    });
    const plan = {
      caseId: caseRecord.caseId,
      imageCount: caseRecord.imageCount,
      multiImageSet: true,
      consolidatedCallEmitted: false,
      plannedCallCount: 1,
      nonExecutedProvenanceImageCount: selected.nonExecutedRefs.length,
      calls: [{
        caseId: caseRecord.caseId,
        imageRef: selected.selectedRef,
        imageHash: selected.selectedHash,
        preparation: prepared,
      }],
    };
    const sourceIdentity = liveAdapter.verifyExecutionSource(SNAPSHOT_ROOT);
    const identity = {
      runId: 'build4-e2e-selftest',
      datasetVersion: MANIFEST.datasetVersion,
      datasetManifestSha256: MANIFEST_SHA256,
      holdoutSealSha256: null,
      sourceCommit: 'audit-selftest',
      certifiedCommit: sourceIdentity.certifiedCommit,
      certifiedBundleHash: sourceIdentity.bundleHash,
      certifiedSnapshotSha256: sourceIdentity.closureAggregateSha256,
      selectionContractSha256: SELECTION.selectionContractSha256,
      modelConfigurationId: 'certified-v140',
    };
    let tokenCalls = 0;
    let generationCalls = 0;
    const countTokens = ({ model, call }) => {
      tokenCalls += 1;
      return {
        inputTokens: model === build4Funnel.PRIMARY_MODEL ? 1234 : 1201,
        serializedRequestPayload: JSON.stringify({ model, imageSha256: call.imageHash, evidenceCount: 1 }),
        systemInstructionSha256: 'system-v140',
        promptSha256: 'prompt-v140',
        toolDeclarationsSha256: 'none',
        generationConfigSha256: 'generation-v140',
      };
    };
    const executeAdapter = () => {
      generationCalls += 1;
      const out = path.join(outputRoot, 'harness-report.json');
      execFileSync('deno', [
        'run',
        `--allow-read=${SNAPSHOT_ROOT},${path.join(ROOT, 'tools/scanner-evaluation/adapter/deno')},${derivativeRoot}`,
        `--allow-write=${outputRoot}`,
        '--allow-env',
        '--no-lock',
        'tools/scanner-evaluation/adapter/deno/certifiedHarness.ts',
        '--cert-root', SNAPSHOT_ROOT,
        '--scenario', 'completed',
        '--image-file', prepared.derivativePath,
        '--image-width', String(prepared.derivativeWidth),
        '--image-height', String(prepared.derivativeHeight),
        '--case-id', caseRecord.caseId,
        '--out', out,
      ], { cwd: ROOT, stdio: 'pipe' });
      return JSON.parse(fs.readFileSync(out, 'utf8'));
    };

    const report = build4Funnel.executeGovernedRun({
      manifest: MANIFEST,
      manifestSha256: MANIFEST_SHA256,
      selectionArtifact: SELECTION,
      cases: [caseRecord],
      plans: [plan],
      outputRoot,
      storageRoot: STORAGE_ROOT,
      runIdentityRecord: identity,
      pricing: PRICING,
      spendCeilingUsd: 10,
      attemptCeiling: 2,
      countTokens,
      executeAdapter,
    });
    assert.equal(tokenCalls, 2, 'primary and fallback countTokens are model-specific');
    assert.equal(generationCalls, 1, 'one governed case emits exactly one certified scanner request');
    assert.equal(report.completedCaseCount, 1);
    assert.equal(report.scoredCaseCount, 1);
    assert.equal(report.reservation.primaryReservationsConfirmed, 1);
    assert.equal(report.reservation.fallbackReservationsReleasedUnused, 1);

    const result = runnerState.readCaseResult(outputRoot, caseRecord.caseId);
    assert.equal(result.status, 'provider_success');
    assert.equal(result.parseStatus, 'parsed');
    assert.equal(result.validation.ok, true);
    assert.equal(result.observed.contractVersion, 'fashion-identification-v2');
    assert.equal(result.observed.requestId, 'harness-request-0001');
    assert.equal(result.scoreability, 'scoreable');
    assert.equal(result.countTokens.primaryRequestIdentity === result.countTokens.fallbackRequestIdentity, false);
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('rawPayload'), false);
    assert.equal(/[A-Za-z]:\\/.test(serialized), false, 'private result must not contain an absolute path');
    assert.equal(fs.existsSync(path.join(outputRoot, 'baseline-report.json')), true);
    const retention = JSON.parse(fs.readFileSync(path.join(outputRoot, 'retention.json'), 'utf8'));
    assert.equal(Number.isNaN(Date.parse(retention.expiresAt)), false);

    const resumed = build4Funnel.executeGovernedRun({
      manifest: MANIFEST,
      manifestSha256: MANIFEST_SHA256,
      selectionArtifact: SELECTION,
      cases: [caseRecord],
      plans: [plan],
      outputRoot,
      storageRoot: STORAGE_ROOT,
      runIdentityRecord: identity,
      pricing: PRICING,
      spendCeilingUsd: 10,
      attemptCeiling: 2,
      countTokens: () => { throw new Error('resume duplicated countTokens'); },
      executeAdapter: () => { throw new Error('resume duplicated generation'); },
      resume: true,
    });
    assert.deepEqual(resumed.skippedAlreadyComplete, [caseRecord.caseId]);
    assert.equal(resumed.completedCaseCount, 1);
    assert.equal(resumed.reservation.primaryReservationsConfirmed, report.reservation.primaryReservationsConfirmed);
    assert.equal(resumed.reservation.fallbackReservationsReleasedUnused, report.reservation.fallbackReservationsReleasedUnused);
    assert.equal(resumed.reservation.totalGenerateAttempts, report.reservation.totalGenerateAttempts);
    assert.equal(resumed.reservation.totalAccountedUsd, report.reservation.totalAccountedUsd);
  } finally {
    fs.rmSync(outputRoot, { recursive: true, force: true });
    fs.rmSync(derivativeRoot, { recursive: true, force: true });
  }
});
