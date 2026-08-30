/**
 * Quota fail-closed contract (Build 34 blocker closure).
 *
 * The defect: `checkAuthenticatedScanQuota` returned `{ allowed: true }` when
 * the service-role client was missing AND when the quota RPC threw, errored, or
 * returned a malformed row. Every one of those is "we could not consult the
 * quota system", and every one of them authorised paid Gemini and paid commerce.
 *
 * These tests execute the real decision function. They do not read its source.
 * The mutation guard at the bottom asserts the linkage directly: the pre-repair
 * shape authorised paid work on an outage, and the repaired function, given the
 * identical failure, must not.
 */

import assert from 'node:assert/strict';
import {
  checkAuthenticatedScanQuota,
  getScanIdentifyDailyLimit,
  SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT,
  SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT,
  type ScanQuotaDecision,
} from './scanQuota.ts';
import { mapToFailureReason } from './commerceRelevanceFailure.ts';

const noEnv = () => undefined;

/**
 * A client whose rpc() behaves however the case under test needs, and which
 * records every call so we can prove the RPC really was attempted (or really
 * was not).
 */
function fakeClient(impl: () => unknown | Promise<unknown>) {
  const calls: unknown[][] = [];
  return {
    calls,
    client: {
      rpc: async (...args: unknown[]) => {
        calls.push(args);
        return await impl();
      },
    },
  };
}

/**
 * The predicate index.ts applies. Paid work is authorised ONLY by an explicit
 * `allowed`. Anything else stops the request before Gemini and before commerce.
 */
const authorisesPaidWork = (d: ScanQuotaDecision) => d.outcome === 'allowed';

// -- The two states that must keep working ----------------------------------

Deno.test('UNDER QUOTA: an allowed RPC result authorises the request', async () => {
  const { client, calls } = fakeClient(() => ({
    data: [{ allowed: true, count: 3, limit: 50 }],
    error: null,
  }));
  const d = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
  assert.equal(d.outcome, 'allowed');
  assert.equal(authorisesPaidWork(d), true);
  assert.equal(calls.length, 1, 'the quota RPC must actually be consulted');
  if (d.outcome === 'allowed') {
    assert.equal(d.count, 3);
    assert.equal(d.limit, 50);
  }
});

Deno.test('OVER QUOTA: a denied RPC result blocks, and stays distinguishable from an outage', async () => {
  const { client } = fakeClient(() => ({
    data: [{ allowed: false, count: 50, limit: 50 }],
    error: null,
  }));
  const d = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
  assert.equal(d.outcome, 'exceeded');
  assert.equal(authorisesPaidWork(d), false);
  // The user really is over their limit here, so this -- and only this -- is
  // allowed to map to quota_exceeded.
  assert.equal(mapToFailureReason({ quotaExceeded: true }), 'quota_exceeded');
});

// -- Failure injection: every way the quota system can be unavailable --------

Deno.test('FAIL CLOSED: no service-role client does not authorise paid work', async () => {
  for (const missing of [null, undefined, 0, '']) {
    const d = await checkAuthenticatedScanQuota(missing, 'user-1', 'image', 'u***1', noEnv);
    assert.equal(d.outcome, 'unverified', 'a falsy client must be unverified');
    assert.equal(authorisesPaidWork(d), false);
    if (d.outcome === 'unverified') assert.equal(d.reason, 'missing_service_role_client');
  }
});

Deno.test('FAIL CLOSED: an RPC that throws does not authorise paid work', async () => {
  const { client, calls } = fakeClient(() => {
    throw new Error('connection refused');
  });
  const d = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
  assert.equal(d.outcome, 'unverified');
  assert.equal(authorisesPaidWork(d), false);
  assert.equal(calls.length, 1, 'the RPC was attempted, so this is an outage not a skip');
});

Deno.test('FAIL CLOSED: an RPC that returns a database error does not authorise paid work', async () => {
  const { client } = fakeClient(() => ({
    data: null,
    error: { message: 'function does not exist', code: '42883' },
  }));
  const d = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
  assert.equal(d.outcome, 'unverified');
  assert.equal(authorisesPaidWork(d), false);
});

