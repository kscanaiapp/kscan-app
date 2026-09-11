// PH35-R2 — anonymous identity containment.
//
// THE CLAIM: PostHog is never told who the user is. No Supabase user id, no
// email, no display name, no profile id, no RevenueCat App User ID, no push /
// auth / refresh token, no advertising identifier — and no hash of any of
// them, since a hash of an authenticated identifier is still one.
//
// WHY THESE TESTS RUN WITH POSTHOG CONFIGURED: PH35-R1 already proves a
// disabled client makes no calls at all, so asserting "no identify" against a
// disabled client would be vacuous. Every scenario below runs against a LIVE,
// constructed client, where an identify would really be delivered — and then
// shows none happens.
//
// Two layers:
//   1. End-to-end through the real adapter (helpers/posthogIdentityProbe.mjs),
//      scanning the vendor's entire recorded call log for sentinel values.
//   2. Direct, in-process exercise of the identity rule itself, including a
//      hostile case where a caller defeats the types and passes a raw user id.
//
// This file replaces the old __tests__/posthogIdentitySync.test.js, which
// asserted the identify-based rule this repair removed.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { runProbeProcess } = require('./helpers/posthogProbeSpawn.js');

const PROBE = path.join(__dirname, 'helpers', 'posthogIdentityProbe.mjs');

// Loaded defensively rather than destructured, so that when this suite is run
// against a PRE-REPAIR adapter (the negative control below) the end-to-end
// lifecycle tests still execute and fail because they DETECTED THE LEAK —
// not because a test-only seam happened to be missing.
const identityModule = require('../services/analytics/posthogIdentitySync.ts');
const { syncPostHogAnonymousIdentityWith } = identityModule;

// Distinctive values standing in for every forbidden identity input. If any
// of these ever appears in what the vendor received, identity leaked.
const USER_A = 'aaaaaaaa-1111-4aaa-8aaa-aaaaaaaaaaaa';
const USER_B = 'bbbbbbbb-2222-4bbb-8bbb-bbbbbbbbbbbb';
const SENTINELS = [
  USER_A,
  USER_B,
  'leaky.person@example.com',
  '+15550001111',
  'Ada Lovelace',
  'rcat_app_user_id_9999',
  'ExponentPushToken[SENTINEL]',
  'eyJhbGciOiJIUzI1NiJ9.SENTINEL.sig',
  'IDFA-0000-1111-2222',
];

