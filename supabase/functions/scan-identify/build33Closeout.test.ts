// Build 33 backend closeout — B33-COM-001 / B33-SEC-002 / B33-SEC-003 / B33-OBS-001.
//
// These run the repaired code rather than reading it as text wherever the code
// is reachable: scanQuota.ts was extracted precisely so quota decisions could be
// executed by a test (a source-text assertion cannot tell "fails closed" from
// "returns a shape containing the right words"). The MODE B route still lives
// inside index.ts, whose only entry point calls Deno.serve at import time, so
// its ORDERING is asserted structurally — an ordering claim is exactly what a
// source assertion can carry honestly.

import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  canonicalizeQuotaBucket,
  canonicalizeScanMode,
  checkAuthenticatedScanQuota,
  COMMERCE_ONLY_QUOTA_MODE,
  getScanIdentifyDailyLimit,
  SCAN_IDENTIFY_COMMERCE_ONLY_DAILY_LIMIT_DEFAULT,
  SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT,
  SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT,
} from './scanQuota.ts';
import { mapToFailureReason } from './commerceRelevanceFailure.ts';

const indexSource = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

// ── B33-SEC-003 — canonical mode vocabulary ────────────────────────────────

Deno.test('B33-SEC-003: the exact strings that minted fresh buckets all collapse to image', () => {
  // Measured on staging before the repair: each of these reached its own 30/day
  // bucket for one authenticated user — 240 paid scans against a 30/day limit.
  for (const spelling of ['image2', 'img', 'image ', 'imagex', 'scan', 'a', 'image-2', 'IMAGE']) {
    assertEquals(
      canonicalizeScanMode(spelling),
      'image',
      `${JSON.stringify(spelling)} must not be able to open its own quota namespace`,
    );
  }
});

Deno.test('B33-SEC-003: text survives normalisation, including padding and case', () => {
  for (const spelling of ['text', 'TEXT', ' text ', '  TeXt\t']) {
    assertEquals(canonicalizeScanMode(spelling), 'text');
  }
});

Deno.test('B33-SEC-003: non-strings fail toward the SMALLER allowance', () => {
  // null/undefined/number/object must not land in the 50/day text bucket.
  for (const raw of [null, undefined, 0, 1, {}, [], true, NaN]) {
    assertEquals(canonicalizeScanMode(raw), 'image', `${String(raw)} must be the image bucket`);
  }
});

Deno.test('B33-SEC-003: a caller cannot reach the MODE B namespace through mode', () => {
  // commerce_only is server-selected. If caller input could produce it, a user
  // could choose which bucket to spend from.
  assertEquals(canonicalizeScanMode('commerce_only'), 'image');
  assertEquals(canonicalizeScanMode('COMMERCE_ONLY'), 'image');
});

Deno.test('B33-SEC-003: the bucket guard admits exactly three namespaces', () => {
  assertEquals(canonicalizeQuotaBucket('image'), 'image');
  assertEquals(canonicalizeQuotaBucket('text'), 'text');
  assertEquals(canonicalizeQuotaBucket(COMMERCE_ONLY_QUOTA_MODE), COMMERCE_ONLY_QUOTA_MODE);
  for (const raw of ['img', 'commerce', '', '   ', null, 42]) {
    assertEquals(canonicalizeQuotaBucket(raw), 'image');
  }
});

