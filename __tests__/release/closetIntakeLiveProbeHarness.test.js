'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const probe = require('../../security/release/run-closet-intake-live-probe');

const IMAGE = '/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==';

test('request builder exposes exactly the authoritative Closet entry paths', () => {
  assert.deepEqual(probe.ENTRY_PATHS, ['closet_camera', 'closet_gallery', 'closet_mirror']);
  for (const entryPath of probe.ENTRY_PATHS) {
    const request = probe.buildClosetRequest(entryPath, IMAGE, {
      requestId: 'req_closet_probe_1',
      evidenceId: '11111111-2222-4333-8444-555555555555',
    });
    assert.equal(request.intent, 'identify_for_closet');
    assert.equal(request.mode, 'detect_items');
    assert.equal(request.source.entryPath, entryPath);
    assert.equal(request.source.platform, 'android');
    assert.equal(request.evidence[0].transport.imageBase64, IMAGE);
  }
});

test('request builder refuses every entry path outside the closed allowlist', () => {
  for (const hostile of ['scanner_camera', 'mirror_extract', 'closet_mirror_v2', '', null]) {
    assert.throws(() => probe.buildClosetRequest(hostile, IMAGE), /not probe-approved/);
  }
});

test('positive response requires live V2 correlation and zero commerce arrays', () => {
  const facts = probe.inspectPositiveResponse(200, {
    status: 'completed',
    contractVersion: probe.CONTRACT_VERSION,
    identificationV2: {
      status: 'completed',
      requestId: 'req-1',
      evidence: [{ evidenceId: 'evidence-1', observations: [] }],
    },
    recommendedProducts: [],
    products: [],
    purchaseOptions: [],
    similarityMatches: [],
  }, { requestId: 'req-1', evidenceId: 'evidence-1' });
  assert.equal(facts.accepted, true);
});

test('detection-mode multiple-item status is an accepted V2 outcome', () => {
  const facts = probe.inspectPositiveResponse(200, {
    status: 'completed',
    contractVersion: probe.CONTRACT_VERSION,
    identificationV2: {
      status: 'multiple_items_need_selection',
      requestId: 'req-2',
      evidence: [{ evidenceId: 'evidence-2', observations: [] }],
    },
  }, { requestId: 'req-2', evidenceId: 'evidence-2' });
  assert.equal(facts.accepted, true);
});

test('positive response fails on missing V2 evidence or any commerce result', () => {
  const base = {
    status: 'completed',
    contractVersion: probe.CONTRACT_VERSION,
    identificationV2: {
      status: 'multiple_items_need_selection',
      requestId: 'req-1',
      evidence: [{ evidenceId: 'wrong', observations: [] }],
    },
    purchaseOptions: [{ id: 'not-allowed' }],
  };
  const facts = probe.inspectPositiveResponse(200, base, { requestId: 'req-1', evidenceId: 'evidence-1' });
  assert.equal(facts.accepted, false);
  assert.equal(facts.purchaseOptionCount, 1);
  assert.equal(facts.evidenceCorrelated, false);
});

test('hostile near-miss passes only for the exact validator rejection', () => {
  assert.equal(probe.inspectNegativeResponse(400, { error: { code: 'INVALID_SOURCE' } }).rejected, true);
  assert.equal(probe.inspectNegativeResponse(200, { error: { code: 'INVALID_SOURCE' } }).rejected, false);
  assert.equal(probe.inspectNegativeResponse(400, { error: { code: 'INVALID_INTENT' } }).rejected, false);
});

test('URL is literal scan-identify and cannot be redirected by input', () => {
  assert.equal(
    probe.buildScanIdentifyUrl('https://staging.example.test///'),
    'https://staging.example.test/functions/v1/scan-identify',
  );
});

test('missing environment inventory is exact and deterministic', () => {
  assert.deepEqual(probe.findMissingEnvVars({}), probe.REQUIRED_ENV_VARS);
  const full = Object.fromEntries(probe.REQUIRED_ENV_VARS.map((name) => [name, 'set']));
  assert.deepEqual(probe.findMissingEnvVars(full), []);
});

test('evidence privacy rejects image, JWT, email and PAT-shaped values', () => {
  for (const value of [
    'data:image/jpeg;base64,abc',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4eCJ9.signature',
    'person@example.com',
    `sbp_${'a'.repeat(40)}`,
  ]) {
    assert.throws(() => probe.assertEvidencePrivacy({ value }), /forbidden secret\/PII shape/);
  }
  assert.doesNotThrow(() => probe.assertEvidencePrivacy({ verdict: 'PASS', entryPath: 'closet_mirror' }));
});

test('a failed live assertion preserves the detailed sanitized evidence', () => {
  const existing = {
    verdict: 'FAIL',
    environment: 'staging',
    entryPathResults: [{ entryPath: 'closet_mirror', accepted: false }],
  };
  const error = new probe.ClosetIntakeProbeError('failed', 'LIVE_ASSERTION_FAILED');
  assert.deepEqual(probe.buildTerminalFailureReport(error, existing), {
    ...existing,
    executionCode: 'LIVE_ASSERTION_FAILED',
  });
  assert.equal(probe.buildTerminalFailureReport(error, null).verdict, 'OPERATIONAL_FAILURE');
});
