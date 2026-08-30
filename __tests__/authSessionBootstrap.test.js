const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { exports: module.exports, module, Set }, { filename });
  return module.exports;
}

const {
  createAuthActorBoundaryGuard,
  createAuthBootstrapGenerationGuard,
  createAuthBootstrapStorage,
  isHandledStaleRefreshTokenError,
  isTerminalRefreshFailure,
} = loadTsModule(
  'services/authSessionBootstrap.ts',
);

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
  };
}

function session(overrides = {}) {
  return {
    access_token: 'access-token',
    refresh_token: 'refresh-token',
    expires_at: 1,
    expires_in: 3600,
    token_type: 'bearer',
    user: { id: 'actor-1', aud: 'authenticated', role: 'authenticated' },
    ...overrides,
  };
}

test('a newer auth event makes an older bootstrap result ineligible to update session state', () => {
  const guard = createAuthBootstrapGenerationGuard();
  const bootstrapGeneration = guard.beginBootstrap();

  guard.noteAuthEvent();

  assert.equal(guard.isBootstrapCurrent(bootstrapGeneration), false);
});

test('a bootstrap result remains current when no auth event arrived after it started', () => {
  const guard = createAuthBootstrapGenerationGuard();
  const bootstrapGeneration = guard.beginBootstrap();

  assert.equal(guard.isBootstrapCurrent(bootstrapGeneration), true);
});

test('duplicate auth events reset actor state only once per actor boundary', () => {
  const guard = createAuthActorBoundaryGuard();

  assert.equal(guard.noteActor(null), true, 'initial signed-out state is an actor boundary');
  assert.equal(guard.noteActor(null), false, 'duplicate INITIAL_SESSION is ignored');
  assert.equal(guard.noteActor('actor-1'), true);
  assert.equal(guard.noteActor('actor-1'), false, 'duplicate SIGNED_IN is ignored');
  assert.equal(guard.noteActor(null), true, 'sign-out resets actor state');
});

for (const provider of ['google', 'apple', 'password']) {
  test(`late empty bootstrap cannot overwrite a fresh ${provider} SIGNED_IN session`, () => {
    const guard = createAuthBootstrapGenerationGuard();
    const bootstrapGeneration = guard.beginBootstrap();
    let activeSession = null;

    activeSession = { provider, state: 'SIGNED_IN' };
    guard.noteAuthEvent();

    if (guard.isBootstrapCurrent(bootstrapGeneration)) {
      activeSession = null;
    }

    assert.deepEqual(activeSession, { provider, state: 'SIGNED_IN' });
  });

  test(`delayed stale-refresh cleanup cannot clear a fresh ${provider} session`, () => {
    const guard = createAuthBootstrapGenerationGuard();
    const bootstrapGeneration = guard.beginBootstrap();
    let activeSession = null;
    let cleanupCount = 0;
    const staleError = {
      name: 'AuthApiError',
      status: 400,
      code: 'refresh_token_not_found',
      message: 'Invalid Refresh Token: Refresh Token Not Found',
    };

    activeSession = { provider, state: 'SIGNED_IN' };
    guard.noteAuthEvent();

    if (
      isHandledStaleRefreshTokenError(staleError) &&
      guard.isBootstrapCurrent(bootstrapGeneration)
    ) {
      cleanupCount += 1;
      activeSession = null;
    }

    assert.equal(cleanupCount, 0);
    assert.deepEqual(activeSession, { provider, state: 'SIGNED_IN' });
  });
}

test('a restored valid session is applied when bootstrap remains authoritative', () => {
  const guard = createAuthBootstrapGenerationGuard();
  const bootstrapGeneration = guard.beginBootstrap();
  let activeSession = null;
  const restoredSession = { provider: 'restored', state: 'RESTORED' };

  if (guard.isBootstrapCurrent(bootstrapGeneration)) {
    activeSession = restoredSession;
  }

  assert.strictEqual(activeSession, restoredSession);
});

test('a current invalid-refresh bootstrap resolves signed out without a retry loop', () => {
  const guard = createAuthBootstrapGenerationGuard();
  const bootstrapGeneration = guard.beginBootstrap();
  let activeSession = { provider: 'stale', state: 'RESTORED' };
  let cleanupCount = 0;

  if (guard.isBootstrapCurrent(bootstrapGeneration)) {
    cleanupCount += 1;
    activeSession = null;
  }

  assert.equal(cleanupCount, 1);
  assert.equal(activeSession, null);
});

