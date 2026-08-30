/**
 * UNEXPECTED-02 — password change must revoke every session, on BOTH platforms.
 *
 * The pre-repair Android flow called getUser() after updateUser() and kept the
 * recovery session alive, so a refresh token already held on another device
 * stayed valid after the password changed. iOS already revoked globally. These
 * tests pin the iOS behaviour as the contract for both lines.
 *
 * The assertions run against a modelled auth server rather than string-matching
 * the screen, so they describe what happens to sessions and credentials — and
 * the negative control at the bottom replays the old Android sequence through
 * the same assertions to prove they actually detect the defect.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  REVOKE_FAILED_MESSAGE,
  updatePasswordAndRevokeSessions,
  verifySessionAfterPasswordUpdate,
} = require('../services/passwordReset');

/**
 * A small model of the Supabase auth server: it holds the account password and
 * the set of live refresh sessions, so "was the session actually revoked" is a
 * property of state rather than of which method the screen happened to call.
 */
function createAuthServer({
  password = 'original-password',
  sessions = ['this-device', 'other-phone', 'tablet'],
  updateFails = null,
  revokeFails = null,
} = {}) {
  const server = {
    password,
    sessions: new Set(sessions),
    current: 'this-device',
    profile: { id: 'user-1', displayName: 'Sam', styleNickname: 'S' },
    calls: [],
  };

  server.auth = {
    updateUser: async ({ password: next }) => {
      server.calls.push({ method: 'updateUser' });
      if (updateFails) return { data: { user: null }, error: updateFails };
      server.password = next;
      // Supabase does NOT revoke on password change by itself. That is exactly
      // why the client has to ask for it.
      return { data: { user: server.profile }, error: null };
    },
    signOut: async (options) => {
      const scope = options?.scope ?? 'local';
      server.calls.push({ method: 'signOut', scope });
      if (revokeFails) return { error: revokeFails };
      if (scope === 'global') server.sessions.clear();
      else server.sessions.delete(server.current);
      return { error: null };
    },
    getUser: async () => {
      server.calls.push({ method: 'getUser' });
      if (!server.sessions.has(server.current)) {
        return { data: { user: null }, error: new Error('401 Unauthorized') };
      }
      return { data: { user: server.profile }, error: null };
    },
    signInWithPassword: async ({ password: attempt }) => {
      if (attempt !== server.password) {
        return { data: { session: null }, error: new Error('Invalid login credentials') };
      }
      server.sessions.add('this-device');
      server.current = 'this-device';
      return { data: { session: { user: server.profile } }, error: null };
    },
    /** Whether a token minted before the change can still buy a live session. */
    refreshSession: async ({ refreshToken }) =>
      server.sessions.has(refreshToken)
        ? { data: { session: { user: server.profile } }, error: null }
        : { data: { session: null }, error: new Error('Invalid Refresh Token') },
  };

  return server;
}

const signOutCalls = (server) => server.calls.filter((call) => call.method === 'signOut');

test('a successful password update revokes every session globally', async () => {
  const server = createAuthServer();

  const outcome = await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  assert.equal(outcome.ok, true);
  assert.equal(outcome.revoked, true);
  assert.equal(outcome.stage, 'complete');
  assert.deepEqual(signOutCalls(server), [{ method: 'signOut', scope: 'global' }]);
  assert.equal(server.sessions.size, 0, 'no session may survive a password change');
});

test('the current device session is removed, not just the remote ones', async () => {
  const server = createAuthServer();

  await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  assert.equal(server.sessions.has('this-device'), false);
  const verified = await server.auth.getUser();
  assert.equal(verified.data.user, null, 'this device must no longer resolve a user');
});

test('a session token captured before the change cannot silently restore access', async () => {
  const server = createAuthServer();
  const stolenToken = 'other-phone';
  const before = await server.auth.refreshSession({ refreshToken: stolenToken });
  assert.notEqual(before.data.session, null, 'precondition: the token worked beforehand');

  await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  const after = await server.auth.refreshSession({ refreshToken: stolenToken });
  assert.equal(after.data.session, null);
  assert.match(after.error.message, /Refresh Token/i);
});

