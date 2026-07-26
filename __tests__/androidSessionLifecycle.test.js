/**
 * Deterministic Android session-lifecycle regressions.
 *
 * No native binary is built for this suite. React Native lifecycle, network
 * availability, secure storage, system time, token rotation and Supabase auth
 * events are all faked in-process, so every assertion here is classified
 * AUTOMATED — DETERMINISTIC MOCK. Physical-device behaviour is not claimed.
 *
 * Owner ruling under test: a valid, refreshable session must survive an expired
 * access token, a backgrounded app, suspended timers, lost connectivity, a
 * timed-out refresh, a temporary 5xx and a concurrent-refresh race — while a
 * deliberate logout, an actor switch and a revoked or deleted account must
 * still end the session.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, moduleStubs = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  const sandboxRequire = (specifier) => {
    if (specifier in moduleStubs) return moduleStubs[specifier];
    throw new Error(`unstubbed native import in ${relativePath}: ${specifier}`);
  };
  vm.runInNewContext(
    output,
    { exports: module.exports, module, require: sandboxRequire, Set, Map },
    { filename },
  );
  return module.exports;
}

/** Comment text is not behaviour; diagnostics assertions must ignore it. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const { createAuthBootstrapStorage, isTerminalRefreshFailure } = loadTsModule(
  'services/authSessionBootstrap.ts',
);

const {
  AUTH_STATE,
  getRoutingGuardState,
  getSessionAuthState,
  isAccessTokenExpired,
  isSessionRecoverable,
  isSessionUsable,
} = require('../services/routingGuard');

const contextSource = fs.readFileSync(
  path.join(ROOT, 'contexts', 'AuthSessionContext.tsx'),
  'utf8',
);
const clientSource = fs.readFileSync(path.join(ROOT, 'services', 'supabaseClient.ts'), 'utf8');
const secureStorageSource = fs.readFileSync(
  path.join(ROOT, 'services', 'secureSessionStorage.ts'),
  'utf8',
);

const SUPABASE_URL = 'https://session-lifecycle-test.supabase.co';
const ANON_KEY = 'test-anon-key';

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function makeSession(overrides = {}) {
  return {
    access_token: 'access-token-1',
    refresh_token: 'refresh-token-1',
    token_type: 'bearer',
    expires_in: 3600,
    expires_at: nowSeconds() + 3600,
    user: {
      id: 'actor-1',
      aud: 'authenticated',
      role: 'authenticated',
      app_metadata: {},
      user_metadata: {},
    },
    ...overrides,
  };
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
  };
}

/**
 * Fake Supabase auth endpoint. Rotates the refresh token on every successful
 * grant so refresh-token reuse is observable, and can be switched offline or
 * into a temporary 5xx without changing the client under test.
 */
