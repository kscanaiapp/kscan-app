'use strict';

/**
 * Phase 0D Lane C — certified adapter, deterministic mock, zero-network guard.
 *
 * Every test here is offline and costs $0.00. The allowed pre-authorization
 * paid spend is exactly zero — there is no nominal development allowance.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const certifiedSource = require('../lib/certifiedSource');
const { createCertifiedAdapter, BoundaryViolation, throwingBoundary } = require('../adapter/certifiedAdapter');
const { createMockProvider, SCENARIOS } = require('../adapter/mockProvider');
const runBaseline = require('../run-baseline');
const runnerState = require('../lib/runnerState');

const CERT_ROOT = process.env.KSCAN_CERT_V140_ROOT || 'C:/Users/jsmit/KScan-cert-v140-readonly';
const RESEARCH_ROOT = path.resolve(__dirname, '..', '..', '..');
const certRootAvailable = certifiedSource.verifyCertRoot(CERT_ROOT).ok;

/** Skip cleanly when the read-only certified worktree is not present. */
const certTest = certRootAvailable ? test : test.skip;

// ── Certified root validation ────────────────────────────────────────────────

certTest('certified root is accepted and reproduces the governed bundle hash', () => {
  const result = certifiedSource.verifyCertRoot(CERT_ROOT);
  assert.equal(result.ok, true);
  assert.equal(result.bundleHash, '28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589');
  assert.equal(result.bundleFileCount, 31);
  assert.equal(result.fileCount, 39);
  assert.deepEqual(result.failures, []);
});

test('the research Scanner tree is rejected as a certified root', () => {
  const result = certifiedSource.verifyCertRoot(RESEARCH_ROOT);
  assert.equal(result.ok, false);
  const codes = result.failures.map((f) => f.code);
  assert.ok(codes.includes('file_differs'));
  assert.ok(codes.includes('bundle_hash_mismatch'));
  const drift = result.failures.find((f) => f.code === 'file_differs' && f.bundle);
  assert.equal(drift.path, 'supabase/functions/_shared/fashionIdentificationV2.ts');
});

test('a wrong or missing root is rejected rather than defaulted', () => {
  assert.equal(certifiedSource.verifyCertRoot(null).failures[0].code, 'no_cert_root');
  assert.equal(certifiedSource.verifyCertRoot('C:/definitely/not/here').failures[0].code, 'root_missing');
});

test('a root missing a certified file is rejected', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-empty-'));
  const result = certifiedSource.verifyCertRoot(tmp);
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.code === 'file_missing' || f.code === 'function_dir_missing'));
});

test('cert root resolves from --cert-root and from the environment variable', () => {
  assert.deepEqual(certifiedSource.resolveCertRoot(['--cert-root', 'X:/somewhere']), {
    root: 'X:/somewhere',
    via: '--cert-root',
  });
  const previous = process.env.KSCAN_CERT_V140_ROOT;
  process.env.KSCAN_CERT_V140_ROOT = 'Y:/elsewhere';
  try {
    assert.deepEqual(certifiedSource.resolveCertRoot([]), { root: 'Y:/elsewhere', via: 'KSCAN_CERT_V140_ROOT' });
  } finally {
    if (previous === undefined) delete process.env.KSCAN_CERT_V140_ROOT;
    else process.env.KSCAN_CERT_V140_ROOT = previous;
  }
});

test('identify_for_closet drift is rejected: certified v140 has exactly two intents', () => {
  const result = certifiedSource.verifyCertifiedBoundaries(null);
  const intents = result.checks.find((c) => c.check === 'intents_are_v140');
  assert.deepEqual(intents.observed, ['identify_and_shop', 'identify_for_style']);
  assert.equal(result.checks.find((c) => c.check === 'identify_for_closet_absent').ok, true);
});

// ── Adapter construction ─────────────────────────────────────────────────────