Deno.test('FAIL CLOSED: a rejected RPC promise does not authorise paid work', async () => {
  const { client } = fakeClient(() => Promise.reject(new Error('socket hang up')));
  const d = await checkAuthenticatedScanQuota(client, 'user-1', 'image', 'u***1', noEnv);
  assert.equal(d.outcome, 'unverified');
  assert.equal(authorisesPaidWork(d), false);
});

Deno.test('FAIL CLOSED: every malformed quota result shape does not authorise paid work', async () => {
  const malformed: unknown[] = [
    null,
    undefined,
    [],
    [{}],
    [{ allowed: 'true' }],
    [{ allowed: 1 }],
    [{ count: 3, limit: 50 }],
    { allowed: null },
    'not-a-row',
  ];
  for (const data of malformed) {
    const { client } = fakeClient(() => ({ data, error: null }));
    const d = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
    assert.equal(d.outcome, 'unverified', 'a malformed quota row must be unverified');
    assert.equal(authorisesPaidWork(d), false);
  }
});

// -- The infrastructure/exhaustion distinction -------------------------------

Deno.test('an outage is never reported to the user as "you exceeded your quota"', async () => {
  const { client } = fakeClient(() => {
    throw new Error('connection refused');
  });
  const d = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
  assert.equal(d.outcome, 'unverified');

  const reason = mapToFailureReason({ quotaUnverified: true });
  assert.equal(reason, 'quota_unverified');
  assert.notEqual(reason, 'quota_exceeded', 'an outage must not be logged as user exhaustion');

  // And the two conditions must not collapse into one telemetry value.
  assert.notEqual(
    mapToFailureReason({ quotaUnverified: true }),
    mapToFailureReason({ quotaExceeded: true }),
  );
});

Deno.test('quota_exceeded still wins when the user genuinely is over limit', () => {
  // Precedence guard: adding quota_unverified must not shadow the real limit.
  assert.equal(mapToFailureReason({ quotaExceeded: true, quotaUnverified: true }), 'quota_exceeded');
});

// -- Limits still resolve as before ------------------------------------------

