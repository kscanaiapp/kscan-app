'use strict';
/**
 * Curiosity Gap Performance Lab — artifact, privacy, binding and validator contract.
 *
 * The validator tests matter most here. A validator that only ever passes is
 * indistinguishable from no validator, so each one is paired with a negative
 * control that proves it can actually fail.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REPO_ROOT = path.join(__dirname, '..', '..');
const LAB = path.join(REPO_ROOT, 'tools', 'curiosity-gap-performance');

const { assertPrivacySafe, isPrivacySafe, PrivacyViolationError } = require(path.join(LAB, 'lib', 'privacy'));
const { buildBindings, verifyBindings, sha256OfString, bindingEntry } = require(path.join(LAB, 'lib', 'sourceBinding'));
const { assertBaselineShape, writeBaseline, assertComparable, compareBaselines, BaselineError } = require(path.join(LAB, 'lib', 'baseline'));
const { loadRegister, paramsAtBand } = require(path.join(LAB, 'lib', 'params'));
const { runContract } = require(path.join(LAB, 'runLab'));

const readLab = (rel) => JSON.parse(fs.readFileSync(path.join(LAB, rel), 'utf8'));
const BASE_SHA = '909df8646a690b55c5af6b7b8c80193df64a2ec8';

// ── Authority artifacts ─────────────────────────────────────────────────────

test('the TTFAR start artifact is valid and grounded in source', () => {
  const t = readLab('authority/ttfar-definition.json');
  assert.strictEqual(t.source_sha, BASE_SHA);
  assert.ok(t.ttfar_start_version);
  assert.strictEqual(t.t_zero.evidence_class, 'PROVEN');
  assert.strictEqual(t.t_zero.source_file, 'hooks/useKScan.js');
  assert.strictEqual(t.t_zero.function, 'runAnalysis');
  assert.ok(Array.isArray(t.rejected_t_zero_candidates) && t.rejected_t_zero_candidates.length > 0,
    'rejected candidates must be recorded so the choice is auditable');
});

test('the TTFAR artifact keeps the combined quality KPI as an uncomputed slot', () => {
  const t = readLab('authority/ttfar-definition.json');
  assert.strictEqual(t.secondary_kpi_slot.status, 'INTERFACE_ONLY_NOT_COMPUTED');
  assert.strictEqual(t.secondary_kpi_slot.quality_score_source, 'NOT_OWNED_BY_THIS_LANE');
});

test('the actionable-result artifact names the real minimum and its enforcement point', () => {
  const a = readLab('authority/actionable-result-schema.json');
  assert.ok(a.actionable_result_version);
  const fields = a.minimum_renderable.required_fields.map((f) => f.field).sort();
  assert.deepStrictEqual(fields, ['productUrl', 'title']);
  for (const f of a.minimum_renderable.required_fields) {
    assert.match(f.enforced_at, /commerceHydration\.ts:\d+/);
  }
  assert.match(a.minimum_actionable.validator, /commerceDestination\.ts/);
});

test('the actionable-result artifact records that the shipped row has no product image', () => {
  const a = readLab('authority/actionable-result-schema.json');
  const img = a.explicitly_NOT_required.find((f) => f.field === 'imageUrl');
  assert.ok(img, 'imageUrl must be explicitly recorded as not required');
  assert.strictEqual(img.evidence_class, 'PROVEN');
  assert.strictEqual(a.actionability_blockers_checked.does_image_load_block_actionability.answer, 'NO');
});

test('every assumptions-register parameter carries provenance and a 3x robustness verdict', () => {
  const r = readLab('authority/assumptions-register.json');
  assert.ok(r.parameters.length > 0);
  for (const p of r.parameters) {
    assert.ok(['PROVEN', 'OBSERVED', 'MODELED'].includes(p.evidence), `${p.parameter} evidence`);
    assert.ok(typeof p.source === 'string' && p.source.trim(), `${p.parameter} source`);
    assert.ok('if_wrong_by_3x_does_conclusion_survive' in p, `${p.parameter} robustness`);
  }
});

test('parameters resolve with their declared evidence class attached', () => {
  const register = loadRegister();
  const params = paramsAtBand(register, 'mid');
  assert.strictEqual(params.gemini_ms.evidence_class, 'OBSERVED');
  assert.strictEqual(params.client_compress_ms.evidence_class, 'MODELED');
  assert.strictEqual(params.gemini_ms.value, 6100);
});

test('an invalid band is rejected', () => {
  assert.throws(() => paramsAtBand(loadRegister(), 'optimistic'), /band must be low\|mid\|high/);
});

test('platform profiles stay separate and both remain SOURCE-MAPPED, not DEVICE-MEASURED', () => {
  const ios = readLab('platformProfiles/ios.json');
  const android = readLab('platformProfiles/android.json');
  assert.strictEqual(ios.platform, 'ios');
  assert.strictEqual(android.platform, 'android');
  for (const p of [ios, android]) {
    assert.strictEqual(p.evidence_level, 'SOURCE-MAPPED');
    assert.strictEqual(p.device_measured, false,
      'no device runtime was authorized; claiming DEVICE-MEASURED would be an invention');
    assert.strictEqual(p.headline_finding.evidence_class, 'PROVEN');
  }
});

// ── Source bindings ─────────────────────────────────────────────────────────

test('source bindings hash real files and verify clean against the working tree', () => {
  const bindings = readLab('authority/source-bindings.json');
  assert.ok(Object.keys(bindings.files).length >= 20);
  const v = verifyBindings(REPO_ROOT, bindings);
  assert.deepStrictEqual(v.drifted, []);
  assert.deepStrictEqual(v.missing, []);
  assert.ok(v.ok);
  assert.ok(v.binding_hash_consistent);
});

test('a stale binding is detectable — a changed file trips it', () => {
  const bindings = readLab('authority/source-bindings.json');
  const tampered = { files: { ...bindings.files }, binding_hash: bindings.binding_hash };
  const firstKey = Object.keys(tampered.files)[0];
  tampered.files[firstKey] = sha256OfString('a different revision of this file');
  const v = verifyBindings(REPO_ROOT, tampered);
  assert.strictEqual(v.ok, false);
  assert.strictEqual(v.drifted.length, 1);
  assert.strictEqual(v.drifted[0].file, firstKey);
});

test('binding a file that does not exist is refused rather than recorded as empty', () => {
  assert.throws(() => buildBindings(REPO_ROOT, ['does/not/exist.ts']), /does not exist/);
});

test('a binding ledger entry without a control-flow fact is refused', () => {
  assert.throws(
    () => bindingEntry({ modelStage: 's', sourceFile: 'f.ts', sourceFunction: 'fn', controlFlowFact: '', evidenceClass: 'PROVEN' }),
    /control_flow_fact|controlFlowFact/i,
  );
  assert.ok(bindingEntry({
    modelStage: 'server.a.gemini', sourceFile: 'index.ts', sourceFunction: 'Deno.serve handler',
    controlFlowFact: 'awaited before commerce begins', evidenceClass: 'PROVEN',
  }));
});

// ── Privacy ─────────────────────────────────────────────────────────────────

test('the privacy guard accepts the lab artifacts it is meant to accept', () => {
  for (const rel of ['authority/ttfar-definition.json', 'authority/assumptions-register.json',
    'scenarios/scan-funnel-on.json', 'scenarios/scan-funnel-off.json']) {
    assert.ok(isPrivacySafe(readLab(rel)), `${rel} should be privacy-safe`);
  }
});

test('unsafe input FAILS rather than being silently redacted', () => {
  const cases = [
    { user_id: 'abc-123' },
    { nested: { email: 'someone@example.com' } },
    { note: 'Bearer abcdefghijklmnopqrstuvwx' },
    { token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.signaturehere' },
    { imageBase64: 'x' },
    { photo: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' },
    { latitude: 51.5 },
  ];
  for (const c of cases) {
    assert.throws(() => assertPrivacySafe(c), PrivacyViolationError, `should reject ${JSON.stringify(c).slice(0, 40)}`);
  }
});

test('the privacy guard does not mutate the object it accepts', () => {
  const input = { stage: 'server.a.gemini', ms: 6100 };
  const out = assertPrivacySafe(input);
  assert.strictEqual(out, input);
  assert.deepStrictEqual(out, { stage: 'server.a.gemini', ms: 6100 });
});

test('the privacy guard survives a cyclic object rather than hanging', () => {
  const a = { name: 'stage' };
  a.self = a;
  assert.ok(isPrivacySafe(a));
});

// ── Baseline immutability and compatibility ─────────────────────────────────

function minimalBaseline(overrides = {}) {
  return {
    baseline_id: 'test',
    benchmark_status: 'INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.',
    source_sha: BASE_SHA,
    source_binding_hash: 'deadbeef',
    trace_schema_version: 'trace-schema-v1',
    ttfar_definition_version: 'ttfar-start-v1',
    actionable_result_version: 'actionable-result-v1',
    scenario_version: 'scenario-v1',
    platform_profile_version: 'platform-profile-v1',
    model_version: 'model-v1',
    structural_findings: { transport_supports_progressive_delivery: false },
    modeled_timing_findings: { disclaimer: 'MODELED', scenarios: {} },
    ...overrides,
  };
}

test('a baseline missing a version field is rejected', () => {
  const b = minimalBaseline();
  delete b.model_version;
  assert.throws(() => assertBaselineShape(b), /missing required version field "model_version"/);
});

test('a baseline that merges structural and modelled findings is rejected', () => {
  const b = minimalBaseline();
  delete b.modeled_timing_findings;
  assert.throws(() => assertBaselineShape(b), /separate/);
});

test('a baseline without the internal-only disclaimer is rejected', () => {
  const b = minimalBaseline({ benchmark_status: 'K Scan is fast' });
  assert.throws(() => assertBaselineShape(b), /internal-only benchmark disclaimer/);
});

test('overwriting an existing baseline is refused', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-lab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'b1.json');
  writeBaseline(file, minimalBaseline());
  assert.throws(() => writeBaseline(file, minimalBaseline()), BaselineError);
  assert.throws(() => writeBaseline(file, minimalBaseline()), /immutable/);
});

test('incompatible baselines are refused before any number is compared', () => {
  const a = minimalBaseline();
  const b = minimalBaseline({ ttfar_definition_version: 'ttfar-start-v2' });
  assert.throws(() => assertComparable(a, b), /incompatible baselines/);
  assert.throws(() => compareBaselines(a, b), /ttfar_definition_version/);
});

test('compare never declares production superiority and leaves quality UNKNOWN', () => {
  const a = minimalBaseline();
  const b = minimalBaseline({ structural_findings: { transport_supports_progressive_delivery: true } });
  const r = compareBaselines(a, b);
  assert.strictEqual(r.quality_effect, 'UNKNOWN');
  assert.strictEqual(r.production_superiority_declared, false);
  assert.strictEqual(r.structural_change.length, 1);
  assert.strictEqual(r.structural_change[0].finding, 'transport_supports_progressive_delivery');
});

// ── Offline guarantee and the runner ────────────────────────────────────────

test('contract mode passes and reports zero network and provider calls', () => {
  const r = runContract();
  assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.pass, true);
  assert.strictEqual(r.network_calls_made, 0);
  assert.strictEqual(r.provider_calls_made, 0);
  assert.strictEqual(r.bindings_ok, true);
});

test('the lab source performs no network I/O — no http, fetch or socket module is used', () => {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== 'baseline' && e.name !== 'reports') walk(p); }
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(LAB);
  assert.ok(files.length > 0, 'expected to find lab source files');
  const forbidden = /require\(['"](node:)?(http|https|net|dgram|tls)['"]\)|\bfetch\s*\(|new\s+WebSocket|XMLHttpRequest/;
  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    assert.ok(!forbidden.test(src), `${path.relative(LAB, f)} must not perform network I/O`);
  }
});

test('the baseline on disk validates and separates structural from modelled findings', () => {
  const b = JSON.parse(fs.readFileSync(path.join(LAB, 'baseline', 'baseline-v1.json'), 'utf8'));
  assert.ok(assertBaselineShape(b));
  assert.strictEqual(b.source_sha, BASE_SHA);
  assert.strictEqual(b.network_calls_made, 0);
  assert.strictEqual(b.provider_spend_usd, 0);
  // The structural block must contain no timing numbers.
  const structuralText = JSON.stringify(b.structural_findings);
  assert.ok(!/"[a-z_]*_ms":\s*\d+\.\d/.test(structuralText),
    'structural findings must not smuggle modelled fractional timings');
});
