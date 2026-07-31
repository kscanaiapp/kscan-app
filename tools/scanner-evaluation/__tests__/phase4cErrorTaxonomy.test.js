'use strict';

/**
 * Phase 4C — the closed error taxonomy and the provider-to-scorer gate.
 *
 * Zero provider calls. Every certified failure kind must land in exactly one
 * category, invalid output must never be scored or retried, and a transport
 * failure must not also be counted as a parse failure.
 */

const test = require('node:test');
const assert = require('node:assert');

const taxonomy = require('../lib/errorTaxonomy');
const live = require('../lib/liveAdapter');

// ── Totality ────────────────────────────────────────────────────────────────

test('every certified provider failure kind maps to exactly one category', () => {
  assert.deepStrictEqual(
    taxonomy.unmappedCertifiedKinds(),
    [],
    'UNMAPPED ERROR PATHS must be 0'
  );
  for (const kind of taxonomy.CERTIFIED_FAILURE_KINDS) {
    const category = taxonomy.fromCertifiedKind(kind);
    assert.ok(taxonomy.isKnown(category), `${kind} maps to unknown category ${category}`);
  }
});

test('the certified kind list matches the certified source enum', () => {
  // Read from _shared/llmModelRouting.ts at the certified commit. If certified
  // v140 ever gains a kind, this list and the map must be updated together.
  assert.strictEqual(taxonomy.CERTIFIED_FAILURE_KINDS.length, 17);
  for (const expected of ['http_429_quota', 'oversized_context', 'safety_block', 'invalid_model']) {
    assert.ok(taxonomy.CERTIFIED_FAILURE_KINDS.includes(expected));
  }
});

test('no category is unreachable', () => {
  assert.deepStrictEqual(taxonomy.unreachableCategories(), []);
});

test('an unknown certified kind throws rather than silently bucketing', () => {
  assert.throws(() => taxonomy.fromCertifiedKind('a_kind_that_does_not_exist'), /unmapped/);
});

// ── Certified retry semantics are preserved, not reinvented ─────────────────

test('permanent certified failures are never marked retryable', () => {
  // Mirrors RETRYABLE_KINDS in the certified source: a hard-quota 429 and a
  // deterministic oversized context are permanent despite transient-looking codes.
  for (const kind of ['http_429_quota', 'oversized_context', 'auth_error', 'invalid_model', 'http_client_error']) {
    const category = taxonomy.fromCertifiedKind(kind);
    assert.strictEqual(taxonomy.CATEGORIES[category].retryable, false, `${kind} must not be retryable`);
  }
});

test('transient certified failures remain retryable', () => {
  for (const kind of ['timeout', 'network', 'http_408', 'http_429_transient', 'http_5xx_transient', 'http_unavailable', 'http_deadline_exceeded']) {
    const category = taxonomy.fromCertifiedKind(kind);
    assert.strictEqual(taxonomy.CATEGORIES[category].retryable, true, `${kind} must stay retryable`);
  }
});

test('invalid output is never retryable under any certified kind', () => {
  for (const kind of ['schema_failure', 'empty_response', 'malformed']) {
    assert.strictEqual(taxonomy.fromCertifiedKind(kind), 'provider_output_invalid');
  }
  assert.strictEqual(taxonomy.CATEGORIES.provider_output_invalid.retryable, false);
});

test('a hard-quota 429 is not conflated with a transient 429', () => {
  assert.notStrictEqual(
    taxonomy.fromCertifiedKind('http_429_quota'),
    taxonomy.fromCertifiedKind('http_429_transient')
  );
});

test('the taxonomy hash is stable and changes when the taxonomy changes', () => {
  const first = taxonomy.taxonomyHash();
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.strictEqual(first, taxonomy.taxonomyHash());
});

// ── HTTP mapping ────────────────────────────────────────────────────────────

test('http status maps conservatively', () => {
  assert.strictEqual(taxonomy.fromHttpStatus(200), 'provider_success');
  assert.strictEqual(taxonomy.fromHttpStatus(408), 'provider_timeout');
  // Never guessed as permanent quota from the status alone.
  assert.strictEqual(taxonomy.fromHttpStatus(429), 'provider_rate_limited');
  assert.strictEqual(taxonomy.fromHttpStatus(401), 'provider_auth_error');
  assert.strictEqual(taxonomy.fromHttpStatus(403), 'provider_auth_error');
  assert.strictEqual(taxonomy.fromHttpStatus(400), 'provider_client_error');
  assert.strictEqual(taxonomy.fromHttpStatus(503), 'provider_server_error');
});