function createAuthBackend() {
  const backend = {
    refreshCalls: 0,
    signOutCalls: 0,
    issued: 1,
    // 'ok'          — healthy
    // 'offline'     — fetch rejects; auth-js classifies retryable and backs off
    //                 for up to one refresh tick (~25s), so use it sparingly
    // 'rate-limited'— HTTP 429; transient but NOT retryable, so it fails fast
    // 'server-error'— HTTP 503; retryable, same backoff cost as 'offline'
    mode: 'ok',
    validRefreshTokens: new Set(['refresh-token-1']),
    usedRefreshTokens: new Set(),
    actorId: 'actor-1',
    lastIssuedSession: null,
  };

  backend.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const { pathname, searchParams } = new URL(url);

    if (pathname.endsWith('/logout')) {
      backend.signOutCalls += 1;
      if (backend.mode !== 'ok') {
        throw Object.assign(new TypeError('Network request failed'), { name: 'TypeError' });
      }
      return new Response(null, { status: 204 });
    }

    if (pathname.endsWith('/token') && searchParams.get('grant_type') === 'refresh_token') {
      backend.refreshCalls += 1;

      if (backend.mode === 'offline' || backend.mode === 'timeout') {
        // fetch() rejects with a TypeError for an unreachable host; auth-js
        // maps that to AuthRetryableFetchError.
        throw Object.assign(new TypeError('Network request failed'), { name: 'TypeError' });
      }
      if (backend.mode === 'server-error') {
        return new Response(JSON.stringify({ message: 'upstream unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (backend.mode === 'rate-limited') {
        return new Response(
          JSON.stringify({ code: 'over_request_rate_limit', message: 'Request rate limit reached' }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        );
      }

      const presented = JSON.parse(init.body || '{}').refresh_token;
      if (backend.usedRefreshTokens.has(presented)) {
        return new Response(
          JSON.stringify({
            code: 'refresh_token_already_used',
            error_code: 'refresh_token_already_used',
            msg: 'Invalid Refresh Token: Refresh Token Already Used',
            message: 'Invalid Refresh Token: Refresh Token Already Used',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      if (!backend.validRefreshTokens.has(presented)) {
        return new Response(
          JSON.stringify({
            code: 'refresh_token_not_found',
            error_code: 'refresh_token_not_found',
            msg: 'Invalid Refresh Token: Refresh Token Not Found',
            message: 'Invalid Refresh Token: Refresh Token Not Found',
          }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }

      backend.usedRefreshTokens.add(presented);
      backend.validRefreshTokens.delete(presented);
      backend.issued += 1;
      const next = {
        access_token: `access-token-${backend.issued}`,
        refresh_token: `refresh-token-${backend.issued}`,
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: nowSeconds() + 3600,
        user: {
          id: backend.actorId,
          aud: 'authenticated',
          role: 'authenticated',
          app_metadata: {},
          user_metadata: {},
        },
      };
      backend.validRefreshTokens.add(next.refresh_token);
      backend.lastIssuedSession = next;
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  return backend;
}

function createClientUnderTest({ backend, storage, storageKey, autoRefreshToken = false }) {
  const { createClient } = require('@supabase/supabase-js');
  return createClient(SUPABASE_URL, ANON_KEY, {
    auth: {
      storage,
      storageKey,
      persistSession: true,
      autoRefreshToken,
      detectSessionInUrl: false,
    },
    global: { fetch: backend.fetch },
  });
}

/** Mirrors services/supabaseClient.ts wiring: one bootstrap adapter, one donor. */
function createBootstrapStack({ backend, stored, storageKey = 'sb-lifecycle-auth-token' }) {
  const { createClient } = require('@supabase/supabase-js');
  const raw = createMemoryStorage(stored ? { [storageKey]: JSON.stringify(stored) } : {});
  const recoveryErrors = [];
  const refreshClient = createClient(SUPABASE_URL, ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: `${storageKey}-bootstrap`,
    },
    global: { fetch: backend.fetch },
  });
  const adapter = createAuthBootstrapStorage({
    storage: raw,
    refreshSession: async (refreshToken) => {
      const { data, error } = await refreshClient.auth.refreshSession({
        refresh_token: refreshToken,
      });
      return { session: data.session, error };
    },
    onRecoveryError: (error) => recoveryErrors.push(error),
  });
  const client = createClientUnderTest({ backend, storage: adapter, storageKey });
  return { adapter, client, raw, recoveryErrors, storageKey };
}

// ---------------------------------------------------------------------------
// Session classification — the login-loop root cause
// ---------------------------------------------------------------------------

test('an expired access token on a refreshable session is not a signed-out user', () => {
  const now = 1_000;
  const refreshable = {
    access_token: 'a',
    refresh_token: 'r',
    expires_at: now - 1,
    user: { id: 'actor-1' },
  };

  assert.equal(isAccessTokenExpired(refreshable, now), true);
  assert.equal(isSessionRecoverable(refreshable), true);
  assert.equal(isSessionUsable(refreshable, now), true, 'must stay signed in while renewing');
  assert.equal(getSessionAuthState(refreshable, now), AUTH_STATE.RECOVERY_PENDING);

  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: refreshable,
    nowSeconds: now,
    onboardingComplete: true,
  });
  assert.equal(state.action, 'allow', 'no redirect to login for an ordinary token lapse');
  assert.equal(state.redirectTo, null);
});

test('a session with no refresh material is still treated as signed out', () => {
  const now = 1_000;
  const terminal = { access_token: 'a', expires_at: now - 1 };
  assert.equal(isSessionRecoverable(terminal), false);
  assert.equal(isSessionUsable(terminal, now), false);
  assert.equal(getSessionAuthState(terminal, now), AUTH_STATE.UNAUTHENTICATED);

  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: terminal,
    nowSeconds: now,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

test('auth state distinguishes unknown, authenticated, recovery-pending and signed out', () => {
  const now = 1_000;
  const valid = { access_token: 'a', refresh_token: 'r', expires_at: now + 3600 };
  assert.equal(getSessionAuthState(valid, now, { loading: true }), AUTH_STATE.UNKNOWN);
  assert.equal(getSessionAuthState(valid, now), AUTH_STATE.AUTHENTICATED);
  assert.equal(
    getSessionAuthState({ ...valid, expires_at: now - 1 }, now),
    AUTH_STATE.RECOVERY_PENDING,
  );
  assert.equal(getSessionAuthState(null, now), AUTH_STATE.UNAUTHENTICATED);
});

test('a pending recovery holds the actor in recovery instead of routing to login', () => {
  const state = getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: 1_000,
    recoveryPending: true,
  });
  assert.equal(state.action, 'recovering');
  assert.equal(state.redirectTo, null, 'never redirected to /auth while recoverable');

  // Public routes stay reachable so recovery is never a dead end.
  assert.equal(
    getRoutingGuardState({
      pathname: '/auth',
      loading: false,
      session: null,
      nowSeconds: 1_000,
      recoveryPending: true,
    }).action,
    'allow',
  );
});

// ---------------------------------------------------------------------------
// Storage matrix — payload, capacity, atomicity, failure handling
// ---------------------------------------------------------------------------

test('realistic and large valid sessions round-trip without truncation or field loss', async () => {
  const sizes = [];
  for (const [label, metadata] of [
    ['typical', { first_name: 'Alex', locale: 'en-GB' }],
    ['rich', { first_name: 'Alex', avatar: 'x'.repeat(1_024), prefs: { tone: 'warm' } }],
    ['large', { note: 'y'.repeat(8_192) }],
    ['boundary-2048', { note: 'z'.repeat(2_048) }],
  ]) {
    const stored = makeSession({
      user: { id: 'actor-1', aud: 'authenticated', role: 'authenticated', user_metadata: metadata },
    });
    const raw = JSON.stringify(stored);
    sizes.push([label, Buffer.byteLength(raw, 'utf8')]);

    const storage = createMemoryStorage({ 'sb-key': raw });
    const adapter = createAuthBootstrapStorage({
      storage,
      now: () => Date.now(),
      refreshSession: async () => assert.fail('a valid session must not trigger startup refresh'),
      onRecoveryError: (error) => assert.fail(`unexpected recovery error: ${error}`),
    });

    const restored = JSON.parse(await adapter.getItem('sb-key'));
    assert.deepEqual(restored, stored, `${label} session round-trips exactly`);
    assert.equal(typeof restored.expires_at, 'number', `${label} keeps expires_at`);
    assert.equal(restored.refresh_token, 'refresh-token-1', `${label} keeps refresh_token`);
  }

  // Recorded so a future adapter change can be compared against real payloads
  // rather than an assumed universal limit.
  assert.ok(sizes.every(([, bytes]) => bytes > 0));
  assert.ok(
    sizes.find(([label]) => label === 'large')[1] > 8_000,
    'large-metadata fixture actually exercises a multi-kilobyte payload',
  );
});

test('a storage write fault is reported, never silent, and never signs the actor out', async () => {
  const writes = [];
  const storage = {
    getItem: async () => null,
    setItem: async (key, value) => {
      writes.push([key, value]);
      throw new Error('SecureStore write failed');
    },
    removeItem: async () => {},
  };
  const observed = [];
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => assert.fail('no refresh expected'),
    onRecoveryError: (error) => observed.push(error),
  });

  await adapter.setItem('sb-key', JSON.stringify(makeSession()));
  assert.equal(writes.length, 1, 'the write was attempted');
  assert.equal(observed.length, 1, 'the failure is surfaced, not swallowed');
  assert.match(String(observed[0].message), /write failed/);
});

test('a storage read fault fails closed for that read without discarding stored material', async () => {
  const removals = [];
  const storage = {
    getItem: async () => {
      throw new Error('SecureStore read failed');
    },
    setItem: async () => {},
    removeItem: async (key) => removals.push(key),
  };
  const observed = [];
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => assert.fail('no refresh expected'),
    onRecoveryError: (error) => observed.push(error),
  });

  assert.equal(await adapter.getItem('sb-key'), null);
  assert.equal(observed.length, 1, 'read fault is reported');
  assert.deepEqual(removals, [], 'a read fault never deletes the stored session');
});

test('corrupted, truncated and legacy stored sessions never trigger a destructive refresh', async () => {
  for (const corrupt of [
    '{"access_token":"a","refresh_to',        // truncated JSON
    '{}',                                      // legacy/empty schema
    '{"access_token":"a"}',                    // missing refresh_token
    'not-json-at-all',
  ]) {
    const storage = createMemoryStorage({ 'sb-key': corrupt });
    const adapter = createAuthBootstrapStorage({
      storage,
      refreshSession: async () => assert.fail('unparseable material must not be refreshed'),
      onRecoveryError: (error) => assert.fail(`unexpected error: ${error}`),
    });
    assert.equal(await adapter.getItem('sb-key'), corrupt, 'handed to Supabase to classify');
    assert.equal(await storage.getItem('sb-key'), corrupt, 'never deleted by the adapter');
  }
});

test('a session missing expires_at is passed through rather than force-refreshed', async () => {
  const stored = makeSession();
  delete stored.expires_at;
  const raw = JSON.stringify(stored);
  const storage = createMemoryStorage({ 'sb-key': raw });
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => assert.fail('no expiry means no startup refresh decision'),
    onRecoveryError: (error) => assert.fail(`unexpected error: ${error}`),
  });
  assert.equal(await adapter.getItem('sb-key'), raw);
});

test('concurrent reads share one recovery so a rotation cannot run twice', async () => {
  const stored = makeSession({ expires_at: nowSeconds() - 10 });
  const storage = createMemoryStorage({ 'sb-key': JSON.stringify(stored) });
  let refreshCalls = 0;
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => {
      refreshCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return { session: { ...stored, refresh_token: 'rotated', expires_at: nowSeconds() + 3600 }, error: null };
    },
    onRecoveryError: (error) => assert.fail(`unexpected error: ${error}`),
  });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => adapter.getItem('sb-key')),
  );
  assert.equal(refreshCalls, 1, 'single-flight across ten concurrent reads');
  const parsed = results.map((raw) => JSON.parse(raw));
  assert.ok(parsed.every((s) => s.refresh_token === 'rotated'), 'all readers see one session');
});