test('expected stale refresh token errors are handled quietly', () => {
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthApiError',
      status: 400,
      code: 'refresh_token_not_found',
      message: 'Invalid Refresh Token: Refresh Token Not Found',
    }),
    true,
  );
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthApiError',
      status: 400,
      message: 'Invalid Refresh Token: Refresh Token Already Used',
    }),
    true,
  );
});

test('unexpected auth failures remain reportable', () => {
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthRetryableFetchError',
      status: 0,
      message: 'Network request failed',
    }),
    false,
  );
  assert.equal(
    isHandledStaleRefreshTokenError({
      name: 'AuthApiError',
      status: 500,
      message: 'Unexpected auth failure',
    }),
    false,
  );
});

test('invalid refresh token during storage bootstrap is cleared once and fails signed out', async () => {
  const key = 'sb-project-auth-token';
  const storage = createMemoryStorage({ [key]: JSON.stringify(session()) });
  const observedErrors = [];
  let refreshCalls = 0;
  const wrapped = createAuthBootstrapStorage({
    storage,
    now: () => 100_000,
    refreshSession: async () => {
      refreshCalls += 1;
      return {
        session: null,
        error: {
          name: 'AuthApiError',
          status: 400,
          code: 'refresh_token_not_found',
          message: 'Invalid Refresh Token: Refresh Token Not Found',
        },
      };
    },
    onRecoveryError: (error) => observedErrors.push(error),
  });

  assert.deepEqual(await Promise.all([wrapped.getItem(key), wrapped.getItem(key)]), [null, null]);
  assert.equal(await storage.getItem(key), null, 'terminal stale session is removed locally');
  assert.equal(await wrapped.getItem(key), null);
  assert.equal(refreshCalls, 1, 'duplicate reads never create a refresh retry loop');
  assert.equal(observedErrors.length, 1);
  assert.equal(isHandledStaleRefreshTokenError(observedErrors[0]), true);
});

test('a valid existing session bypasses startup refresh and remains available', async () => {
  const key = 'sb-project-auth-token';
  const valid = session({ expires_at: 1_000 });
  const raw = JSON.stringify(valid);
  const storage = createMemoryStorage({ [key]: raw });
  let refreshCalls = 0;
  const wrapped = createAuthBootstrapStorage({
    storage,
    now: () => 100_000,
    refreshSession: async () => {
      refreshCalls += 1;
      return { session: null, error: null };
    },
    onRecoveryError: () => assert.fail('valid session must not report a recovery error'),
  });

  assert.equal(await wrapped.getItem(key), raw);
  assert.equal(refreshCalls, 0);
});

test('a valid near-expiry session keeps normal Supabase refresh behavior', async () => {
  const key = 'sb-project-auth-token';
  const refreshed = session({
    access_token: 'new-access-token',
    refresh_token: 'new-refresh-token',
    expires_at: 1_000,
  });
  const storage = createMemoryStorage({ [key]: JSON.stringify(session()) });
  const wrapped = createAuthBootstrapStorage({
    storage,
    now: () => 100_000,
    refreshSession: async (refreshToken) => {
      assert.equal(refreshToken, 'refresh-token');
      return { session: refreshed, error: null };
    },
    onRecoveryError: () => assert.fail('valid refresh must not report a recovery error'),
  });

  assert.deepEqual(JSON.parse(await wrapped.getItem(key)), refreshed);
  assert.deepEqual(JSON.parse(await storage.getItem(key)), refreshed);
});

test('a transient network failure is retained, reported, and never classified as stale-token recovery', async () => {
  const key = 'sb-project-auth-token';
  const raw = JSON.stringify(session());
  const storage = createMemoryStorage({ [key]: raw });
  const observedErrors = [];
  let refreshCalls = 0;
  const networkError = {
    name: 'AuthRetryableFetchError',
    status: 0,
    message: 'Network request failed',
  };
  const wrapped = createAuthBootstrapStorage({
    storage,
    now: () => 100_000,
    refreshSession: async () => {
      refreshCalls += 1;
      return { session: null, error: networkError };
    },
    onRecoveryError: (error) => observedErrors.push(error),
  });

  // Owner ruling: a refreshable session must survive a transient failure. The
  // stored material is never discarded and every later read retries recovery,
  // so the actor is never signed out for a network fault.
  assert.equal(await wrapped.getItem(key), null, 'this read resolves empty');
  assert.equal(await storage.getItem(key), raw, 'stored session is never discarded');
  assert.equal(await wrapped.getItem(key), null);
  assert.equal(refreshCalls, 2, 'each read retries; nothing is permanently hidden');
  assert.strictEqual(observedErrors[0], networkError);
  assert.equal(isHandledStaleRefreshTokenError(observedErrors[0]), false);
  assert.equal(isTerminalRefreshFailure(observedErrors[0]), false);
  assert.equal(wrapped.hasPendingSessionRecovery(), true, 'surfaced as recovery, not sign-out');
});