// ── Adapter classification uses one enum, with exclusive stages ─────────────

test('adapter outcomes are all valid taxonomy categories', () => {
  const reports = [
    { providerAttempts: [{ errorCategory: 'timeout', httpStatus: 0 }] },
    { providerAttempts: [{ errorCategory: 'transport_error', httpStatus: 0 }] },
    { providerAttempts: [{ httpStatus: 503 }] },
    { providerAttempts: [{ httpStatus: 401 }] },
    { providerAttempts: [{ httpStatus: 400 }] },
    { providerAttempts: [{ httpStatus: 200 }], v2Present: false },
    { providerAttempts: [{ httpStatus: 200 }], v2Present: true },
    { providerAttempts: [{ httpStatus: 200 }], handlerError: 'boom' },
    { providerAttempts: [], counters: { unexpectedNetworkAttempts: 1 } },
    null,
  ];
  for (const report of reports) {
    const outcome = live.classifyOutcome(report);
    assert.ok(taxonomy.isKnown(outcome.status), `unknown category ${outcome.status}`);
  }
});

test('a transport failure is not also counted as a parse failure', () => {
  const record = live.buildCaseRecord({
    caseId: 'c',
    report: { handlerLatencyMs: 1, v2Present: false, observed: null, counters: {}, providerAttempts: [{ httpStatus: 503 }] },
    runIdentityRecord: {
      runId: 'r', datasetVersion: '0.3.1', datasetManifestSha256: 'm', holdoutSealSha256: 's',
      sourceCommit: 'c', certifiedCommit: 'cc', certifiedBundleHash: 'b', modelConfigurationId: 'v140',
    },
    outcome: live.classifyOutcome({ providerAttempts: [{ httpStatus: 503 }], v2Present: false }),
    attemptsUsed: 2,
    costUsd: 0,
  });
  assert.strictEqual(record.status, 'provider_server_error');
  assert.strictEqual(record.parseStatus, 'not_reached', 'a request that never returned cannot have a parse verdict');
});

test('an arrived-but-invalid response is provider_output_invalid and is not scorable', () => {
  const outcome = live.classifyOutcome({ providerAttempts: [{ httpStatus: 200 }], v2Present: false });
  assert.strictEqual(outcome.status, 'provider_output_invalid');
  assert.strictEqual(outcome.stage, 'validation');
  assert.strictEqual(outcome.retryable, false, 'SCHEMA-INVALID RETRY ENABLED must be NO');
  assert.strictEqual(taxonomy.isScorable(outcome.status), false, 'INVALID OUTPUTS SCORED must be 0');
});

test('only a certified-valid response is scorable', () => {
  const ok = live.classifyOutcome({ providerAttempts: [{ httpStatus: 200 }], v2Present: true });
  assert.strictEqual(ok.status, 'provider_success');
  assert.strictEqual(taxonomy.isScorable(ok.status), true);

  for (const category of taxonomy.CATEGORY_NAMES.filter((c) => c !== 'provider_success')) {
    assert.strictEqual(taxonomy.isScorable(category), false, `${category} must not be scorable`);
  }
});

test('an isolation violation is terminal and never billable', () => {
  const outcome = live.classifyOutcome({ providerAttempts: [], counters: { unexpectedNetworkAttempts: 2 } });
  assert.strictEqual(outcome.status, 'network_blocked');
  assert.strictEqual(taxonomy.CATEGORIES.network_blocked.billable, false);
});

test('ceiling stops are terminal, non-retryable and non-billable', () => {
  for (const category of ['cost_ceiling', 'attempt_ceiling']) {
    assert.strictEqual(taxonomy.CATEGORIES[category].terminal, true);
    assert.strictEqual(taxonomy.CATEGORIES[category].retryable, false);
    assert.strictEqual(taxonomy.CATEGORIES[category].billable, false);
  }
});