Deno.test('B33-SEC-003: each canonical bucket carries its own default allowance', () => {
  const noEnv = () => undefined;
  assertEquals(getScanIdentifyDailyLimit('image', noEnv), SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
  assertEquals(getScanIdentifyDailyLimit('text', noEnv), SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT);
  assertEquals(
    getScanIdentifyDailyLimit(COMMERCE_ONLY_QUOTA_MODE, noEnv),
    SCAN_IDENTIFY_COMMERCE_ONLY_DAILY_LIMIT_DEFAULT,
  );
  // An arbitrary spelling must not obtain the larger text allowance.
  assertEquals(getScanIdentifyDailyLimit('texty', noEnv), SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
});

/** Records what actually reaches the durable unique key. */
function spyClient(rows: unknown) {
  const calls: Array<Record<string, unknown>> = [];
  return {
    calls,
    client: {
      rpc(_name: string, params: Record<string, unknown>) {
        calls.push(params);
        return Promise.resolve({ data: rows, error: null });
      },
    },
  };
}

Deno.test('B33-SEC-003: the value keying the durable bucket is canonical, not the caller string', async () => {
  for (const spelling of ['img', 'image2', 'IMAGE', 'scan', 'image ']) {
    const spy = spyClient([{ allowed: true, count: 1, limit: 30 }]);
    await checkAuthenticatedScanQuota(spy.client, 'user-1', spelling, 'user-1', () => undefined);
    assertEquals(spy.calls.length, 1);
    assertEquals(
      spy.calls[0].p_mode,
      'image',
      `p_mode must be canonical; ${JSON.stringify(spelling)} leaked into the unique key`,
    );
    assertEquals(spy.calls[0].p_daily_limit, SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
  }
});

Deno.test('B33-SEC-003: text and MODE B keep their own distinct buckets', async () => {
  const t = spyClient([{ allowed: true, count: 1, limit: 50 }]);
  await checkAuthenticatedScanQuota(t.client, 'u', 'TEXT', 'u', () => undefined);
  assertEquals(t.calls[0].p_mode, 'text');

  const c = spyClient([{ allowed: true, count: 1, limit: 60 }]);
  await checkAuthenticatedScanQuota(c.client, 'u', COMMERCE_ONLY_QUOTA_MODE, 'u', () => undefined);
  assertEquals(c.calls[0].p_mode, COMMERCE_ONLY_QUOTA_MODE);
  assertEquals(c.calls[0].p_daily_limit, SCAN_IDENTIFY_COMMERCE_ONLY_DAILY_LIMIT_DEFAULT);
});

Deno.test('B33-SEC-003: quota stays fail-CLOSED when it cannot be consulted', async () => {
  const missing = await checkAuthenticatedScanQuota(null, 'u', 'image', 'u', () => undefined);
  assertEquals(missing.outcome, 'unverified');

  const erroring = {
    rpc: () => Promise.resolve({ data: null, error: new Error('boom') }),
  };
  const failed = await checkAuthenticatedScanQuota(erroring, 'u', 'image', 'u', () => undefined);
  assertEquals(failed.outcome, 'unverified');

  const malformed = { rpc: () => Promise.resolve({ data: [{ nonsense: true }], error: null }) };
  const bad = await checkAuthenticatedScanQuota(malformed, 'u', 'image', 'u', () => undefined);
  assertEquals(bad.outcome, 'unverified');
});

Deno.test('B33-SEC-003: an exhausted bucket is exceeded, never silently allowed', async () => {
  const spy = spyClient([{ allowed: false, count: 30, limit: 30 }]);
  const d = await checkAuthenticatedScanQuota(spy.client, 'u', 'image', 'u', () => undefined);
  assertEquals(d.outcome, 'exceeded');
});

// ── B33-SEC-002 — MODE B requires an account, bounded durably ──────────────

function indexOfAll(...needles: string[]): number[] {
  return needles.map((n) => {
    const i = indexSource.indexOf(n);
    assert(i !== -1, `expected to find ${JSON.stringify(n)} in index.ts`);
    return i;
  });
}

Deno.test('B33-SEC-002: MODE B rejects unauthenticated callers before any work', () => {
  const [authGate, burst, durable, evidence, provider] = indexOfAll(
    "error: auth.authError ? 'commerce_only_auth_invalid' : 'commerce_only_auth_required'",
    "error: 'commerce_only_rate_limited'",
    'commerce_only_quota_blocked',
    'const evidence = readCommerceOnlyEvidence(body);',
    'const fast = await getFastCommerceResults({',
  );
  assert(authGate < burst, 'authentication must be checked before the burst guard');
  assert(burst < durable, 'the cheap burst guard must short-circuit before the database round-trip');
  assert(durable < evidence, 'quota must be settled before the request body is parsed');
  assert(evidence < provider, 'nothing may reach a provider before parsing');
});

Deno.test('B33-SEC-002: the MODE B auth gate covers missing, invalid and anonymous principals', () => {
  const block = indexSource.slice(indexSource.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body))'));
  assert(block.includes('!auth.isAuthenticated || !userId || auth.authError'), 'missing and malformed auth must both fail closed');
  assert(block.includes('if (auth.isAnonymous)'), 'a signInAnonymously() session is not a billable principal');
  assert(block.includes("'commerce_only_auth_required'"));
  assert(block.includes("'commerce_only_auth_invalid'"));
});

Deno.test('B33-SEC-002: MODE B is bounded by the durable bucket, not only the isolate map', () => {
  const block = indexSource.slice(indexSource.indexOf('if (commerceFunnelEnabled && isCommerceOnlyRequest(body))'));
  assert(
    block.includes('checkAuthenticatedScanQuota(') && block.includes('COMMERCE_ONLY_QUOTA_MODE'),
    'MODE B must consult the durable daily bucket',
  );
  // Fail closed: an unverifiable quota must not fall through to a provider.
  assert(block.includes("commerceOnlyQuota.outcome !== 'allowed'"));
  assert(block.includes("'commerce_only_quota_unverified'"));
});

// ── B33-OBS-001 — the five commerce outcomes stay distinguishable ──────────

Deno.test('B33-OBS-001: timeout, empty, failure and success are four different answers', () => {
  assertEquals(mapToFailureReason({ providerOutcome: 'timeout' }), 'provider_timeout');
  assertEquals(mapToFailureReason({ providerOutcome: 'commerce_timeout' }), 'provider_timeout');
  assertEquals(mapToFailureReason({ providerOutcome: 'error' }), 'provider_error');
  assertEquals(mapToFailureReason({ commercePrimaryEmpty: true }), 'commerce_primary_empty');
  assertEquals(mapToFailureReason({}), null, 'a successful commerce result has no failure reason');
});

Deno.test('B33-OBS-001: a timeout outranks the empty-shelf reading', () => {
  // The defect: a timed-out lookup returned provider 'none', so it was recorded
  // as commerce_primary_empty and the failure became invisible. Both signals
  // present must resolve to the timeout.
  assertEquals(
    mapToFailureReason({ providerOutcome: 'timeout', commercePrimaryEmpty: true }),
    'provider_timeout',
  );
});

Deno.test('B33-OBS-001: the image timeout path reports itself as a timeout', () => {
  const race = indexSource.indexOf("setTimeout(() => resolve('commerce_timeout')");
  assert(race !== -1, 'image mode must still race commerce against a timeout');
  const after = indexSource.slice(race, race + 2500);
  assert(
    after.includes("commerceProvider = 'timeout';"),
    'a timed-out image commerce lookup must not be left reported as provider none',
  );
});

Deno.test('B33-OBS-001: commerce that never ran is marked skipped, not empty', () => {
  assert(indexSource.includes('commerceSkipped: true'), 'skip paths must flag commerceSkipped');
  assert(
    indexSource.includes("'deferred_to_commerce_only_request'"),
    'a deferred lookup must say deferred rather than report an empty shelf',
  );
});

// ── B33-COM-001 — the budget invariant ────────────────────────────────────

Deno.test('B33-COM-001: the image commerce budget exceeds the provider abort', async () => {
  const providerSource = await Deno.readTextFile(new URL('./shoppingProvider.ts', import.meta.url));
  const budget = Number(/IMAGE_MODE_COMMERCE_TIMEOUT_MS = (\d+)/.exec(indexSource)?.[1]);
  const abort = Number(/PROVIDER_TIMEOUT_MS = (\d+)/.exec(providerSource)?.[1]);
  assert(Number.isFinite(budget) && Number.isFinite(abort));
  assert(
    budget > abort,
    `image commerce budget (${budget}ms) must exceed the provider abort (${abort}ms), `
      + 'or a result arriving between the two is discarded after the spend is billed',
  );
});