test('Supabase initial-session bootstrap emits no console.error for expected stale recovery', async () => {
  const { createClient } = require('@supabase/supabase-js');
  const key = 'sb-bootstrap-test-auth-token';
  const storage = createMemoryStorage({ [key]: JSON.stringify(session()) });
  const refreshClient = createClient('https://bootstrap-test.supabase.co', 'test-anon-key', {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      storageKey: 'bootstrap-refresh-test',
    },
    global: {
      fetch: async () => new Response(
        JSON.stringify({
          code: 'refresh_token_not_found',
          msg: 'Invalid Refresh Token: Refresh Token Not Found',
        }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      ),
    },
  });
  const wrapped = createAuthBootstrapStorage({
    storage,
    now: () => Date.now(),
    refreshSession: async (refreshToken) => {
      const { data, error } = await refreshClient.auth.refreshSession({
        refresh_token: refreshToken,
      });
      return { session: data.session, error };
    },
    onRecoveryError: () => {},
  });
  const consoleErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => consoleErrors.push(args);
  try {
    const client = createClient('https://bootstrap-test.supabase.co', 'test-anon-key', {
      auth: {
        storage: wrapped,
        storageKey: key,
        persistSession: true,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    });
    const { data, error } = await client.auth.getSession();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(error, null);
    assert.equal(data.session, null);
    assert.deepEqual(consoleErrors, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test('auth bootstrap defers background refresh until handled session recovery completes', () => {
  const clientSource = fs.readFileSync(path.join(ROOT, 'services/supabaseClient.ts'), 'utf8');
  const contextSource = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');

  assert.match(clientSource, /autoRefreshToken:\s*false/);
  assert.match(contextSource, /await supabase\.auth\.getSession\(\)/);
  assert.match(contextSource, /isHandledStaleRefreshTokenError\(error\)/);
  assert.match(clientSource, /createAuthBootstrapStorage/);
  assert.match(contextSource, /takeAuthBootstrapStorageError\(\)/);
  assert.match(contextSource, /await supabase\.auth\.startAutoRefresh\(\)/);
  assert.match(contextSource, /isBootstrapCurrent\(startGeneration\)/);
  assert.doesNotMatch(contextSource, /signOut\(\{ scope: 'local' \}\)/);
  assert.doesNotMatch(clientSource, /console\.error\(/);
  assert.doesNotMatch(contextSource, /console\.error\(/);
});

test('auth actor boundaries clear Elise identity, voice, feedback-facing, and chat runtime state', () => {
  const contextSource = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');

  assert.match(contextSource, /resetStylistIdentityStore\(\)/);
  assert.match(contextSource, /resetStylistVoicePreferenceState\(\)/);
  assert.match(contextSource, /invalidateAllMemoryCache\(\)/);
  assert.match(contextSource, /resetAttachmentStore\(\)/);
  assert.match(contextSource, /clearStyleChatHandoffContext\(\)/);
  assert.match(contextSource, /resetStyleChatGreetingState\(\)/);
});

test('auth lifecycle trace schema cannot accept secret-bearing fields from callers', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/authLifecycleTrace.ts'), 'utf8');
  assert.match(source, /Development-only auth trace/);
  assert.doesNotMatch(source, /^\s*(?:accessToken|refreshToken|authorizationCode|email|userId)\??:/m);
});

test('expected feature-freeze fallback remains observable without a warning badge', () => {
  const source = fs.readFileSync(path.join(ROOT, 'services/featureFreeze.ts'), 'utf8');
  assert.match(source, /console\.info\('\[K-SCAN FeatureFreeze\] remote fetch failed/);
  assert.doesNotMatch(source, /console\.warn\('\[K-SCAN FeatureFreeze\] remote fetch failed/);
});