test('the new password authenticates and the old one no longer does', async () => {
  const server = createAuthServer({ password: 'original-password' });

  await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  const stale = await server.auth.signInWithPassword({ password: 'original-password' });
  assert.equal(stale.data.session, null);
  assert.match(stale.error.message, /Invalid login credentials/i);

  const fresh = await server.auth.signInWithPassword({ password: 'brand-new-password' });
  assert.notEqual(fresh.data.session, null);
});

test('routing lands on the signed-out authentication screen', async () => {
  const server = createAuthServer();

  const outcome = await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  // The established signed-out destination for this line, not the Welcome Tree:
  // the account exists and is not being onboarded again.
  assert.equal(outcome.route, '/auth');
});

test('no profile data is lost when sessions are revoked', async () => {
  const server = createAuthServer();
  const before = { ...server.profile };

  await updatePasswordAndRevokeSessions(server, 'brand-new-password');
  await server.auth.signInWithPassword({ password: 'brand-new-password' });

  assert.deepEqual(server.profile, before);
});

test('a FAILED password update signs nobody out', async () => {
  const server = createAuthServer({ updateFails: new Error('Password should be at least 6 characters') });

  const outcome = await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.revoked, false);
  assert.equal(outcome.stage, 'update');
  assert.deepEqual(signOutCalls(server), [], 'a rejected update must not cost the user their session');
  assert.equal(server.sessions.size, 3);
  assert.equal(server.password, 'original-password');
});

test('a rejected password never reaches the auth server at all', async () => {
  const server = createAuthServer();

  const outcome = await updatePasswordAndRevokeSessions(server, 'short');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.stage, 'validation');
  assert.match(outcome.message, /8 characters/i);
  assert.deepEqual(server.calls, []);
  assert.equal(server.sessions.size, 3);
});

test('a revocation that fails is reported instead of being presented as success', async () => {
  const server = createAuthServer({ revokeFails: new Error('network down') });

  const outcome = await updatePasswordAndRevokeSessions(server, 'brand-new-password');

  assert.equal(outcome.ok, false);
  assert.equal(outcome.revoked, false);
  assert.equal(outcome.stage, 'revoke');
  assert.equal(outcome.route, null, 'a half-completed security change must not route as done');
  assert.equal(outcome.message, REVOKE_FAILED_MESSAGE);
});

test('NEGATIVE CONTROL: the pre-repair Android sequence fails these assertions', async () => {
  /** Verbatim shape of the Android flow before this repair. */
  async function legacyAndroidUpdatePassword(supabase, password) {
    const { error: updateError } = await supabase.auth.updateUser({ password });
    if (updateError) return { ok: false, revoked: false, route: null };
    try {
      await verifySessionAfterPasswordUpdate(supabase);
      return { ok: true, revoked: false, route: '/privacy' };
    } catch {
      await supabase.auth.signOut();
      return { ok: true, revoked: false, route: '/auth' };
    }
  }

  const server = createAuthServer();
  const outcome = await legacyAndroidUpdatePassword(server, 'brand-new-password');

  // The old path reports success, so a test that only checked `ok` would pass.
  assert.equal(outcome.ok, true);

  // Every assertion that matters fails against it.
  assert.throws(
    () => assert.deepEqual(signOutCalls(server), [{ method: 'signOut', scope: 'global' }]),
    'the legacy path never requested a global sign-out',
  );
  assert.throws(
    () => assert.equal(server.sessions.size, 0),
    'the legacy path left every session alive',
  );

  // Concretely: a token captured before the change still works afterwards.
  const replay = await server.auth.refreshSession({ refreshToken: 'other-phone' });
  assert.notEqual(replay.data.session, null, 'this is the defect UNEXPECTED-02 describes');
});