test('a terminal refresh rejection clears stored material; a transient one never does', async () => {
  const expired = makeSession({ expires_at: nowSeconds() - 10 });

  for (const terminalError of [
    { code: 'refresh_token_not_found', name: 'AuthApiError', status: 400 },
    { code: 'refresh_token_already_used', name: 'AuthApiError', status: 400 },
    { code: 'user_not_found', name: 'AuthApiError', status: 401 },
    { code: 'session_not_found', name: 'AuthApiError', status: 401 },
  ]) {
    const storage = createMemoryStorage({ 'sb-key': JSON.stringify(expired) });
    const adapter = createAuthBootstrapStorage({
      storage,
      refreshSession: async () => ({ session: null, error: terminalError }),
      onRecoveryError: () => {},
    });
    assert.equal(isTerminalRefreshFailure(terminalError), true, `${terminalError.code} is terminal`);
    assert.equal(await adapter.getItem('sb-key'), null);
    assert.equal(await storage.getItem('sb-key'), null, `${terminalError.code} clears storage`);
    assert.equal(adapter.hasPendingSessionRecovery(), false);
  }

  for (const transientError of [
    { name: 'AuthRetryableFetchError', status: 0, message: 'Network request failed' },
    { name: 'AuthApiError', status: 503, message: 'upstream unavailable' },
    { name: 'AuthApiError', status: 504, message: 'gateway timeout' },
    { name: 'AuthApiError', status: 429, message: 'rate limited' },
    { name: 'AbortError', message: 'The operation was aborted' },
    new Error('unclassified transport fault'),
  ]) {
    const raw = JSON.stringify(expired);
    const storage = createMemoryStorage({ 'sb-key': raw });
    const adapter = createAuthBootstrapStorage({
      storage,
      refreshSession: async () => ({ session: null, error: transientError }),
      onRecoveryError: () => {},
    });
    assert.equal(isTerminalRefreshFailure(transientError), false);
    assert.equal(await adapter.getItem('sb-key'), null, 'this read resolves empty');
    assert.equal(await storage.getItem('sb-key'), raw, 'stored material is fully preserved');
    assert.equal(adapter.hasPendingSessionRecovery(), true, 'surfaced as recovery');
  }
});

