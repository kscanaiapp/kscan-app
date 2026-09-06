// Proves the PostHog identity-transition rule in
// services/analytics/posthogIdentitySync.ts: syncPostHogIdentityWith always
// resets before establishing a different identity, so an actor switch never
// lets the incoming actor inherit the outgoing actor's identity state.
//
// Tested against a fake {identify, reset} client rather than the real
// native SDK — posthog-react-native expects a React Native runtime to
// construct, and this repo's tests run under plain `node --test`. The rule
// under test lives entirely in posthogIdentitySync.ts, which has zero JSX
// and zero vendor-SDK dependency, so it can be required directly (Node's
// built-in TypeScript support strips its type annotations at load time) and
// exercised for real — this is real execution, not source-text inspection.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  syncPostHogIdentityWith,
  __resetPostHogIdentitySyncForTests,
} = require('../services/analytics/posthogIdentitySync.ts');

function fakeClient() {
  const calls = [];
  return {
    calls,
    identify(distinctId) {
      calls.push({ op: 'identify', distinctId });
    },
    reset() {
      calls.push({ op: 'reset' });
    },
  };
}

test.beforeEach(() => {
  __resetPostHogIdentitySyncForTests();
});

test('anonymous -> identify(A) -> reset() -> identify(B): B never inherits A', () => {
  const client = fakeClient();

  syncPostHogIdentityWith(client, 'A');
  syncPostHogIdentityWith(client, null); // logout
  syncPostHogIdentityWith(client, 'B');

  // Every identify call is immediately preceded by a reset call — the only
  // way an identify for a NEW id can reach the client.
  client.calls.forEach((call, i) => {
    if (call.op === 'identify') {
      assert.equal(client.calls[i - 1]?.op, 'reset', `identify(${call.distinctId}) at index ${i} was not preceded by reset()`);
    }
  });

  assert.deepEqual(
    client.calls.map((c) => (c.op === 'identify' ? `identify:${c.distinctId}` : c.op)),
    ['reset', 'identify:A', 'reset', 'reset', 'identify:B'],
  );
});

test('logout resets and does not re-identify', () => {
  const client = fakeClient();
  syncPostHogIdentityWith(client, 'A');
  client.calls.length = 0;

  syncPostHogIdentityWith(client, null);

  assert.deepEqual(client.calls, [{ op: 'reset' }]);
});

test('account deletion (session -> null, same as logout) resets identity', () => {
  const client = fakeClient();
  syncPostHogIdentityWith(client, 'deleted-actor');
  client.calls.length = 0;

  // Account deletion clears the Supabase session the same way sign-out
  // does (AuthSessionContext seals the session to null before any await) —
  // from this module's point of view it is indistinguishable from logout.
  syncPostHogIdentityWith(client, null);

  assert.deepEqual(client.calls, [{ op: 'reset' }]);
});

test('actor switch (A signs out, B signs in) always resets before identifying B', () => {
  const client = fakeClient();
  syncPostHogIdentityWith(client, 'A');
  client.calls.length = 0;

  syncPostHogIdentityWith(client, null); // A signs out
  syncPostHogIdentityWith(client, 'B'); // B signs in

  assert.deepEqual(client.calls, [{ op: 'reset' }, { op: 'reset' }, { op: 'identify', distinctId: 'B' }]);
});

test('re-syncing the same userId is a no-op (no redundant reset/identify churn)', () => {
  const client = fakeClient();
  syncPostHogIdentityWith(client, 'A');
  client.calls.length = 0;

  syncPostHogIdentityWith(client, 'A');
  syncPostHogIdentityWith(client, 'A');

  assert.deepEqual(client.calls, []);
});

test('a null client is a safe no-op', () => {
  assert.doesNotThrow(() => syncPostHogIdentityWith(null, 'A'));
});