certTest('the adapter refuses to construct against a non-certified root', () => {
  assert.throws(
    () => createCertifiedAdapter({ certRoot: RESEARCH_ROOT }),
    /certified v140 source root rejected/
  );
  // With neither --cert-root nor the environment variable, construction must be
  // refused. The env var is cleared for this assertion specifically: leaving an
  // ambient KSCAN_CERT_V140_ROOT in place would satisfy the fallback and turn a
  // negative test into a false failure depending on how the suite was invoked.
  const previous = process.env.KSCAN_CERT_V140_ROOT;
  delete process.env.KSCAN_CERT_V140_ROOT;
  try {
    assert.throws(() => createCertifiedAdapter({ argv: [] }), /certified v140 source root rejected/);
  } finally {
    if (previous !== undefined) process.env.KSCAN_CERT_V140_ROOT = previous;
  }
});

certTest('the adapter uses the certified production model route', () => {
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT });
  assert.equal(adapter.models.primary, 'gemini-3.6-flash');
  assert.equal(adapter.models.fallback, 'gemini-3.5-flash-lite');
  assert.equal(adapter.intent, 'identify_for_style');
  assert.equal(adapter.contractVersion, 'fashion-identification-v2');
});

certTest('the adapter ships no model transport, so it cannot call by accident', () => {
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT });
  assert.throws(
    () => adapter.invokeModel({ prompt: 'x', imageCount: 1, caseId: 'c1' }),
    /no provider injected/
  );
  assert.equal(adapter.invariants().modelCallCount, 0);
});

// ── Side-effect boundaries ───────────────────────────────────────────────────

test('boundary stubs throw rather than silently succeeding', () => {
  const commerce = throwingBoundary('commerce');
  assert.throws(() => commerce.search('red sneaker'), BoundaryViolation);
  // A no-op stub would let a real call path pass unnoticed; throwing surfaces it.
  try {
    commerce.search('x');
    assert.fail('expected a BoundaryViolation');
  } catch (error) {
    assert.equal(error.boundary, 'commerce');
  }
});

certTest('commerce, catalog, persistence, telemetry and endpoints are all unreachable', () => {
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT });
  for (const name of ['commerce', 'catalogRetrieval', 'persistence', 'telemetry', 'productionEndpoint']) {
    assert.throws(() => adapter.boundaries[name].anyMethod({}), BoundaryViolation, `${name} must be unreachable`);
  }
  const invariants = adapter.invariants();
  assert.equal(invariants.commerceCallCount, 0);
  assert.equal(invariants.catalogRetrievalCount, 0);
  assert.equal(invariants.persistenceWriteCount, 0);
  assert.equal(invariants.telemetryCount, 0);
  assert.equal(invariants.externalNetworkCount, 0);
  assert.equal(invariants.allZeroExceptModel, true);
});

// ── Deterministic mock provider ──────────────────────────────────────────────

certTest('mock: completed identification returns the certified envelope shape', () => {
  const provider = createMockProvider(SCENARIOS.COMPLETED);
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
  const { response, model, fallbackInvoked } = adapter.invokeModel({ prompt: 'p', imageCount: 1, caseId: 'c' });
  const parsed = JSON.parse(response.raw);
  assert.equal(model, 'gemini-3.6-flash');
  assert.equal(fallbackInvoked, false);
  // The envelope must carry the keys the certified parser reads.
  assert.equal(parsed.identification.item_type, 'footwear');
  assert.equal(parsed.identification.subtype, 'low_top_sneaker');
  assert.ok('confidence_score' in parsed.identification);
  assert.ok('visible_brand_text' in parsed.identification);
  assert.ok('logo_detected' in parsed.identification);
  assert.equal(adapter.invariants().allZeroExceptModel, true);
});

certTest('mock: partial, insufficient evidence, non-fashion and multi-item shapes', () => {
  const cases = [
    [SCENARIOS.PARTIAL, (p) => assert.equal(p.identification.subtype, null)],
    [SCENARIOS.INSUFFICIENT_EVIDENCE, (p) => assert.equal(p.identification.status, 'insufficient_visual_evidence')],
    [SCENARIOS.NON_FASHION, (p) => assert.equal(p.identification.non_fashion, true)],
    [SCENARIOS.MULTI_ITEM, (p) => assert.equal(p.candidates.length, 2)],
  ];
  for (const [scenario, check] of cases) {
    const provider = createMockProvider(scenario);
    const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
    const { response } = adapter.invokeModel({ prompt: 'p', imageCount: 1, caseId: scenario });
    check(JSON.parse(response.raw));
    assert.equal(adapter.invariants().allZeroExceptModel, true);
  }
});

