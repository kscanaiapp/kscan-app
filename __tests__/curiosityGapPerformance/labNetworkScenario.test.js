'use strict';
/**
 * Curiosity Gap Performance Lab — payload, network, scenario and validator contract.
 *
 * The payload arithmetic is the one place in this lab where a number is exact
 * rather than assumed, so it is tested as arithmetic, not as an approximation.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LAB = path.join(REPO_ROOT, 'tools', 'curiosity-gap-performance');

const { base64Length, scanRequestPayloadBytes, uploadTimeMs, uploadDominanceThresholdMbps, sweep } =
  require(path.join(LAB, 'lib', 'network'));
const { readJpegDimensions, applyScannerResize, readFixture } = require(path.join(LAB, 'lib', 'jpeg'));
const { runScenario, sweepScenario } = require(path.join(LAB, 'lib', 'model'));
const { loadRegister, paramsAtBand } = require(path.join(LAB, 'lib', 'params'));

const readLab = (rel) => JSON.parse(fs.readFileSync(path.join(LAB, rel), 'utf8'));
const FUNNEL_ON = () => readLab('scenarios/scan-funnel-on.json');
const FUNNEL_OFF = () => readLab('scenarios/scan-funnel-off.json');
const PAYLOAD = () => scanRequestPayloadBytes({ compressedImageBytes: Math.round(896 * 672 * 0.15), envelopeBytes: 320 });

// ── Payload arithmetic ──────────────────────────────────────────────────────

test('base64 expansion is exact, including padding', () => {
  assert.strictEqual(base64Length(0), 0);
  assert.strictEqual(base64Length(1), 4);
  assert.strictEqual(base64Length(3), 4);
  assert.strictEqual(base64Length(4), 8);
  assert.strictEqual(base64Length(3000), 4000);
  // Cross-check against Node's own encoder.
  for (const n of [1, 2, 3, 7, 64, 1000, 4097]) {
    assert.strictEqual(base64Length(n), Buffer.alloc(n).toString('base64').length, `n=${n}`);
  }
});

test('the scan request body is the base64 image plus envelope plus its two JSON quotes', () => {
  const p = scanRequestPayloadBytes({ compressedImageBytes: 90000, envelopeBytes: 320 });
  assert.strictEqual(p.base64_bytes, 120000);
  assert.strictEqual(p.request_body_bytes, 120000 + 320 + 2);
  assert.ok(Math.abs(p.base64_expansion_ratio - 4 / 3) < 1e-9,
    'base64 costs a fixed one third on top of the compressed JPEG');
});

test('a negative or non-integer image size is rejected', () => {
  assert.throws(() => scanRequestPayloadBytes({ compressedImageBytes: -1 }), TypeError);
  assert.throws(() => scanRequestPayloadBytes({ compressedImageBytes: 1.5 }), TypeError);
  assert.throws(() => base64Length(-3), TypeError);
});

test('upload time is serialization plus setup round trips, and is always MODELED', () => {
  const t = uploadTimeMs({ bytes: 1_000_000, uplinkMbps: 8, rttMs: 100, setupRoundTrips: 2 });
  assert.strictEqual(t.serialization_ms, 1000); // 8 Mbit over 8 Mbps
  assert.strictEqual(t.setup_ms, 200);
  assert.strictEqual(t.total_ms, 1200);
  assert.strictEqual(t.evidence_class, 'MODELED');
});

test('invalid network inputs are rejected rather than defaulted', () => {
  assert.throws(() => uploadTimeMs({ bytes: 100, uplinkMbps: 0, rttMs: 10 }), /uplinkMbps/);
  assert.throws(() => uploadTimeMs({ bytes: -1, uplinkMbps: 5, rttMs: 10 }), /bytes/);
  assert.throws(() => uploadTimeMs({ bytes: 100, uplinkMbps: 5, rttMs: -1 }), /rttMs/);
});

test('the upload dominance threshold is reported as a threshold, never as a point estimate', () => {
  const r = uploadDominanceThresholdMbps({ bytes: 120_000, otherPathMs: 8000, shareOfBudget: 0.25, rttMs: 100 });
  assert.strictEqual(r.evidence_class, 'MODELED');
  assert.ok(r.threshold_mbps > 0 && Number.isFinite(r.threshold_mbps));
  assert.match(r.interpretation, /below ~[\d.]+ Mbps/);
});

test('when RTT alone exceeds the target share, bandwidth is reported as unable to fix it', () => {
  const r = uploadDominanceThresholdMbps({ bytes: 1000, otherPathMs: 100, shareOfBudget: 0.25, rttMs: 400 });
  assert.strictEqual(r.threshold_mbps, Infinity);
  assert.match(r.note, /RTT setup alone/);
});

test('an out-of-range share is rejected', () => {
  assert.throws(() => uploadDominanceThresholdMbps({ bytes: 1, otherPathMs: 1, shareOfBudget: 1, rttMs: 1 }), /strictly between/);
});

test('sweep requires values rather than silently producing nothing', () => {
  assert.throws(() => sweep([], (v) => v), /non-empty/);
  assert.deepStrictEqual(sweep([1, 2], (v) => v * 10).map((r) => r.output), [10, 20]);
});

// ── Real image geometry ─────────────────────────────────────────────────────

test('JPEG dimensions are read from the real committed fixtures', () => {
  const dir = path.join(REPO_ROOT, 'assets', 'qa_fixtures');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg'));
  assert.ok(files.length >= 8, 'the committed visual corpus should still be present');
  for (const f of files) {
    const r = readFixture(path.join(dir, f));
    assert.ok(r.width > 0 && r.height > 0, `${f} dimensions`);
    assert.ok(r.bytes > 0);
  }
});

test('a non-JPEG buffer is rejected rather than producing a bogus size', () => {
  assert.throws(() => readJpegDimensions(Buffer.from([0x00, 0x01, 0x02, 0x03])), /not a JPEG/);
  assert.throws(() => readJpegDimensions('not a buffer'), TypeError);
});

test('the width-only resize UPSCALES a source narrower than 896px — a real payload hazard', () => {
  const small = applyScannerResize({ width: 423, height: 503 }, 896);
  assert.strictEqual(small.width, 896);
  assert.strictEqual(small.upscaled, true);
  assert.ok(small.pixels / (423 * 503) > 4, 'a 423px-wide source gains over 4x the pixels');

  const large = applyScannerResize({ width: 4032, height: 3024 }, 896);
  assert.strictEqual(large.width, 896);
  assert.strictEqual(large.upscaled, false);
});

// ── Scenario structure ──────────────────────────────────────────────────────

test('both scenarios evaluate and declare two terminals', () => {
  const register = loadRegister();
  for (const scenario of [FUNNEL_ON(), FUNNEL_OFF()]) {
    assert.ok(scenario.first_result_terminal);
    assert.ok(scenario.completion_terminal);
    const r = runScenario(scenario, paramsAtBand(register, 'mid'), { payload: PAYLOAD() });
    assert.ok(r.first_result.total_ms > 0);
    assert.ok(r.complete_response.total_ms >= r.first_result.total_ms,
      'completion can never finish before the first result');
  }
});

test('a scenario that collapses the two terminals into one field is refused', () => {
  const bad = FUNNEL_ON();
  delete bad.completion_terminal;
  assert.throws(
    () => runScenario(bad, paramsAtBand(loadRegister(), 'mid'), { payload: PAYLOAD() }),
    /must declare BOTH/,
  );
});

test('the funnel-ON first-result path crosses the network four times: two round trips', () => {
  const r = runScenario(FUNNEL_ON(), paramsAtBand(loadRegister(), 'mid'), { payload: PAYLOAD() });
  const netStages = r.first_result.chain.filter((id) => id.startsWith('net.'));
  assert.deepStrictEqual(netStages, ['net.upload_a', 'net.download_a', 'net.upload_b', 'net.download_b'],
    'deferred commerce costs a SECOND full round trip before the first actionable result');
});

test('the funnel-OFF path couples TTFAR to completion — they are the same event', () => {
  const s = FUNNEL_OFF();
  assert.strictEqual(s.first_result_terminal, s.completion_terminal);
  const r = runScenario(s, paramsAtBand(loadRegister(), 'mid'), { payload: PAYLOAD() });
  assert.strictEqual(r.first_result.total_ms, r.complete_response.total_ms);
});

test('the identification call is on the first-result path in both architectures', () => {
  const register = loadRegister();
  const on = runScenario(FUNNEL_ON(), paramsAtBand(register, 'mid'), { payload: PAYLOAD() });
  const off = runScenario(FUNNEL_OFF(), paramsAtBand(register, 'mid'), { payload: PAYLOAD() });
  assert.ok(on.first_result.chain.includes('server.a.gemini'));
  assert.ok(off.first_result.chain.includes('server.gemini'));
});

test('under early exit a 13.9s straggler provider cannot gate TTFAR', () => {
  const register = loadRegister();
  const base = paramsAtBand(register, 'mid');
  const fast = runScenario(FUNNEL_ON(), { ...base, provider_poshmark_ms: { value: 900, evidence_class: 'MODELED' } }, { payload: PAYLOAD() });
  const slow = runScenario(FUNNEL_ON(), { ...base, provider_poshmark_ms: { value: 13900, evidence_class: 'MODELED' } }, { payload: PAYLOAD() });
  assert.strictEqual(slow.first_result.total_ms, fast.first_result.total_ms,
    'FAST_COMMERCE_SUFFICIENT_RESULTS lets the group close on the first child that delivers');
});

test('with the early exit removed, the slow provider gates TTFAR but only up to the 1900ms deadline', () => {
  const register = loadRegister();
  const blocking = FUNNEL_ON();
  delete blocking.stages.find((s) => s.id === 'server.b.discovery').duration.sufficient_after_children;
  const base = paramsAtBand(register, 'mid');
  const at1500 = runScenario(blocking, { ...base, provider_poshmark_ms: { value: 1500 } }, { payload: PAYLOAD() });
  const at13900 = runScenario(blocking, { ...base, provider_poshmark_ms: { value: 13900 } }, { payload: PAYLOAD() });
  assert.ok(at13900.first_result.total_ms > at1500.first_result.total_ms, 'a slower child does cost time');
  const delta = at13900.first_result.total_ms - at1500.first_result.total_ms;
  assert.ok(delta <= 400 + 1, `the deadline caps the damage at 1900ms total, not 13.9s (delta ${delta})`);
  assert.ok(at13900.timed_out_stages.some((t) => t.stage === 'server.b.discovery'));
});

test('the modelled identification share agrees with the independently observed ~74%', () => {
  const r = runScenario(FUNNEL_ON(), paramsAtBand(loadRegister(), 'mid'), { payload: PAYLOAD() });
  const share = r.stage_timings['server.a.gemini'].duration_ms / r.first_result.total_ms;
  // docs/BUILD34_SCANNER_SCAN_RESULTS_DEEP_AUDIT.md:297 reports Gemini at ~74%
  // of wall time from live measurement. The model reaching the same
  // neighbourhood from independent inputs is a calibration signal, not a proof.
  assert.ok(share > 0.6 && share < 0.85, `modelled identification share ${(share * 100).toFixed(1)}% should land near the observed 74%`);
});

test('a network sweep changes the modelled path without changing its evidence class', () => {
  const rows = sweepScenario(
    FUNNEL_ON(), paramsAtBand(loadRegister(), 'mid'), 'uplink_mbps',
    [0.5, 5, 50].map((v) => ({ value: v, evidence_class: 'MODELED' })),
    { payload: PAYLOAD() },
  );
  assert.strictEqual(rows.length, 3);
  assert.ok(rows[0].first_result_ms > rows[2].first_result_ms, 'a slower uplink must cost more');
  for (const r of rows) assert.strictEqual(r.evidence_class, 'MODELED');
});

// ── Independent validator ───────────────────────────────────────────────────

function runValidator(args = []) {
  return spawnSync(process.execPath, [path.join(LAB, 'validateReport.js'), ...args], { encoding: 'utf8' });
}

test('the validator passes the real artifacts and exits zero', () => {
  const r = runValidator();
  assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  assert.strictEqual(JSON.parse(r.stdout).pass, true);
});

test('the validator FAILS a bad artifact and exits non-zero', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-lab-val-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bad = path.join(dir, 'bad-baseline.json');
  fs.writeFileSync(bad, JSON.stringify({
    baseline_id: 'bad',
    benchmark_status: 'K Scan returns results in 2.41 seconds',
    source_sha: 'deadbeef',
    structural_findings: {},
    network_calls_made: 42,
    provider_spend_usd: 9.99,
  }));
  const r = runValidator([bad]);
  assert.strictEqual(r.status, 1, 'a bad baseline must exit non-zero');
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.pass, false);
  const checks = out.failures.map((f) => f.check);
  assert.ok(checks.includes('baseline_versions'), 'missing version fields must be caught');
  assert.ok(checks.includes('baseline_separation'), 'merged findings blocks must be caught');
  assert.ok(checks.includes('offline_guarantee'), 'claimed network calls and spend must be caught');
  assert.ok(checks.includes('required_disclaimer'), 'a missing internal-only disclaimer must be caught');
});