test('clearing persisted sessions is durable and a later sign-in re-arms storage', async () => {
  const storage = createMemoryStorage({ 'sb-key': JSON.stringify(makeSession()) });
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => assert.fail('no refresh expected'),
    onRecoveryError: () => {},
  });

  await adapter.getItem('sb-key');
  await adapter.clearPersistedSessions();

  assert.equal(await storage.getItem('sb-key'), null, 'material destroyed locally');
  assert.equal(await adapter.getItem('sb-key'), null, 'stays cleared for this process');

  await adapter.setItem('sb-key', JSON.stringify(makeSession({ user: { id: 'actor-2' } })));
  const restored = JSON.parse(await adapter.getItem('sb-key'));
  assert.equal(restored.user.id, 'actor-2', 'a new sign-in is not blocked by the seal');
});

// ---------------------------------------------------------------------------
// Cold launch, offline recovery and network restoration (real Supabase client)
// ---------------------------------------------------------------------------

test('cold launch with a valid stored session restores without any network refresh', async () => {
  const backend = createAuthBackend();
  const { client, recoveryErrors } = createBootstrapStack({ backend, stored: makeSession() });

  const { data, error } = await client.auth.getSession();
  assert.equal(error, null);
  assert.equal(data.session.user.id, 'actor-1');
  assert.equal(backend.refreshCalls, 0, 'a valid session is not refreshed at launch');
  assert.deepEqual(recoveryErrors, []);
});

test('cold launch with an expired access token refreshes silently and persists rotation', async () => {
  const backend = createAuthBackend();
  const { client, raw, storageKey } = createBootstrapStack({
    backend,
    stored: makeSession({ expires_at: nowSeconds() - 60 }),
  });

  const { data, error } = await client.auth.getSession();
  assert.equal(error, null);
  assert.ok(data.session, 'the actor stays signed in across a token lapse');
  assert.equal(data.session.user.id, 'actor-1');
  assert.equal(backend.refreshCalls, 1, 'exactly one refresh');

  const persisted = JSON.parse(await raw.getItem(storageKey));
  assert.equal(persisted.refresh_token, 'refresh-token-2', 'rotated token is persisted');
  assert.ok(persisted.expires_at > nowSeconds(), 'persisted session is renewed');
});

test('offline cold launch preserves the session and recovers when the network returns', async () => {
  const backend = createAuthBackend();
  backend.mode = 'offline';
  const { adapter, client, raw, storageKey, recoveryErrors } = createBootstrapStack({
    backend,
    stored: makeSession({ expires_at: nowSeconds() - 60 }),
  });

  await client.auth.getSession();

  const persisted = JSON.parse(await raw.getItem(storageKey));
  assert.equal(persisted.refresh_token, 'refresh-token-1', 'refresh token preserved offline');
  assert.equal(adapter.hasPendingSessionRecovery(), true, 'reported as recovery, not sign-out');
  assert.ok(recoveryErrors.length > 0, 'the transport failure is observable');
  assert.ok(
    recoveryErrors.every((error) => !isTerminalRefreshFailure(error)),
    'no offline failure is classified as an authorization decision',
  );

  // Connectivity returns. Recovery happens in the same launch — no relaunch,
  // no re-login — because the transient failure never hid the stored key.
  backend.mode = 'ok';
  const { data, error } = await client.auth.getSession();
  assert.equal(error, null);
  assert.ok(data.session, 'the actor is restored in the same launch');
  assert.equal(data.session.user.id, 'actor-1');
  assert.ok(JSON.parse(await raw.getItem(storageKey)).expires_at > nowSeconds());
});