/** Runs a scripted auth lifecycle against a LIVE PostHog client. */
function runLifecycle(steps) {
  const env = { ...process.env };
  env.EXPO_PUBLIC_POSTHOG_API_KEY = 'phc_identityprobe';
  env.EXPO_PUBLIC_POSTHOG_HOST = 'https://example.invalid';

  const result = runProbeProcess(PROBE, [JSON.stringify(steps)], env);
  assert.equal(
    result.status,
    0,
    `probe exited ${result.status}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
  );
  return JSON.parse(result.stdout);
}

/**
 * The detector. Kept separate so the negative control below can prove it
 * actually fails on the pre-repair behaviour.
 */
function assertNoAuthenticatedIdentity(observed, label) {
  const ops = observed.calls.map((c) => c.op);
  for (const forbidden of ['identify', 'alias', 'group', 'register']) {
    assert.ok(
      !ops.includes(forbidden),
      `${label}: PostHog must never receive ${forbidden}(), saw ops ${JSON.stringify(ops)}`,
    );
  }
  for (const sentinel of SENTINELS) {
    assert.ok(
      !observed.serialized.includes(sentinel),
      `${label}: authenticated identifier "${sentinel}" reached PostHog`,
    );
  }
}

// ─── End-to-end auth lifecycle, against a live client ───────────────────────

// `userId` is what app/_layout.tsx holds when the boundary moves. The repaired
// adapter never receives it (the call site converts to a boolean); the
// pre-repair adapter did, which is what the negative control exploits.
const signedIn = (userId) => ({ op: 'sync', authenticated: true, userId });
const signedOut = { op: 'sync', authenticated: false, userId: null };

const LIFECYCLES = [
  ['anonymous app state', [{ op: 'bridge' }, signedOut, { op: 'emit' }]],
  ['login (user A)', [{ op: 'bridge' }, signedOut, signedIn(USER_A), { op: 'emit' }]],
  ['session restore for user A', [{ op: 'bridge' }, signedIn(USER_A), { op: 'emit' }]],
  [
    'auth token refresh (same actor, boundary unchanged)',
    [{ op: 'bridge' }, signedIn(USER_A), signedIn(USER_A), signedIn(USER_A), { op: 'emit' }],
  ],
  ['logout', [{ op: 'bridge' }, signedIn(USER_A), signedOut]],
  [
    'user A -> logout -> user B',
    [
      { op: 'bridge' },
      signedIn(USER_A),
      { op: 'emit' },
      signedOut,
      signedIn(USER_B),
      { op: 'emit' },
    ],
  ],
  [
    'account deletion (session sealed to null)',
    [{ op: 'bridge' }, signedIn(USER_A), signedOut, { op: 'reset' }],
  ],
  [
    'RevenueCat / K+ entitlement synchronisation',
    // RevenueCat lives only in supabase/functions (server side) and never
    // touches this adapter; an entitlement change reaches the app as bounded
    // event properties, never as identity. Modelled here as repeated syncs
    // plus product events while signed in.
    [{ op: 'bridge' }, signedIn(USER_A), { op: 'emit' }, signedIn(USER_A), { op: 'emit' }],
  ],
];

for (const [label, steps] of LIFECYCLES) {
  test(`${label}: no authenticated identity reaches PostHog`, () => {
    const observed = runLifecycle(steps);

    assert.deepEqual(observed.errors, [], `${label}: analytics must not throw into product code`);
    assert.equal(observed.clientCreated, true, `${label}: probe must run against a LIVE client`);
    assertNoAuthenticatedIdentity(observed, label);
  });
}

test('the adapter exposes no export that accepts a user identifier', () => {
  const observed = runLifecycle([{ op: 'sync', authenticated: false }]);
  assert.ok(
    !observed.exportedNames.includes('identifyPostHogUser'),
    'identifyPostHogUser must not exist — it accepted a Supabase user id',
  );
  assert.ok(
    !observed.exportedNames.includes('syncPostHogIdentity'),
    'syncPostHogIdentity must not exist — it accepted a user id or null',
  );
  assert.ok(observed.exportedNames.includes('syncPostHogAnonymousIdentity'));
});

// ─── Negative control: the detector really does catch the old bridge ────────

test('negative control: the detector fails on the pre-repair identify bridge', () => {
  // Exactly what the old syncPostHogIdentityWith did: reset, then identify
  // with the Supabase user id. Fed through the same assertion helper the
  // real tests use — it must reject this.
  const preRepairCalls = [{ op: 'reset' }, { op: 'identify', distinctId: USER_A }];
  const preRepair = {
    calls: preRepairCalls,
    serialized: JSON.stringify(preRepairCalls),
  };

  assert.throws(
    () => assertNoAuthenticatedIdentity(preRepair, 'pre-repair'),
    /must never receive identify\(\)/,
    'the detector must reject the pre-repair identify bridge — otherwise the tests above prove nothing',
  );
});

// ─── The identity rule itself ───────────────────────────────────────────────

function fakeClient() {
  const calls = [];
  return {
    calls,
    reset() {
      calls.push({ op: 'reset' });
    },
    // Present so an accidental identify would be recorded rather than throw.
    identify(distinctId) {
      calls.push({ op: 'identify', distinctId });
    },
  };
}

test.beforeEach(() => {
  identityModule.__resetPostHogAnonymousIdentityForTests?.();
});

test('the first sync resets, clearing any distinct id the SDK restored', () => {
  const client = fakeClient();
  syncPostHogAnonymousIdentityWith(client, false);
  assert.deepEqual(client.calls, [{ op: 'reset' }]);
});

test('crossing the auth boundary resets and never identifies', () => {
  const client = fakeClient();

  syncPostHogAnonymousIdentityWith(client, false); // anonymous
  syncPostHogAnonymousIdentityWith(client, true); // login
  syncPostHogAnonymousIdentityWith(client, false); // logout
  syncPostHogAnonymousIdentityWith(client, true); // next actor signs in

  assert.deepEqual(
    client.calls,
    [{ op: 'reset' }, { op: 'reset' }, { op: 'reset' }, { op: 'reset' }],
    'every boundary crossing is a bare reset',
  );
});

test('a token refresh with the boundary unchanged is a no-op', () => {
  const client = fakeClient();
  syncPostHogAnonymousIdentityWith(client, true);
  client.calls.length = 0;

  syncPostHogAnonymousIdentityWith(client, true);
  syncPostHogAnonymousIdentityWith(client, true);

  assert.deepEqual(client.calls, [], 'refreshing a token must not churn the anonymous id');
});

test('hostile: a caller that defeats the types and passes a raw user id leaks nothing', () => {
  // TypeScript says boolean, but JS callers can pass anything. The client
  // must still never receive the value.
  const client = fakeClient();

  syncPostHogAnonymousIdentityWith(client, USER_A);
  syncPostHogAnonymousIdentityWith(client, 'leaky.person@example.com');

  assert.ok(
    !client.calls.some((c) => c.op === 'identify'),
    'no identify may be issued regardless of what the caller passed',
  );
  const serialized = JSON.stringify(client.calls);
  for (const sentinel of [USER_A, 'leaky.person@example.com']) {
    assert.ok(!serialized.includes(sentinel), `"${sentinel}" must not reach the client`);
  }
});

test('a null client is a safe no-op', () => {
  assert.doesNotThrow(() => syncPostHogAnonymousIdentityWith(null, true));
});

test('an adapter that throws never propagates into the auth lifecycle', () => {
  const exploding = {
    reset() {
      throw new Error('vendor exploded');
    },
  };
  // The rule itself is allowed to throw; the wrapper (syncPostHogAnonymousIdentity
  // in posthogClient.core.ts) is what swallows it. Proven end-to-end by the
  // `errors` assertion in every lifecycle test above, which drives the real
  // wrapper. Here we only pin that the throw comes from the vendor, not from
  // our own rule mishandling it.
  assert.throws(() => syncPostHogAnonymousIdentityWith(exploding, true), /vendor exploded/);
});
