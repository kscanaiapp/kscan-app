'use strict';

/**
 * Live evaluation adapter — fail-closed behaviour.
 *
 * Every test here runs with ZERO provider calls. The adapter is exercised
 * through its preflight gates and its sanitized record builder; the certified
 * scanner half runs in Deno and is covered by the existing mock-adapter suite.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const live = require('../lib/liveAdapter');
const certifiedSnapshot = require('../lib/certifiedSnapshot');
const { ROOT } = require('../lib/governedStorage');

// KSCAN_EVAL_STORAGE_ROOT is the root CONTAINING tier-a/ and results/.
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT || 'C:/Users/jsmit/KScan-eval-storage-private';
const PRIVATE_AREA = path.resolve(STORAGE_ROOT);

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json'), 'utf8')
);
const SEAL = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/review/holdout-seal.v0.3.1.json'), 'utf8')
);

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `kscan-live-${name}-`));

// ── Ceilings ────────────────────────────────────────────────────────────────

test('an absent attempt ceiling blocks paid execution', () => {
  assert.throws(
    () => live.readCeilings({ KSCAN_EVAL_SPEND_CEILING_USD: '10' }),
    (e) => e instanceof live.PreflightRefused && e.gate === 'attempt_ceiling'
  );
});

test('an absent spend ceiling blocks paid execution', () => {
  assert.throws(
    () => live.readCeilings({ KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS: '200' }),
    (e) => e instanceof live.PreflightRefused && e.gate === 'spend_ceiling'
  );
});

test('a zero or negative ceiling is refused, not treated as unlimited', () => {
  for (const env of [
    { KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS: '0', KSCAN_EVAL_SPEND_CEILING_USD: '10' },
    { KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS: '200', KSCAN_EVAL_SPEND_CEILING_USD: '0' },
    { KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS: '-1', KSCAN_EVAL_SPEND_CEILING_USD: '10' },
  ]) {
    assert.throws(() => live.readCeilings(env), live.PreflightRefused);
  }
});

test('valid ceilings are accepted', () => {
  const c = live.readCeilings({ KSCAN_EVAL_MAX_PROVIDER_ATTEMPTS: '200', KSCAN_EVAL_SPEND_CEILING_USD: '10.00' });
  assert.deepStrictEqual(c, { maxAttempts: 200, maxUsd: 10 });
});

// ── Credential ──────────────────────────────────────────────────────────────

test('an absent credential fails closed', () => {
  assert.throws(
    () => live.requireCredential({}),
    (e) => e instanceof live.PreflightRefused && e.gate === 'credential'
  );
  assert.throws(() => live.requireCredential({ GEMINI_API_KEY: '   ' }), live.PreflightRefused);
});

test('credential presence is reported without reading the value', () => {
  const sentinel = 'not-a-real-key-value';
  assert.strictEqual(live.requireCredential({ GEMINI_API_KEY: sentinel }), true);
  // The presence check returns a boolean, never the secret.
  assert.notStrictEqual(live.requireCredential({ GEMINI_API_KEY: sentinel }), sentinel);
});

// ── Private output root ─────────────────────────────────────────────────────

test('a private output root inside a Git worktree is refused', () => {
  const inside = path.join(ROOT, 'tools', 'scanner-evaluation', '.tmp-run-output');
  assert.throws(() => live.verifyPrivateOutputRoot(inside, { storageRoot: STORAGE_ROOT }));
});

test('a private output root outside the governed storage area is refused', () => {
  const outside = tmp('escape');
  try {
    assert.throws(
      () => live.verifyPrivateOutputRoot(outside, { storageRoot: STORAGE_ROOT }),
      (e) => e instanceof live.PreflightRefused && e.gate === 'containment'
    );
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('an absent storage root fails closed', () => {
  assert.throws(
    () => live.verifyPrivateOutputRoot('anywhere', { storageRoot: null }),
    (e) => e instanceof live.PreflightRefused && e.gate === 'storage_root'
  );
});

test('an approved private root is created with an explicit retention expiry', () => {
  // Must be the governed results child, not merely somewhere under the root.
  const target = require('../lib/governedStorage').privateResultsRoot('run-output-selftest', STORAGE_ROOT);
  fs.rmSync(target, { recursive: true, force: true });
  try {
    const report = live.verifyPrivateOutputRoot(target, { storageRoot: STORAGE_ROOT, retentionDays: 30 });
    assert.strictEqual(report.retentionDays, 30);
    assert.ok(fs.existsSync(report.retentionPath));
    const retention = JSON.parse(fs.readFileSync(report.retentionPath, 'utf8'));
    assert.strictEqual(retention.containsImageBytes, false);
    assert.strictEqual(retention.containsPrompts, false);
    assert.strictEqual(retention.containsRawProviderResponses, true);
    assert.strictEqual(retention.containsCredentials, false);
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

test('an expired private run root is refused instead of silently reused', () => {
  const target = require('../lib/governedStorage').privateResultsRoot('expired-run-selftest', STORAGE_ROOT);
  fs.rmSync(target, { recursive: true, force: true });
  try {
    live.verifyPrivateOutputRoot(target, {
      storageRoot: STORAGE_ROOT,
      retentionDays: 1,
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    assert.throws(
      () => live.verifyPrivateOutputRoot(target, {
        storageRoot: STORAGE_ROOT,
        now: new Date('2026-01-03T00:00:00.000Z'),
      }),
      (e) => e instanceof live.PreflightRefused && e.gate === 'retention'
    );
  } finally {
    fs.rmSync(target, { recursive: true, force: true });
  }
});

// ── Certified execution source ──────────────────────────────────────────────

test('a drifted certified snapshot blocks execution', () => {
  const snapshotRoot = path.join(PRIVATE_AREA, 'certified-snapshot-selftest');
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
  try {
    const built = certifiedSnapshot.materialize({ destination: snapshotRoot });
    // A clean snapshot verifies and yields the identity a run must quote.
    const identity = live.verifyExecutionSource(snapshotRoot);
    assert.strictEqual(identity.certifiedCommit, built.certifiedCommit);
    assert.strictEqual(identity.bundleHash, built.bundleHash);
    assert.strictEqual(identity.fileCount, 39);

    // Tamper with one certified file.
    const victim = path.join(snapshotRoot, 'supabase/functions/_shared/fashionIdentificationV2.ts');
    fs.appendFileSync(victim, '\n// drift\n');
    assert.throws(
      () => live.verifyExecutionSource(snapshotRoot),
      (e) => e instanceof live.PreflightRefused && e.gate === 'certified_snapshot'
    );
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
});

test('an unapproved module in the snapshot blocks execution', () => {
  const snapshotRoot = path.join(PRIVATE_AREA, 'certified-snapshot-rogue');
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
  try {
    certifiedSnapshot.materialize({ destination: snapshotRoot });
    fs.writeFileSync(path.join(snapshotRoot, 'unapproved.ts'), 'export const x = 1;\n');
    assert.throws(() => live.verifyExecutionSource(snapshotRoot), live.PreflightRefused);
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
});

test('snapshots are immutable: a second materialize refuses to overwrite', () => {
  const snapshotRoot = path.join(PRIVATE_AREA, 'certified-snapshot-immutable');
  fs.rmSync(snapshotRoot, { recursive: true, force: true });
  try {
    certifiedSnapshot.materialize({ destination: snapshotRoot });
    assert.throws(() => certifiedSnapshot.materialize({ destination: snapshotRoot }), /immutable/);
  } finally {
    fs.rmSync(snapshotRoot, { recursive: true, force: true });
  }
});

test('a snapshot destination inside a Git worktree is refused', () => {
  assert.throws(() =>
    certifiedSnapshot.materialize({ destination: path.join(ROOT, '.tmp-certified-snapshot') })
  );
});

// ── Seal alignment ──────────────────────────────────────────────────────────

test('the governed seal aligns with the governed manifest', () => {
  assert.strictEqual(live.verifySealAlignment(SEAL, MANIFEST), true);
});

test('a dataset-version mismatch blocks execution', () => {
  assert.throws(
    () => live.verifySealAlignment({ ...SEAL, datasetVersion: '0.3.0' }, MANIFEST),
    (e) => e instanceof live.PreflightRefused && e.gate === 'seal_alignment'
  );
});

test('a ground-truth hash mismatch blocks execution', () => {
  assert.throws(
    () => live.verifySealAlignment({ ...SEAL, finalGroundTruthSha256: 'deadbeef' }, MANIFEST),
    live.PreflightRefused
  );
});

test('changed holdout membership blocks execution', () => {
  assert.throws(
    () => live.verifySealAlignment({ ...SEAL, holdoutCaseIds: SEAL.holdoutCaseIds.slice(1) }, MANIFEST),
    live.PreflightRefused
  );
});

test('an unresolved adjudication blocks execution', () => {
  assert.throws(
    () =>
      live.verifySealAlignment(
        { ...SEAL, adjudication: { ...SEAL.adjudication, unresolvedCount: 1 } },
        MANIFEST
      ),
    live.PreflightRefused
  );
});

// ── Outcome classification ──────────────────────────────────────────────────

test('provider faults are classified into the closed taxonomy', () => {
  // `retryable` describes what certified v140 is permitted to do, not what this
  // adapter does. The adapter performs no retry of its own on any path; the
  // certified attempt loop is the only thing that may reach a fallback.
  const cases = [
    [{ providerAttempts: [{ errorCategory: 'timeout', httpStatus: 0 }] }, 'provider_timeout'],
    [{ providerAttempts: [{ httpStatus: 503 }] }, 'provider_server_error'],
    [{ providerAttempts: [{ httpStatus: 400 }] }, 'provider_client_error'],
    [{ providerAttempts: [{ httpStatus: 429 }] }, 'provider_rate_limited'],
    [{ providerAttempts: [{ httpStatus: 401 }] }, 'provider_auth_error'],
  ];
  for (const [report, expected] of cases) {
    const outcome = live.classifyOutcome(report);
    assert.strictEqual(outcome.status, expected);
    assert.strictEqual(outcome.stage, 'transport');
  }
});

test('output failing the certified contract is provider_output_invalid, not a transient failure', () => {
  const outcome = live.classifyOutcome({ providerAttempts: [{ errorCategory: null }], v2Present: false });
  assert.strictEqual(outcome.status, 'provider_output_invalid');
  assert.strictEqual(outcome.retryable, false);
});

test('a valid certified envelope is provider_success', () => {
  const outcome = live.classifyOutcome({ providerAttempts: [{ httpStatus: 200 }], v2Present: true });
  assert.strictEqual(outcome.status, 'provider_success');
  assert.strictEqual(outcome.stage, 'complete');
});

// ── Private record redaction ────────────────────────────────────────────────

test('the private case record carries no secret, prompt, image byte or raw response', () => {
  const record = live.buildCaseRecord({
    caseId: 'tiera-footwear-537f81fab6',
    report: {
      handlerLatencyMs: 1234,
      v2Present: true,
      observed: { status: 'completed', itemCategory: 'footwear' },
      counters: { modelCalls: 1, unexpectedNetworkAttempts: 0 },
      providerAttempts: [
        { model: 'gemini-3.6-flash', httpStatus: 200, latencyMs: 900, promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30, errorCategory: null },
      ],
      // Fields the adapter must never propagate, present here to prove exclusion.
      rawPayload: { secret: 'RAW PROVIDER RESPONSE' },
      prompt: 'FULL PROMPT TEXT',
      imageBase64: 'AAAABBBBCCCC',
    },
    runIdentityRecord: {
      runId: 'run-1',
      datasetVersion: '0.3.1',
      datasetManifestSha256: 'manifest',
      holdoutSealSha256: 'seal',
      sourceCommit: 'commit',
      certifiedCommit: 'cert',
      certifiedBundleHash: 'bundle',
      modelConfigurationId: 'certified-v140',
    },
    outcome: { status: 'completed' },
    attemptsUsed: 1,
    costUsd: 0.0123,
  });

  const serialized = JSON.stringify(record);
  for (const forbidden of ['RAW PROVIDER RESPONSE', 'FULL PROMPT TEXT', 'AAAABBBBCCCC', 'rawPayload', 'imageBase64', 'GEMINI_API_KEY']) {
    assert.ok(!serialized.includes(forbidden), `private record leaked ${forbidden}`);
  }
  // Absolute workstation paths must not appear either.
  assert.ok(!/[A-Za-z]:\\/.test(serialized), 'private record leaked an absolute path');

  // What it MUST carry, so a run is auditable.
  assert.strictEqual(record.adapterVersion, live.ADAPTER_VERSION);
  assert.strictEqual(record.certifiedBundleHash, 'bundle');
  assert.strictEqual(record.parseStatus, 'parsed');
  assert.strictEqual(record.attemptCount, 1);
  assert.strictEqual(record.costUsd, 0.0123);
  assert.strictEqual(record.providerAttempts[0].totalTokenCount, 30);
});

test('an invalid result still records an auditable, sanitized case record', () => {
  const record = live.buildCaseRecord({
    caseId: 'case-x',
    report: { handlerLatencyMs: 5, v2Present: false, observed: null, counters: {}, providerAttempts: [] },
    runIdentityRecord: {
      runId: 'r', datasetVersion: '0.3.1', datasetManifestSha256: 'm', holdoutSealSha256: 's',
      sourceCommit: 'c', certifiedCommit: 'cc', certifiedBundleHash: 'b', modelConfigurationId: 'certified-v140',
    },
    outcome: { status: 'provider_output_invalid' },
    attemptsUsed: 1,
    costUsd: 0,
  });
  assert.strictEqual(record.parseStatus, 'invalid');
  assert.strictEqual(record.status, 'provider_output_invalid');
  assert.strictEqual(record.observed, null);
});