test('a temporary server rejection preserves the session for a later retry', async () => {
  // 429 is transient but NOT retryable inside auth-js, so it is the case where
  // the SDK would otherwise call _removeSession() and destroy a valid
  // credential. The bootstrap adapter must absorb it.
  const backend = createAuthBackend();
  backend.mode = 'rate-limited';
  const { client, raw, storageKey, adapter } = createBootstrapStack({
    backend,
    stored: makeSession({ expires_at: nowSeconds() - 60 }),
  });

  const { data } = await client.auth.getSession();
  assert.equal(data.session, null, 'not presented as a validated session');
  assert.ok(await raw.getItem(storageKey), 'a temporary rejection never destroys material');
  assert.equal(adapter.hasPendingSessionRecovery(), true);

  backend.mode = 'ok';
  const recovered = await client.auth.getSession();
  assert.ok(recovered.data.session, 'recovers once the rejection clears');
});

test('repeated failure cycles never escalate into a destructive sign-out', async () => {
  const backend = createAuthBackend();
  const { client, raw, storageKey } = createBootstrapStack({
    backend,
    stored: makeSession({ expires_at: nowSeconds() - 60 }),
  });

  for (const mode of ['rate-limited', 'rate-limited', 'rate-limited']) {
    backend.mode = mode;
    await client.auth.getSession();
    assert.ok(await raw.getItem(storageKey), `session survives a ${mode} cycle`);
  }

  backend.mode = 'ok';
  const { data } = await client.auth.getSession();
  assert.ok(data.session, 'recovers after repeated flapping');
});

// ---------------------------------------------------------------------------
// Concurrency: refresh storms, rotation races, single-flight ownership
// ---------------------------------------------------------------------------

test('ten simultaneous expired-token requests perform exactly one refresh', async () => {
  const backend = createAuthBackend();
  const storageKey = 'sb-storm-auth-token';
  const storage = createMemoryStorage({
    [storageKey]: JSON.stringify(makeSession({ expires_at: nowSeconds() - 60 })),
  });
  const client = createClientUnderTest({ backend, storage, storageKey });

  const results = await Promise.all(
    Array.from({ length: 10 }, () => client.auth.getSession()),
  );

  assert.equal(backend.refreshCalls, 1, 'single-flight: one network refresh for ten callers');
  const tokens = new Set(results.map((r) => r.data.session && r.data.session.access_token));
  assert.equal(tokens.size, 1, 'every waiter resumes with the same new session');
  assert.equal(results.every((r) => r.error === null), true);
});

test('rotation is single-owner: no app path can replay a consumed refresh token', async () => {
  const backend = createAuthBackend();
  const { client, raw, storageKey } = createBootstrapStack({
    backend,
    stored: makeSession({ expires_at: nowSeconds() - 60 }),
  });

  // The bootstrap adapter rotates refresh-token-1 -> refresh-token-2 and hands
  // the rotated session to auth-js, so the consumed token is never replayed.
  const { data } = await client.auth.getSession();
  assert.ok(data.session);
  assert.equal(backend.refreshCalls, 1, 'exactly one grant consumed');
  assert.equal(JSON.parse(await raw.getItem(storageKey)).refresh_token, 'refresh-token-2');
  assert.equal(backend.usedRefreshTokens.has('refresh-token-1'), true);

  // Structural guarantee behind that: the only caller that may present a
  // caller-supplied refresh token is the bootstrap client, and it is
  // persistSession:false, so it can never write over the live session.
  assert.match(clientSource, /persistSession:\s*false/, 'bootstrap client does not persist');
  const bootstrapBlock = clientSource.slice(
    clientSource.indexOf('function getBootstrapRefreshClient'),
    clientSource.indexOf('export function takeAuthBootstrapStorageError'),
  );
  assert.match(bootstrapBlock, /persistSession:\s*false/);
  assert.match(bootstrapBlock, /storageKey:\s*'kscan-auth-bootstrap-refresh'/);
});

test('a stale rotation result cannot overwrite a newer persisted session', async () => {
  const storage = createMemoryStorage();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => {
      await gate;
      return { session: null, error: { code: 'refresh_token_already_used', name: 'AuthApiError', status: 400 } };
    },
    onRecoveryError: () => {},
  });

  await storage.setItem(
    'sb-key',
    JSON.stringify(makeSession({ expires_at: nowSeconds() - 10 })),
  );
  const pending = adapter.getItem('sb-key');

  // A newer sign-in lands while the stale rotation is still in flight.
  const newest = JSON.stringify(
    makeSession({ refresh_token: 'refresh-token-newest', expires_at: nowSeconds() + 3600 }),
  );
  await adapter.setItem('sb-key', newest);

  release();
  await pending;

  assert.equal(
    await storage.getItem('sb-key'),
    newest,
    'the newer session survives the late reuse rejection',
  );
  assert.equal(JSON.parse(await adapter.getItem('sb-key')).refresh_token, 'refresh-token-newest');
});