certTest('mock: a malformed envelope is returned as raw text, not pre-parsed', () => {
  const provider = createMockProvider(SCENARIOS.MALFORMED_ENVELOPE);
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
  const { response } = adapter.invokeModel({ prompt: 'p', imageCount: 1, caseId: 'c' });
  assert.throws(() => JSON.parse(response.raw), SyntaxError, 'the production parser must see the malformed text itself');
});

certTest('mock: a schema failure is valid JSON with none of the expected keys', () => {
  const provider = createMockProvider(SCENARIOS.SCHEMA_FAILURE);
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
  const { response } = adapter.invokeModel({ prompt: 'p', imageCount: 1, caseId: 'c' });
  const parsed = JSON.parse(response.raw);
  assert.equal('identification' in parsed, false);
  assert.equal('attributes' in parsed, false);
});

certTest('mock: primary failure falls back to the certified fallback model', () => {
  const provider = createMockProvider(SCENARIOS.FALLBACK_SUCCESS);
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
  const result = adapter.invokeModel({ prompt: 'p', imageCount: 1, caseId: 'c' });
  assert.equal(result.fallbackInvoked, true);
  assert.equal(result.model, 'gemini-3.5-flash-lite');
  assert.deepEqual(provider.modelsUsed(), ['gemini-3.6-flash', 'gemini-3.5-flash-lite']);
  assert.equal(adapter.invariants().modelCallCount, 2);
});

certTest('mock: primary and fallback both failing raises a bounded failure', () => {
  const provider = createMockProvider(SCENARIOS.BOTH_FAIL);
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
  assert.throws(
    () => adapter.invokeModel({ prompt: 'p', imageCount: 1, caseId: 'c' }),
    /primary and fallback model attempts both failed/
  );
  assert.equal(provider.callCount(), 2);
});

certTest('the ledger records no prompt, image bytes, token or credential', () => {
  const provider = createMockProvider(SCENARIOS.FALLBACK_SUCCESS);
  const adapter = createCertifiedAdapter({ certRoot: CERT_ROOT, provider });
  adapter.invokeModel({ prompt: 'SECRET-PROMPT-TEXT', imageCount: 1, caseId: 'case-1' });
  const serialized = JSON.stringify(adapter.ledger);
  assert.equal(serialized.includes('SECRET-PROMPT-TEXT'), false);
  assert.deepEqual(Object.keys(adapter.ledger[0]).sort(), ['attempt', 'caseId', 'kind', 'model', 'outcome']);
});

// ── Zero-network and zero-cost guard ─────────────────────────────────────────

// Phase 0H: the seed manifest is now inadmissible (all eight cases reference
// excluded imagery), so the runner refuses at the manifest gate. The zero-network
// property is what matters here and it still holds: fetch is never touched.
test('the runner performs zero network activity even when it refuses a manifest', () => {
  const originalFetch = globalThis.fetch;
  let networkAttempts = 0;
  globalThis.fetch = (...args) => {
    networkAttempts += 1;
    throw new Error(`network access denied in test: ${String(args[0])}`);
  };
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0d-dry-'));
    const result = runBaseline.main(['--dry-run', '--output-dir', dir], {
      executor: () => {
        throw new Error('executor must never run in a dry run');
      },
      now: '2026-07-29T00:00:00.000Z',
    });
    process.exitCode = 0;
    assert.equal(result.ok, false, 'excluded imagery must be refused');
    assert.equal(networkAttempts, 0, 'no network access at any point');
    assert.equal(fs.existsSync(path.join(dir, runnerState.CASES_DIR)), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the allowed pre-authorization spend is exactly $0.00', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase0d-cost-'));
  const result = runBaseline.main(['--dry-run', '--output-dir', dir], { now: '2026-07-29T00:00:00.000Z' });
  process.exitCode = 0;
  // No nominal development allowance. Nothing was planned or executed at all.
  assert.equal(result.ok, false);
  assert.equal(result.executedCallCount, undefined);
});

test('execution without an injected adapter is refused', () => {
  assert.throws(() => runBaseline.unauthorizedExecutor(), /No execution adapter is installed/);
});