Deno.test('daily limits keep their defaults and still honour env overrides', () => {
  assert.equal(getScanIdentifyDailyLimit('text', noEnv), SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT);
  assert.equal(getScanIdentifyDailyLimit('image', noEnv), SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
  assert.equal(getScanIdentifyDailyLimit('text', () => '7'), 7);
  assert.equal(getScanIdentifyDailyLimit('image', () => '0'), SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
  assert.equal(getScanIdentifyDailyLimit('image', () => 'abc'), SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
});

Deno.test('the limit passed to the RPC is the resolved limit for the mode', async () => {
  const { client, calls } = fakeClient(() => ({
    data: [{ allowed: true, count: 1, limit: 7 }],
    error: null,
  }));
  await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', () => '7');
  const params = calls[0][1] as Record<string, unknown>;
  assert.equal(params.p_daily_limit, 7);
  assert.equal(params.p_mode, 'text');
  assert.equal(params.p_user_id, 'user-1');
});

// -- Mutation guard ----------------------------------------------------------

Deno.test('MUTATION GUARD: the pre-repair fail-open would be rejected by this suite', async () => {
  // The exact shape the function returned before the repair, for both failure
  // paths. If someone reinstates it, `authorisesPaidWork` goes true on an
  // outage and every FAIL CLOSED test above breaks. This asserts that linkage
  // directly, so the guard fails loudly rather than the suite quietly passing.
  const preRepair = { allowed: true, count: 0, limit: 0 };
  const preRepairAuthorises = preRepair.allowed === true;
  assert.equal(
    preRepairAuthorises,
    true,
    'sanity: the old shape really did authorise paid work on infrastructure failure',
  );

  // The repaired function, given the identical failure, must not.
  const { client } = fakeClient(() => {
    throw new Error('connection refused');
  });
  const repaired = await checkAuthenticatedScanQuota(client, 'user-1', 'text', 'u***1', noEnv);
  assert.equal(authorisesPaidWork(repaired), false);
  assert.notEqual(
    authorisesPaidWork(repaired),
    preRepairAuthorises,
    'the repair must invert the pre-repair authorisation on quota-infrastructure failure',
  );

  // And the decision must carry no `allowed` field at all -- the field whose
  // mere presence made the old default-true possible.
  assert.equal(
    Object.prototype.hasOwnProperty.call(repaired, 'allowed'),
    false,
    'ScanQuotaDecision must expose no boolean a caller could read as default-true',
  );
});

// -- Wiring: the decision must gate paid work, not merely be computed ---------

/**
 * The decision function above is provably fail-closed, but a correct decision
 * that nothing acts on protects nothing. index.ts calls `Deno.serve` at import
 * time, so it cannot be imported and driven here; these assertions therefore
 * read its source to prove the branch exists and that it returns BEFORE the two
 * paid calls it is supposed to gate. Position, not mere presence: a fail-closed
 * branch placed after the Gemini call would still bill us.
 */
const indexSource = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));

Deno.test('WIRING: index.ts routes the unverified outcome to an early return', () => {
  const branch = indexSource.indexOf("quota.outcome === 'unverified'");
  assert.notEqual(branch, -1, 'index.ts must branch on the unverified outcome');

  const ret = indexSource.indexOf("error: 'quota_unavailable'", branch);
  assert.notEqual(ret, -1, 'the unverified branch must return the quota_unavailable body');

  // 200 so mobile clients treat it as an outcome, not a transport failure, and
  // retryable so the client knows this is not terminal.
  const body = indexSource.slice(branch, ret + 400);
  assert.ok(body.includes('retryable: true'), 'the failure must be marked retryable');
  assert.ok(body.includes('QUOTA_UNVERIFIED_MESSAGE'), 'the user message must be the outage message');
  assert.ok(
    !body.includes('buildRateLimitedResponse'),
    'an outage must not reuse the "daily limit reached" body',
  );
});

Deno.test('WIRING: the unverified return precedes every paid call it gates', () => {
  const unverifiedReturn = indexSource.indexOf("error: 'quota_unavailable'");
  assert.notEqual(unverifiedReturn, -1);

  const geminiKeyRead = indexSource.indexOf("Deno.env.get('GEMINI_API_KEY')");
  assert.notEqual(geminiKeyRead, -1, 'the Gemini key read must still exist');
  assert.ok(
    unverifiedReturn < geminiKeyRead,
    'the quota gate must return before the Gemini call site is reached',
  );

  const commerce = indexSource.indexOf('getScanCommerceResults(');
  assert.notEqual(commerce, -1, 'the commerce router call must still exist');
  assert.ok(
    unverifiedReturn < commerce,
    'the quota gate must return before paid commerce is dispatched',
  );
});

Deno.test('WIRING: no fail-open survives on the authenticated quota path', () => {
  const quotaSource = Deno.readTextFileSync(new URL('./scanQuota.ts', import.meta.url));
  // Strip comments first: this file documents the old fail-open shape verbatim,
  // and a naive scan would match the prose describing the bug rather than code.
  const code = quotaSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Value construction uses a comma (`{ outcome: 'allowed', count, ... }`); the
  // union declaration uses a semicolon. Only construction sites can authorise.
  const allowSites = code.match(/outcome: 'allowed',/g) ?? [];
  assert.equal(
    allowSites.length,
    1,
    'exactly one allow site may exist, and it must be the one derived from the RPC result',
  );
  assert.ok(
    /row\.allowed[\s\S]{0,40}\{ outcome: 'allowed'/.test(code),
    'the single allow site must be produced by row.allowed, never by a literal',
  );

  const unverifiedSites = code.match(/outcome: 'unverified',/g) ?? [];
  assert.equal(
    unverifiedSites.length,
    2,
    'both infrastructure failure paths -- missing client and RPC failure -- must be unverified',
  );
});