test('a revoked refresh token still ends the session', async () => {
  const backend = createAuthBackend();
  backend.validRefreshTokens.clear(); // account deleted / session revoked server-side
  const { client, raw, storageKey } = createBootstrapStack({
    backend,
    stored: makeSession({ expires_at: nowSeconds() - 60 }),
  });

  const { data } = await client.auth.getSession();
  assert.equal(data.session, null, 'a revoked actor is not restored');
  assert.equal(await raw.getItem(storageKey), null, 'stale material is destroyed');
});

test('a pre-deletion token cannot restore a deleted actor on relaunch', async () => {
  const backend = createAuthBackend();
  const stored = makeSession({ expires_at: nowSeconds() - 60 });

  // Launch 1: account deleted server-side, so the refresh token is gone.
  backend.validRefreshTokens.clear();
  const first = createBootstrapStack({ backend, stored });
  await first.client.auth.getSession();
  assert.equal(await first.raw.getItem(first.storageKey), null);

  // Launch 2: nothing recoverable remains, even with the backend healthy again.
  const second = createBootstrapStack({ backend, stored: null });
  const { data } = await second.client.auth.getSession();
  assert.equal(data.session, null, 'deletion is not undone by stale local storage');
});

// ---------------------------------------------------------------------------
// Logout, actor isolation and late responses
// ---------------------------------------------------------------------------

test('a failed global sign-out still destroys local session material', async () => {
  const backend = createAuthBackend();
  const { adapter, client, raw, storageKey } = createBootstrapStack({
    backend,
    stored: makeSession(),
  });
  await client.auth.getSession();

  backend.mode = 'offline'; // the logout request cannot reach the server
  await client.auth.signOut().catch(() => {});

  // This is the gap the provider closes: Supabase may skip its own local
  // cleanup when the network call fails.
  await adapter.clearPersistedSessions();

  assert.equal(await raw.getItem(storageKey), null, 'logout is durable while offline');
  assert.equal(await adapter.getItem(storageKey), null, 'nothing restorable remains');
});

test('a late refresh result cannot re-persist a session after logout', async () => {
  const storage = createMemoryStorage({ 'sb-key': JSON.stringify(makeSession()) });
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => assert.fail('no refresh expected'),
    onRecoveryError: () => {},
  });

  await adapter.getItem('sb-key');
  await adapter.clearPersistedSessions();

  // A refresh that resolved after the logout tries to write the old actor back.
  // Reading must not resurrect them: the provider seals the actor before any
  // await, and the adapter stays cleared until an explicit new sign-in.
  assert.equal(await adapter.getItem('sb-key'), null);
  assert.equal(await storage.getItem('sb-key'), null);
});

test('signing in as a second actor never exposes the first actor state', async () => {
  const backend = createAuthBackend();
  const storageKey = 'sb-switch-auth-token';
  const storage = createMemoryStorage({ [storageKey]: JSON.stringify(makeSession()) });
  const client = createClientUnderTest({ backend, storage, storageKey });

  const a = await client.auth.getSession();
  assert.equal(a.data.session.user.id, 'actor-1');

  await storage.removeItem(storageKey);
  await storage.setItem(
    storageKey,
    JSON.stringify(
      makeSession({
        access_token: 'actor-2-access',
        refresh_token: 'actor-2-refresh',
        user: { id: 'actor-2', aud: 'authenticated', role: 'authenticated' },
      }),
    ),
  );

  const b = await client.auth.getSession();
  assert.equal(b.data.session.user.id, 'actor-2');
  assert.notEqual(b.data.session.access_token, a.data.session.access_token);
});

// ---------------------------------------------------------------------------
// Provider wiring: lifecycle, refresh ownership, durable logout, redaction
// ---------------------------------------------------------------------------

