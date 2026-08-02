'use strict';

/**
 * Phase 4C.2 — countTokens preflight and reservation lifecycle. Zero provider calls.
 *
 * The invariant under test throughout: confirmed + outstanding reservations
 * never exceeds the ceiling, and no reservation is ever double-counted or
 * double-released.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const pr = require('../lib/preflightReservation');
const gs = require('../lib/governedStorage');

const PRICING = JSON.parse(
  fs.readFileSync(path.join(gs.ROOT, 'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json'), 'utf8')
);
const PRIMARY = 'gemini-3.6-flash';
const FALLBACK = 'gemini-3.5-flash-lite';

const newLedger = (over = {}) =>
  new pr.ReservationLedger({ pricing: PRICING, spendCeilingUsd: 10, attemptCeiling: 200, ...over });

const reserve = (ledger, caseId, over = {}) =>
  ledger.reserveCase({
    caseId,
    primaryModel: PRIMARY,
    fallbackModel: FALLBACK,
    primaryInputTokens: 2532,
    fallbackInputTokens: 2540,
    ...over,
  });

// ── Per-model counting ──────────────────────────────────────────────────────

test('primary and fallback are counted separately; a missing count is refused', () => {
  const ledger = newLedger();
  assert.strictEqual(reserve(ledger, 'c1', { fallbackInputTokens: undefined }).reason, 'cost_preflight_failed');
  assert.strictEqual(reserve(ledger, 'c2', { primaryInputTokens: null }).reason, 'cost_preflight_failed');
  assert.strictEqual(reserve(ledger, 'c3', { fallbackModel: null }).reason, 'cost_preflight_failed');
});

test('differing per-model token counts produce differing reservations', () => {
  const a = newLedger();
  const r1 = reserve(a, 'c1', { fallbackInputTokens: 2540 });
  const b = newLedger();
  const r2 = reserve(b, 'c1', { fallbackInputTokens: 5000 });
  assert.notStrictEqual(r1.fallbackUsd, r2.fallbackUsd, 'the fallback count must actually drive its reservation');
});

// ── Ceiling holds against confirmed + outstanding ───────────────────────────

test('the ceiling is enforced against confirmed plus outstanding reservations', () => {
  const ledger = newLedger({ spendCeilingUsd: 0.05 });
  const first = reserve(ledger, 'c1');
  assert.strictEqual(first.authorized, true);
  // The second is refused because the first is still outstanding, even though
  // nothing has been confirmed yet.
  const second = reserve(ledger, 'c2');
  assert.strictEqual(second.authorized, false);
  assert.strictEqual(second.reason, 'cost_ceiling');
  assert.strictEqual(ledger.confirmedUsd, 0);
  assert.ok(ledger.outstandingUsd() > 0);
});

test('the attempt ceiling reserves the certified pair', () => {
  const ledger = newLedger({ attemptCeiling: 1 });
  assert.strictEqual(reserve(ledger, 'c1').reason, 'attempt_ceiling');
});

test('a case cannot be reserved twice', () => {
  const ledger = newLedger();
  assert.strictEqual(reserve(ledger, 'c1').authorized, true);
  assert.strictEqual(reserve(ledger, 'c1').reason, 'already_reserved');
});

// ── Lifecycle A: primary succeeds, fallback unused ──────────────────────────

test('A: primary confirms and the unused fallback is released exactly once', () => {
  const ledger = newLedger();
  const r = reserve(ledger, 'c1');
  const reservedTotal = ledger.outstandingUsd();

  ledger.confirmAttempt({ caseId: 'c1', role: 'primary', promptTokenCount: 2532, candidatesTokenCount: 300, thoughtsTokenCount: 0, totalTokenCount: 2832 });
  const released = ledger.release({ caseId: 'c1', role: 'fallback' });
  assert.strictEqual(released.released, true);

  const t = ledger.totals();
  assert.strictEqual(t.primaryReservationsConfirmed, 1);
  assert.strictEqual(t.fallbackReservationsReleasedUnused, 1);
  assert.strictEqual(t.conservativeUnresolvedUsd, 0);
  assert.ok(t.confirmedUsd > 0 && t.confirmedUsd < reservedTotal, 'confirmed cost must replace, not add to, the reservation');
  assert.strictEqual(t.totalGenerateAttempts, 1);

  // Releasing again must not double-release.
  const again = ledger.release({ caseId: 'c1', role: 'fallback' });
  assert.strictEqual(again.released, false);
  assert.strictEqual(ledger.totals().doubleReleasePrevented, 1);
});

test('confirmed cost is retained even if later parsing or scoring fails', () => {
  const ledger = newLedger();
  reserve(ledger, 'c1');
  ledger.confirmAttempt({ caseId: 'c1', role: 'primary', promptTokenCount: 2532, candidatesTokenCount: 300, thoughtsTokenCount: 0, totalTokenCount: 2832 });
  const spend = ledger.confirmedUsd;
  ledger.release({ caseId: 'c1', role: 'fallback' });
  // A downstream validation failure changes no accounting.
  assert.strictEqual(ledger.confirmedUsd, spend);
});

// ── Lifecycle B: primary fails terminally, no fallback ──────────────────────

test('B: a failed primary with no usage metadata keeps its conservative reservation', () => {
  const ledger = newLedger();
  reserve(ledger, 'c1');
  const retained = ledger.retainUnknown({ caseId: 'c1', role: 'primary' });
  assert.strictEqual(retained.applied, true);
  ledger.release({ caseId: 'c1', role: 'fallback' });

  const t = ledger.totals();
  assert.strictEqual(t.primaryReservationsRetainedUnknown, 1);
  assert.ok(t.conservativeUnresolvedUsd > 0, 'a failed request must never be assumed free');
  assert.strictEqual(t.confirmedUsd, 0);
  assert.strictEqual(t.totalGenerateAttempts, 1);
});

// ── Lifecycle C: fallback executes ─────────────────────────────────────────

test('C: both attempts confirm, and neither reservation is added on top', () => {
  const ledger = newLedger();
  const r = reserve(ledger, 'c1');
  ledger.confirmAttempt({ caseId: 'c1', role: 'primary', promptTokenCount: 2532, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 2542 });
  ledger.confirmAttempt({ caseId: 'c1', role: 'fallback', promptTokenCount: 2540, candidatesTokenCount: 280, thoughtsTokenCount: 0, totalTokenCount: 2820 });

  const t = ledger.totals();
  assert.strictEqual(t.conservativeUnresolvedUsd, 0);
  assert.ok(t.confirmedUsd < r.caseUsd, 'confirmed must be below the worst-case reservation');
  assert.strictEqual(t.primaryGenerateAttempts, 1);
  assert.strictEqual(t.fallbackGenerateAttempts, 1);
  assert.strictEqual(t.fallbackReservationsUsed, 1);
});

test('confirming the same slot twice is prevented', () => {
  const ledger = newLedger();
  reserve(ledger, 'c1');
  ledger.confirmAttempt({ caseId: 'c1', role: 'primary', promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 });
  const spend = ledger.confirmedUsd;
  const second = ledger.confirmAttempt({ caseId: 'c1', role: 'primary', promptTokenCount: 100, candidatesTokenCount: 10, thoughtsTokenCount: 0, totalTokenCount: 110 });
  assert.strictEqual(second.applied, false);
  assert.strictEqual(ledger.confirmedUsd, spend);
  assert.strictEqual(ledger.totals().doubleCountPrevented, 1);
});

// ── Lifecycle D and E ──────────────────────────────────────────────────────

test('D: countTokens succeeded but generation never dispatched releases the whole case', () => {
  const ledger = newLedger();
  reserve(ledger, 'c1');
  ledger.releaseCase({ caseId: 'c1' });
  const t = ledger.totals();
  assert.strictEqual(t.conservativeUnresolvedUsd, 0);
  assert.strictEqual(t.confirmedUsd, 0);
  assert.strictEqual(t.totalGenerateAttempts, 0);
});

test('E: a dispatched request whose response is lost stays cost-unknown', () => {
  const ledger = newLedger();
  reserve(ledger, 'c1');
  ledger.retainUnknown({ caseId: 'c1', role: 'primary' });
  assert.ok(ledger.outstandingUsd() > 0);
});

test('the ledger never double-counts or double-releases across a mixed run', () => {
  const ledger = newLedger();
  reserve(ledger, 'a');
  ledger.confirmAttempt({ caseId: 'a', role: 'primary', promptTokenCount: 2000, candidatesTokenCount: 100, thoughtsTokenCount: 0, totalTokenCount: 2100 });
  ledger.release({ caseId: 'a', role: 'fallback' });
  reserve(ledger, 'b');
  ledger.retainUnknown({ caseId: 'b', role: 'primary' });
  ledger.release({ caseId: 'b', role: 'fallback' });

  const t = ledger.totals();
  assert.strictEqual(t.doubleCountedReservations, 0);
  assert.strictEqual(t.doubleReleasedReservations, 0);
  assert.ok(t.totalAccountedUsd <= t.spendCeilingUsd);
});

// ── countTokens policy, kept separate from v140 ────────────────────────────

test('the countTokens request cap is derived, not shared with the generation ceiling', () => {
  assert.strictEqual(pr.countTokensRequestCap(40, 2), 160);
  assert.strictEqual(pr.COUNT_TOKENS_POLICY.maxAttemptsPerModelPerCase, 2);
  assert.strictEqual(pr.COUNT_TOKENS_POLICY.timeoutMs, 14_000);
});

test('countTokens retry classification matches its own policy', () => {
  for (const status of [429, 503, 504]) {
    assert.strictEqual(pr.isCountTokensRetryable({ httpStatus: status }), true, String(status));
  }
  for (const status of [400, 401, 403, 404, 422]) {
    assert.strictEqual(pr.isCountTokensRetryable({ httpStatus: status }), false, String(status));
  }
  for (const code of ['ETIMEDOUT', 'ECONNRESET']) {
    assert.strictEqual(pr.isCountTokensRetryable({ networkCode: code }), true, code);
  }
  // An unlisted status is not retried by default.
  assert.strictEqual(pr.isCountTokensRetryable({ httpStatus: 418 }), false);
});

test('Retry-After is honoured and capped at 30 seconds', () => {
  assert.strictEqual(pr.countTokensBackoffMs(1, '5'), 5_000);
  assert.strictEqual(pr.countTokensBackoffMs(1, '120'), 30_000);
  assert.ok(pr.countTokensBackoffMs(1, null) <= pr.COUNT_TOKENS_POLICY.maxBackoffMs);
  assert.ok(pr.countTokensBackoffMs(2, null) >= pr.countTokensBackoffMs(1, null));
});

// ── Exact-request cache identity ───────────────────────────────────────────

const identityBase = {
  model: PRIMARY,
  serializedRequestPayload: '{"contents":[...]}',
  imageSha256: 'a'.repeat(64),
  systemInstructionSha256: 'b'.repeat(64),
  promptSha256: 'c'.repeat(64),
  toolDeclarationsSha256: 'd'.repeat(64),
  generationConfigSha256: 'e'.repeat(64),
  certifiedSourceSha256: 'f'.repeat(64),
  datasetVersion: '0.3.1',
  selectionContractSha256: '9'.repeat(64),
  // Control and candidate differ in nothing else this identity covers, so the
  // candidate version is a required component. The three tests below iterate
  // Object.keys(identityBase), which makes it a first-class member of the
  // "must change the identity" and "may not be omitted" proofs.
  candidateVersion: 'certified-v140',
};

test('different image bytes can never share a cached count', () => {
  const a = pr.exactRequestIdentity(identityBase);
  const b = pr.exactRequestIdentity({ ...identityBase, imageSha256: '1'.repeat(64) });
  assert.notStrictEqual(a, b, 'CROSS-IMAGE CACHE REUSE must be 0');
});

test('every token-relevant component changes the cache identity', () => {
  const base = pr.exactRequestIdentity(identityBase);
  for (const key of Object.keys(identityBase)) {
    const mutated = pr.exactRequestIdentity({ ...identityBase, [key]: `${identityBase[key]}-changed` });
    assert.notStrictEqual(mutated, base, `${key} must participate in the cache identity`);
  }
});

test('an incomplete cache identity is refused rather than hashed loosely', () => {
  for (const key of Object.keys(identityBase)) {
    const partial = { ...identityBase };
    delete partial[key];
    assert.throws(() => pr.exactRequestIdentity(partial), /incomplete/);
  }
});

test('the same exact request yields a stable identity', () => {
  assert.strictEqual(pr.exactRequestIdentity(identityBase), pr.exactRequestIdentity({ ...identityBase }));
});

// ── Billing status ─────────────────────────────────────────────────────────

test('an unverified countTokens charge is included in the ceiling, not assumed zero', () => {
  const free = newLedger({ countTokensBillable: false });
  const billed = newLedger({ countTokensBillable: true });
  reserve(free, 'c1', { countTokensChargeUsd: 0.01 });
  reserve(billed, 'c1', { countTokensChargeUsd: 0.01 });
  assert.strictEqual(free.confirmedUsd, 0);
  assert.ok(billed.confirmedUsd > 0, 'a possible preflight charge must enter the accounting');
});
