'use strict';

/**
 * Phase 2A candidate seam.
 *
 * These tests exist to prove the seam is a BOUNDARY, not a label. Each one
 * corresponds to a way the boundary could be crossed silently:
 *
 *   - certified execution quietly resolving to the candidate;
 *   - the candidate being selectable by ambient state rather than by name;
 *   - an unknown or half-configured candidate resolving to something;
 *   - control and candidate results landing on one identity;
 *   - the certified snapshot moving underneath either of them.
 *
 * No provider transport is involved. Nothing here makes a network call.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const candidateRegistry = require('../lib/candidateRegistry');
const certifiedSource = require('../lib/certifiedSource');
const governedStorage = require('../lib/governedStorage');
const liveAdapter = require('../lib/liveAdapter');
const runIdentity = require('../lib/runIdentity');

const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT || 'C:/Users/jsmit/KScan-eval-storage-private';
const SNAPSHOT_ROOT = path.join(STORAGE_ROOT, 'snapshots', 'certified-v140-f5f4ed2');

const RUN_ID_PARTS = Object.freeze({
  datasetVersion: '0.3.1',
  adapterId: 'v140',
  timestamp: '2026-07-30T12:00:00.000Z',
  mode: 'execute',
  researchSha: '5e412438a51bba53910f93e5963486d2e00cf8c5',
  split: runIdentity.SPLIT_DEVELOPMENT,
});

// ── Registry shape ──────────────────────────────────────────────────────────

test('the registry exposes exactly one control and the single Phase 2A candidate', () => {
  const all = candidateRegistry.versions();
  assert.deepEqual(all.slice().sort(), ['certified-v140', 'phase2a-v1.0.0']);

  const controls = all.filter((version) => candidateRegistry.resolveCandidate(version).role === 'control');
  assert.deepEqual(controls, [candidateRegistry.CONTROL_VERSION]);

  // One identifier, no aliases: nothing else in the registry may point at the
  // same overlay or the same run-id segment.
  const segments = all
    .map((version) => candidateRegistry.resolveCandidate(version).runIdSegment)
    .filter((segment) => segment !== null);
  assert.deepEqual(segments, [candidateRegistry.PHASE2A_VERSION]);
  assert.equal(new Set(segments).size, segments.length);
});

test('control and candidate share the certified model topology', () => {
  const control = candidateRegistry.resolveCandidate(candidateRegistry.CONTROL_VERSION);
  const candidate = candidateRegistry.resolveCandidate(candidateRegistry.PHASE2A_VERSION);

  // Phase 2A is prompt engineering plus post-validation. A candidate that
  // changed models would be a different phase, and this assertion is what would
  // catch that being slipped in as a registry edit.
  assert.equal(candidate.modelConfigurationId, control.modelConfigurationId);
  assert.equal(candidate.modelConfigurationId, candidateRegistry.CERTIFIED_MODEL_CONFIGURATION_ID);
});

test('the control carries no overlay and no candidate validation policy', () => {
  const control = candidateRegistry.resolveCandidate(candidateRegistry.CONTROL_VERSION);
  assert.equal(control.instructionOverlayId, null);
  assert.equal(control.postValidationPolicy, 'certified_only');
  assert.equal(control.runIdSegment, null);
});

test('the Phase 2A candidate is operationally distinct from the control', () => {
  const control = candidateRegistry.candidateIdentity(candidateRegistry.CONTROL_VERSION);
  const candidate = candidateRegistry.candidateIdentity(candidateRegistry.PHASE2A_VERSION);

  assert.notEqual(candidate.candidateVersion, control.candidateVersion);
  assert.notEqual(candidate.instructionOverlayId, control.instructionOverlayId);
  assert.notEqual(candidate.postValidationPolicy, control.postValidationPolicy);
  assert.notDeepEqual(candidate, control);
});

// ── Explicit selection ──────────────────────────────────────────────────────

test('certified execution resolves to v140 when v140 is what was named', () => {
  const resolved = candidateRegistry.resolveCandidate(candidateRegistry.CONTROL_VERSION);
  assert.equal(resolved.candidateVersion, 'certified-v140');
  assert.equal(candidateRegistry.isControl(candidateRegistry.CONTROL_VERSION), true);
  assert.equal(candidateRegistry.isControl(candidateRegistry.PHASE2A_VERSION), false);
});

test('there is no default: an absent selection is refused rather than guessed', () => {
  for (const absent of [undefined, null, '', '   ']) {
    assert.throws(
      () => candidateRegistry.resolveCandidate(absent),
      candidateRegistry.UnknownCandidateVersion,
      `absent selection ${JSON.stringify(absent)} must not resolve`
    );
  }
  // Nothing may be selected positionally either.
  assert.throws(() => candidateRegistry.resolveCandidate(), candidateRegistry.UnknownCandidateVersion);
});

test('an unknown candidate version fails closed', () => {
  for (const unknown of [
    'phase2a',
    'phase2a-v1.0.1',
    'PHASE2A-V1.0.0',
    'certified-v141',
    'phase2a-v1.0.0 ',
    0,
    1,
    true,
    {},
    ['phase2a-v1.0.0'],
  ]) {
    assert.throws(
      () => candidateRegistry.resolveCandidate(unknown),
      candidateRegistry.UnknownCandidateVersion,
      `${JSON.stringify(unknown)} must not resolve to any execution`
    );
  }
});

test('no environment variable can change which execution resolves', () => {
  const probes = [
    'KSCAN_EVAL_CANDIDATE',
    'KSCAN_EVAL_CANDIDATE_VERSION',
    'KSCAN_SCANNER_CANDIDATE',
    'KSCAN_PHASE2A',
    'PHASE2A',
    'CANDIDATE_VERSION',
    'NODE_ENV',
  ];
  const saved = probes.map((name) => [name, process.env[name]]);
  try {
    for (const name of probes) process.env[name] = candidateRegistry.PHASE2A_VERSION;

    // The registry still refuses an unnamed selection, and naming the control
    // still yields the control. Ambient state changed nothing.
    assert.throws(() => candidateRegistry.resolveCandidate(undefined), candidateRegistry.UnknownCandidateVersion);
    assert.equal(
      candidateRegistry.resolveCandidate(candidateRegistry.CONTROL_VERSION).role,
      'control'
    );
    assert.equal(candidateRegistry.registryHash(), candidateRegistry.registryHash());
  } finally {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('ordinary production request data cannot select the candidate', () => {
  // A production scan-identify body. None of its fields are a selection channel:
  // the registry only accepts a version string, and none of these values is one.
  const productionBody = {
    contractVersion: 'fashion-identification-v2',
    requestId: 'req-0001',
    intent: 'identify_for_style',
    mode: 'identify_selected_item',
    source: { entryPath: 'scanner_camera', platform: 'ios', appVersion: '1.0.0' },
    // Hostile extras a client could attach.
    candidateVersion: 'phase2a-v1.0.0',
    experiment: 'phase2a-v1.0.0',
    'x-kscan-candidate': 'phase2a-v1.0.0',
  };
  const selectionChannels = Object.values(productionBody).filter((value) => typeof value === 'string');
  for (const value of selectionChannels) {
    if (value === candidateRegistry.PHASE2A_VERSION) continue; // asserted separately below
    assert.throws(() => candidateRegistry.resolveCandidate(value), candidateRegistry.UnknownCandidateVersion);
  }

  // The point is not that the STRING cannot resolve — it is that nothing reads
  // it. The registry has no request-body reader, so a body field is inert.
  assert.equal(typeof candidateRegistry.resolveCandidate, 'function');
  assert.equal(candidateRegistry.resolveCandidate.length, 1, 'selection takes exactly one explicit argument');
  // Scan the CODE, not the prose. The module documents that it reads neither of
  // these, so a naive text search would match its own comments.
  const code = fs
    .readFileSync(path.join(__dirname, '..', 'lib', 'candidateRegistry.js'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.equal(/process\s*\.\s*env/.test(code), false, 'the registry must not read the environment');
  assert.equal(/globalThis/.test(code), false, 'the registry must not read mutable global state');
});

// ── Fail-closed configuration ───────────────────────────────────────────────

test('an incomplete candidate configuration is refused rather than half-applied', () => {
  const complete = {
    candidateVersion: 'phase2a-test',
    role: 'candidate',
    modelConfigurationId: 'certified-v140',
    instructionOverlayId: 'overlay-1',
    postValidationPolicy: 'phase2a_evidence_discipline',
    runIdSegment: 'phase2a-test',
    description: 'fixture',
  };
  assert.equal(candidateRegistry.assertConfigurationComplete(complete), complete);

  for (const field of candidateRegistry.REQUIRED_FIELDS) {
    const partial = { ...complete };
    delete partial[field];
    assert.throws(
      () => candidateRegistry.assertConfigurationComplete(partial),
      candidateRegistry.CandidateConfigurationIncomplete,
      `${field} must be required`
    );
  }
  for (const field of ['instructionOverlayId', 'runIdSegment']) {
    const blank = { ...complete, [field]: null };
    assert.throws(
      () => candidateRegistry.assertConfigurationComplete(blank),
      candidateRegistry.CandidateConfigurationIncomplete,
      `a candidate with no ${field} is a renamed control`
    );
  }
});

test('a candidate may not declare certified-only validation, and a control may not carry an overlay', () => {
  assert.throws(
    () => candidateRegistry.assertConfigurationComplete({
      candidateVersion: 'x',
      role: 'candidate',
      modelConfigurationId: 'certified-v140',
      instructionOverlayId: 'o',
      postValidationPolicy: 'certified_only',
      runIdSegment: 'x',
      description: 'd',
    }),
    candidateRegistry.CandidateConfigurationIncomplete
  );
  assert.throws(
    () => candidateRegistry.assertConfigurationComplete({
      candidateVersion: 'certified-v140',
      role: 'control',
      modelConfigurationId: 'certified-v140',
      instructionOverlayId: 'sneaky-overlay',
      postValidationPolicy: 'certified_only',
      runIdSegment: null,
      description: 'd',
    }),
    candidateRegistry.CandidateConfigurationIncomplete
  );
});

// ── Result identity isolation ───────────────────────────────────────────────

test('a certified run id is unchanged by the existence of the candidate seam', () => {
  // The exact string the certified runner produced before Phase 2A. If the
  // candidate segment ever leaked into the control path, this breaks.
  const certified = runIdentity.buildRunId({
    ...RUN_ID_PARTS,
    candidateVersion: candidateRegistry.runIdSegment(candidateRegistry.CONTROL_VERSION),
  });
  assert.equal(certified, runIdentity.buildRunId(RUN_ID_PARTS));
  assert.equal(certified, 'baseline-v0.3.1-v140-20260730-1200-5e41243-development-exec');
  assert.equal(certified.includes('phase2a'), false);
});

test('certified and candidate run ids cannot collide', () => {
  const certified = runIdentity.buildRunId({
    ...RUN_ID_PARTS,
    candidateVersion: candidateRegistry.runIdSegment(candidateRegistry.CONTROL_VERSION),
  });
  const candidate = runIdentity.buildRunId({
    ...RUN_ID_PARTS,
    candidateVersion: candidateRegistry.runIdSegment(candidateRegistry.PHASE2A_VERSION),
  });

  assert.notEqual(candidate, certified);
  assert.equal(candidate, `${certified}-${candidateRegistry.PHASE2A_VERSION}`);

  // And they resolve to different private result roots, so neither can
  // overwrite the other's case files.
  const certifiedRoot = governedStorage.privateResultsRoot(certified, STORAGE_ROOT);
  const candidateRoot = governedStorage.privateResultsRoot(candidate, STORAGE_ROOT);
  assert.notEqual(certifiedRoot, candidateRoot);
});

test('a candidate version may not smuggle a path separator into the run directory', () => {
  for (const hostile of ['../escape', 'a/b', 'a\\b', 'has space']) {
    assert.throws(
      () => runIdentity.buildRunId({ ...RUN_ID_PARTS, candidateVersion: hostile }),
      /candidateVersion may not contain/
    );
  }
  assert.throws(
    () => runIdentity.buildRunId({ ...RUN_ID_PARTS, candidateVersion: 42 }),
    /candidateVersion must be a string/
  );
});

test('candidateVersion is part of run identity, so a resume cannot graft candidate onto control', () => {
  assert.equal(runIdentity.IDENTITY_FIELDS.includes('candidateVersion'), true);

  const control = { runId: 'r', datasetVersion: '0.3.1', candidateVersion: 'certified-v140' };
  const candidate = { ...control, candidateVersion: 'phase2a-v1.0.0' };

  const comparison = runIdentity.compareIdentity(control, candidate);
  assert.equal(comparison.ok, false);
  assert.equal(comparison.mismatches.some((m) => m.field === 'candidateVersion'), true);
  assert.throws(() => runIdentity.assertResumable(control, candidate), /candidateVersion/);

  // A pre-Phase-2A manifest carries the field on neither side and stays resumable.
  const legacy = { runId: 'r', datasetVersion: '0.3.1' };
  assert.equal(runIdentity.compareIdentity(legacy, { ...legacy }).ok, true);
});

test('control and candidate results may not share one write target', () => {
  const control = { candidateVersion: 'certified-v140', runId: 'run-a', outputRoot: '/results/run-a' };
  const candidate = { candidateVersion: 'phase2a-v1.0.0', runId: 'run-b', outputRoot: '/results/run-b' };
  assert.equal(candidateRegistry.assertDistinctResultIdentity(control, candidate), true);

  assert.throws(
    () => candidateRegistry.assertDistinctResultIdentity(control, { ...candidate, runId: 'run-a' }),
    candidateRegistry.ResultIdentityCollision
  );
  assert.throws(
    () => candidateRegistry.assertDistinctResultIdentity(control, { ...candidate, outputRoot: '/results/run-a' }),
    candidateRegistry.ResultIdentityCollision
  );
  // An unversioned record would collide with everything, so it is refused
  // rather than assumed to be the control.
  assert.throws(
    () => candidateRegistry.assertDistinctResultIdentity({ runId: 'run-a' }, candidate),
    candidateRegistry.ResultIdentityCollision
  );
});

// ── The certified snapshot is still the certified snapshot ───────────────────

test('the certified v140 closure is unchanged by Phase 2A', () => {
  const record = certifiedSource.loadRecord();
  assert.equal(record.certifiedBranches.ios.sha, 'f5f4ed2eda4984db0658c3209fece223acd33188');

  const closure = certifiedSource.verifyClosure(record.certifiedBranches.ios.sha);
  assert.equal(closure.ok, true, 'certified closure must re-derive from the git object store');
  assert.equal(closure.mismatches.length, 0);
  assert.equal(closure.missing.length, 0);
  assert.equal(closure.bundleHash, record.bundleHash);

  const boundaries = certifiedSource.verifyCertifiedBoundaries(record.certifiedBranches.ios.sha);
  assert.equal(boundaries.ok, true);
});

test('the on-disk certified snapshot still verifies', { skip: !fs.existsSync(SNAPSHOT_ROOT) }, () => {
  const identity = liveAdapter.verifyExecutionSource(SNAPSHOT_ROOT);
  assert.equal(
    identity.closureAggregateSha256,
    'f3eb6e60847294e430ace8a34554afd9e28e1b94110096b75a05529b39271314'
  );
  assert.equal(identity.certifiedCommit, 'f5f4ed2eda4984db0658c3209fece223acd33188');
  assert.equal(identity.fileCount, 39);
});