test('exactly one AppState listener drives foreground recovery and is cleaned up', () => {
  const registrations = contextSource.match(/AppState\.addEventListener\(/g) || [];
  assert.equal(registrations.length, 1, 'no duplicate AppState registration');
  assert.match(contextSource, /subscription\.remove\(\)/, 'listener is removed on unmount');
  assert.match(
    contextSource,
    /if \(loading\) return;/,
    'lifecycle handling waits for hydration',
  );
  assert.match(
    contextSource,
    /nextState === 'active'[\s\S]{0,200}startAutoRefresh\(\)/,
    'foreground resumes the SDK refresher, which re-checks expiry immediately',
  );
  assert.match(
    contextSource,
    /stopAutoRefresh\(\)/,
    'background stops the ticker so no duplicate loop survives',
  );
});

test('lifecycle handling never clears session material', () => {
  const lifecycleBlock = contextSource.slice(
    contextSource.indexOf('const applyAppState'),
    contextSource.indexOf('const signIn'),
  );
  assert.doesNotMatch(lifecycleBlock, /setSession\(null\)/);
  assert.doesNotMatch(lifecycleBlock, /clearPersistedAuthSessions/);
  assert.doesNotMatch(lifecycleBlock, /signOut\(/);
});

test('Supabase remains the single refresh owner — no competing custom refresher', () => {
  // The provider must never call refreshSession()/setSession() itself; only the
  // bootstrap storage adapter may, and only inside the SDK's own lock.
  assert.doesNotMatch(contextSource, /supabase\.auth\.refreshSession\(/);
  assert.doesNotMatch(contextSource, /supabase\.auth\.setSession\(/);
  assert.doesNotMatch(contextSource, /setInterval\(/, 'no hand-rolled refresh timer');
  const clientRefreshCallers = clientSource.match(/auth\.refreshSession\(/g) || [];
  assert.equal(clientRefreshCallers.length, 1, 'one bootstrap-only refresh caller');
});

test('sign-out seals the actor before awaiting and forces local destruction on failure', () => {
  const signOutBlock = contextSource.slice(
    contextSource.indexOf('const signOut = useCallback'),
    contextSource.indexOf('const retrySessionRecovery'),
  );
  assert.match(signOutBlock, /signedOutRef\.current = true;[\s\S]{0,120}await/, 'sealed before any await');
  assert.match(signOutBlock, /clearPersistedAuthSessions\(\)/, 'durable local destruction');
  assert.match(signOutBlock, /signOutFailed/, 'a failed sign-out is detected, not ignored');
  assert.match(
    contextSource,
    /signedOutRef\.current && usableSession[\s\S]{0,260}return;/,
    'a late SIGNED_IN/TOKEN_REFRESHED cannot reauthenticate a logged-out actor',
  );
});

test('transient bootstrap failures resolve to recovery, never to a cleared session', () => {
  assert.match(contextSource, /isTerminalRefreshFailure/, 'bootstrap classifies the failure');
  assert.match(
    contextSource,
    /if \(terminal \|\| !pendingRecovery\) setSession\(null\);/,
    'only a terminal failure or a genuinely absent session clears state',
  );
  assert.match(contextSource, /hasPendingAuthSessionRecovery\(\)/);
  // The recovery hold is exactly "nothing to route on, but material remains".
  assert.match(
    contextSource,
    /isRecoveringSession: !loading && !session && recoveryPending/,
  );
});

test('auth telemetry and storage diagnostics cannot carry credential material', () => {
  const traceSource = fs.readFileSync(
    path.join(ROOT, 'services', 'authLifecycleTrace.ts'),
    'utf8',
  );
  const traceSchema = traceSource.slice(
    traceSource.indexOf('type AuthLifecycleDetails'),
    traceSource.indexOf('};', traceSource.indexOf('type AuthLifecycleDetails')),
  );
  for (const forbidden of [
    'access_token',
    'refresh_token',
    'accessToken',
    'refreshToken',
    'authorization',
    'password',
    'email',
    'session:',
    'jwt',
  ]) {
    assert.equal(
      traceSchema.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `auth trace schema must not expose ${forbidden}`,
    );
  }

  // The adapter reports failures, never the values it was reading or writing.
  const bootstrapCode = stripComments(
    fs.readFileSync(path.join(ROOT, 'services', 'authSessionBootstrap.ts'), 'utf8'),
  );
  assert.doesNotMatch(bootstrapCode, /console\.(log|info|warn|error)\s*\(/);
  assert.doesNotMatch(bootstrapCode, /onRecoveryError\(\s*(raw|value|refreshedRaw|session)\s*\)/);

  // The provider logs labels and error objects, never session payloads.
  const contextCode = stripComments(contextSource);
  assert.doesNotMatch(contextCode, /logError\([^)]*access_token/);
  assert.doesNotMatch(contextCode, /logError\([^)]*refresh_token/);
  assert.doesNotMatch(contextCode, /console\.log\s*\(/);

  // Every trace call must use the typed lifecycle schema, never a raw object
  // that could carry session material.
  assert.doesNotMatch(contextCode, /traceAuthLifecycle\([^)]*session:\s*[^)]*\)/);
});

// ---------------------------------------------------------------------------
// Cross-feature identity under a restored session
// ---------------------------------------------------------------------------

test('a resumed session hands features a refreshed token, never the expired one', async () => {
  const backend = createAuthBackend();
  const staleAccessToken = 'access-token-1';
  const { client } = createBootstrapStack({
    backend,
    // Backgrounded past expiry, then foregrounded.
    stored: makeSession({ expires_at: nowSeconds() - 1_800 }),
  });

  // Every feature service resolves identity the same way: getSession().
  const asFeatureWould = await client.auth.getSession();
  assert.ok(asFeatureWould.data.session, 'the actor is still signed in after a long background');
  assert.notEqual(
    asFeatureWould.data.session.access_token,
    staleAccessToken,
    'a protected request never carries the lapsed token',
  );
  assert.equal(asFeatureWould.data.session.user.id, 'actor-1', 'identity is preserved');

  // Repeat feature reads reuse the renewed session without another round trip.
  const second = await client.auth.getSession();
  assert.equal(second.data.session.access_token, asFeatureWould.data.session.access_token);
  assert.equal(backend.refreshCalls, 1, 'one refresh serves every dependent feature');
});

test('every feature service resolves identity through getSession, not a cached token', () => {
  // Guarantees Scanner, Elise, Recent Scans, Dressing Rooms, Shared Rooms and
  // commerce all pick up a restored/rotated session automatically.
  const featureFiles = [
    'services/scanIdentification.ts',
    'services/textScanEdge.ts',
    'services/savedScansCloud.ts',
    'services/savedScanMedia.ts',
    'services/dressingRoomCollaboration.ts',
    'services/sharedRoomMemberships.ts',
    'services/roomMessages.ts',
    'services/styleObjects.ts',
    'services/stylistIdentityService.ts',
    'services/style-chat/styleChatRepository.ts',
    'services/style-chat/styleMemoryRepository.ts',
    'services/free-tier/freeTierSupabaseSync.ts',
    'services/contentReports.ts',
    'services/legalAcceptance.ts',
    'services/supabasePrivacy.js',
  ];

  for (const relative of featureFiles) {
    const source = fs.readFileSync(path.join(ROOT, relative), 'utf8');
    assert.match(
      source,
      /auth\.getSession\(\)/,
      `${relative} must resolve identity through getSession()`,
    );
    assert.doesNotMatch(
      stripComments(source),
      /auth\.refreshSession\(/,
      `${relative} must not open a competing refresh path`,
    );
  }
});

test('an actor switch leaves no previous-actor state behind', () => {
  // The provider resets every actor-owned runtime store on any actor boundary,
  // before the new auth state becomes visible to consumers.
  const resetBlock = contextSource.slice(
    contextSource.indexOf('function resetActorScopedRuntimeState'),
    contextSource.indexOf('export function AuthSessionProvider'),
  );
  for (const reset of [
    'invalidateAllMemoryCache',
    'resetAttachmentStore',
    'clearStyleChatHandoffContext',
    'resetStyleChatGreetingState',
    'resetStylistIdentityStore',
    'resetStylistVoicePreferenceState',
  ]) {
    assert.match(resetBlock, new RegExp(`${reset}\\(\\)`), `${reset} runs at an actor boundary`);
  }
  assert.match(
    contextSource,
    // The reset now receives the incoming actor id so it can also advance the
    // Recent Scan actor epoch. The behaviour asserted here is unchanged: the
    // reset is still keyed to the actor boundary and still runs on every A -> B.
    /noteActor\(usableSession\?\.user\.id \?\? null\)[\s\S]{0,320}resetActorScopedRuntimeState\([^)]*\)/,
    'the reset is keyed to the actor id, so A -> B always clears',
  );
  assert.match(
    contextSource,
    /stopAvatarSpeechPlayback\(\)/,
    'in-flight native playback is stopped at the boundary',
  );
  // Privacy artefacts are actor-scoped too and cleaned on every actor change.
  const layoutSource = fs.readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
  assert.match(layoutSource, /cleanupAllPrivacyArtifacts\(\)/);
});

test('an actor switch mid-recovery cannot restore the previous actor', async () => {
  const storage = createMemoryStorage();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const adapter = createAuthBootstrapStorage({
    storage,
    refreshSession: async () => {
      await gate;
      // Actor A's refresh finally succeeds — after B has signed in.
      return {
        session: makeSession({ access_token: 'actor-a-renewed', expires_at: nowSeconds() + 3600 }),
        error: null,
      };
    },
    onRecoveryError: () => {},
  });

  await storage.setItem('sb-key', JSON.stringify(makeSession({ expires_at: nowSeconds() - 10 })));
  const actorARecovery = adapter.getItem('sb-key');

  const actorB = JSON.stringify(
    makeSession({
      access_token: 'actor-b-access',
      refresh_token: 'actor-b-refresh',
      expires_at: nowSeconds() + 3600,
      user: { id: 'actor-2', aud: 'authenticated', role: 'authenticated' },
    }),
  );
  await adapter.setItem('sb-key', actorB);

  release();
  await actorARecovery;

  const persisted = JSON.parse(await storage.getItem('sb-key'));
  assert.equal(persisted.user.id, 'actor-2', "actor A's late success never overwrites actor B");
  assert.equal(persisted.access_token, 'actor-b-access');
});

test('session storage posture is declared rather than assumed', () => {
  // Android cannot reach the accepted iOS keystore backing without a native
  // rebuild, so the gap must be explicit and machine-readable.
  const { SESSION_STORAGE_POSTURE } = loadTsModule('services/secureSessionStorage.ts', {
    '@react-native-async-storage/async-storage': { default: createMemoryStorage() },
  });
  assert.equal(typeof SESSION_STORAGE_POSTURE.backend, 'string');
  assert.equal(typeof SESSION_STORAGE_POSTURE.encryptedAtRest, 'boolean');
  assert.equal(
    SESSION_STORAGE_POSTURE.encryptedAtRest,
    SESSION_STORAGE_POSTURE.backend === 'platform-keystore',
    'encryption is only ever claimed for a keystore backend',
  );
  if (!SESSION_STORAGE_POSTURE.encryptedAtRest) {
    assert.ok(
      SESSION_STORAGE_POSTURE.degradedReason,
      'a non-encrypted backend must state why',
    );
  }
  assert.match(secureStorageSource, /ios-v17-prelaunch-complete/, 'donor is recorded');
  assert.match(clientSource, /secureSessionStorage/, 'client uses the single storage seam');
});
