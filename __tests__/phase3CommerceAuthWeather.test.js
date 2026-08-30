// Phase 3 — BUG-02 (commerce destinations), BUG-06 (auth session refresh),
// BUG-08 (weather-aware Elise).
//
// Locks the three contracts these repairs establish. All provider HTTP and
// storage is mocked; no network calls and no real Supabase client are used.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function transpile(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function run(rel, requireMap = {}, extraGlobals = {}) {
  const module = { exports: {} };
  const sandbox = {
    console,
    URL,
    setTimeout,
    clearTimeout,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error('Unexpected require: ' + id);
    },
    ...extraGlobals,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transpile(rel), sandbox, { filename: rel });
  return module.exports;
}

// ── BUG-02: commerce destination selection and safety ────────────────────────

const commerce = run('services/commerceDestination.ts');

const RETAILER = 'https://www.nordstrom.com/s/wool-coat/7412589';
const GOOGLE_PRODUCT = 'https://www.google.com/shopping/product/1234567890';
const GOOGLE_SEARCH = 'https://www.google.com/search?tbm=shop&q=wool%20coat';

test('BUG-02: a verified retailer destination is preferred over a Google intermediary', () => {
  // Aggregator listed first: order must not decide the winner.
  assert.equal(commerce.selectCommerceDestination([GOOGLE_PRODUCT, RETAILER]), RETAILER);
  assert.equal(commerce.selectCommerceDestination([RETAILER, GOOGLE_PRODUCT]), RETAILER);
});

test('BUG-02: a Google intermediary is still offered when it is the only destination', () => {
  // Priority tier 3 — a usable generic fallback beats showing nothing.
  assert.equal(commerce.selectCommerceDestination([GOOGLE_SEARCH]), GOOGLE_SEARCH);
  assert.equal(commerce.selectCommerceDestination([GOOGLE_PRODUCT, GOOGLE_SEARCH]), GOOGLE_PRODUCT);
});

test('BUG-02: aggregator classification covers subdomains and other search engines', () => {
  assert.equal(commerce.isAggregatorDestination(GOOGLE_SEARCH), true);
  assert.equal(commerce.isAggregatorDestination('https://shopping.google.com/x'), true);
  assert.equal(commerce.isAggregatorDestination('https://www.bing.com/shop?q=a'), true);
  // A retailer whose name merely contains a search-engine substring is NOT an
  // aggregator — the check is host-anchored, so neutrality is preserved.
  assert.equal(commerce.isAggregatorDestination('https://google.com.evil-retailer.net/p/1'), false);
  assert.equal(commerce.isAggregatorDestination(RETAILER), false);
});

test('BUG-02: unsafe schemes and malformed URLs are rejected', () => {
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///etc/passwd',
    'http://www.nordstrom.com/s/x',      // plain HTTP is not a safe destination
    'not-a-url',
    '',
    '   ',
    null,
    undefined,
    42,
    {},
  ]) {
    assert.equal(commerce.isSafeCommerceUrl(bad), null, `expected rejection: ${String(bad)}`);
  }
});

test('BUG-02: credentialed and internal-network destinations are rejected', () => {
  for (const bad of [
    'https://user:pass@retailer.example.com/p/1',
    'https://localhost/p/1',
    'https://127.0.0.1/p/1',
    'https://10.0.0.5/p/1',
    'https://192.168.1.10/p/1',
    'https://172.16.4.2/p/1',
    'https://169.254.169.254/latest/meta-data',
  ]) {
    assert.equal(commerce.isSafeCommerceUrl(bad), null, `expected rejection: ${bad}`);
  }
});

test('BUG-02: one invalid candidate never suppresses a valid one alongside it', () => {
  assert.equal(
    commerce.selectCommerceDestination(['javascript:alert(1)', null, RETAILER]),
    RETAILER,
  );
  assert.equal(
    commerce.selectCommerceDestination([undefined, 'not-a-url', GOOGLE_SEARCH, RETAILER]),
    RETAILER,
  );
});

test('BUG-02: no usable destination yields null so no dead CTA is offered', () => {
  assert.equal(commerce.selectCommerceDestination([]), null);
  assert.equal(commerce.selectCommerceDestination(['javascript:alert(1)', 'not-a-url']), null);
});

// ── BUG-02: the provider-side selection that produced the defect ─────────────

function loadProvider() {
  let ENV = { SHOPPING_SERPER_API_KEY: 'k' };
  return run(
    'supabase/functions/scan-identify/shoppingProvider.ts',
    {},
    {
      AbortController: globalThis.AbortController,
      fetch: async () => {
        throw new Error('no network in this test');
      },
      Deno: { env: { get: (k) => ENV[k] } },
    },
  );
}

const provider = loadProvider();

test('BUG-02: the provider prefers the retailer link over the search-engine product page', () => {
  // The defect: productLink was taken unconditionally, so a Google Shopping
  // product page won even when the merchant link was present.
  assert.equal(provider.selectRetailerDestination([GOOGLE_PRODUCT, RETAILER]), RETAILER);
});

test('BUG-02: provider normalization rejects unsafe destinations', () => {
  assert.equal(provider.normalizeUrl('javascript:alert(1)'), undefined);
  assert.equal(provider.normalizeUrl('http://retailer.example.com/p'), undefined);
  assert.equal(provider.normalizeUrl('https://127.0.0.1/p'), undefined);
  assert.equal(provider.normalizeUrl('https://u:p@retailer.example.com/p'), undefined);
  assert.equal(typeof provider.normalizeUrl(RETAILER), 'string');
});

test('BUG-02: provider selection still strips tracking parameters', () => {
  const picked = provider.selectRetailerDestination([
    'https://retailer.example.com/p/1?utm_source=google&gclid=abc&size=M',
  ]);
  assert.equal(picked.includes('utm_source'), false);
  assert.equal(picked.includes('gclid'), false);
  // A genuine product parameter must survive.
  assert.equal(picked.includes('size=M'), true);
});

// ── Phase 3 data boundary: what actually reaches a retailer provider ─────────

test('DATA BOUNDARY: the retailer provider receives only the search query', async () => {
  const seen = [];
  const ENV = { SHOPPING_SERPER_API_KEY: 'serper-test-key' };
  const scoped = run(
    'supabase/functions/scan-identify/shoppingProvider.ts',
    {},
    {
      AbortController: globalThis.AbortController,
      Deno: { env: { get: (k) => ENV[k] } },
      fetch: async (url, init) => {
        seen.push({ url: String(url), init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ shopping: [{ title: 'Wool Coat', link: RETAILER, source: 'Nordstrom' }] }),
        };
      },
    },
  );

  await scoped.getShoppingResults({ query: 'navy wool coat', limit: 3 });
  assert.equal(seen.length >= 1, true, 'the provider should have been called');

  const body = JSON.parse(seen[0].init.body);
  // Exactly the query and a result count — nothing identifying.
  assert.deepEqual(Object.keys(body).sort(), ['num', 'q']);

  const serialized = JSON.stringify({ body, headers: seen[0].init.headers }).toLowerCase();
  for (const forbidden of [
    'user_id', 'userid', 'actor', 'session', 'access_token', 'refresh_token',
    'authorization', 'device', 'jwt', 'bearer', 'base64', 'data:image', 'imageuri',
  ]) {
    assert.equal(
      serialized.includes(forbidden),
      false,
      `retailer request must not carry "${forbidden}"`,
    );
  }
});

// ── BUG-06: routing guard must not sign out a refreshable session ────────────

const routingGuard = require(path.join(ROOT, 'services/routingGuard.js'));

const NOW = 1_800_000_000;

test('BUG-06: an expired access token with a refresh token is still usable', () => {
  const session = { expires_at: NOW - 60, refresh_token: 'r1' };
  assert.equal(routingGuard.isSessionUsable(session, NOW), true);
  assert.equal(routingGuard.isAccessTokenExpired(session, NOW), true);
  assert.equal(
    routingGuard.getSessionAuthState(session, NOW),
    routingGuard.AUTH_STATE.RECOVERY_PENDING,
  );
});

test('BUG-06: an expired access token with no refresh token is unusable', () => {
  const session = { expires_at: NOW - 60, refresh_token: '' };
  assert.equal(routingGuard.isSessionUsable(session, NOW), false);
  assert.equal(
    routingGuard.getSessionAuthState(session, NOW),
    routingGuard.AUTH_STATE.UNAUTHENTICATED,
  );
});

test('BUG-06: a lapsed session is held in recovery, never redirected to login', () => {
  const state = routingGuard.getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: NOW,
    profile: null,
    profileLoading: false,
    onboardingComplete: true,
    recoveryPending: true,
  });
  assert.equal(state.action, 'recovering');
  assert.equal(state.redirectTo, null);
});

test('BUG-06: with no recoverable material the actor is still routed to login', () => {
  const state = routingGuard.getRoutingGuardState({
    pathname: '/',
    loading: false,
    session: null,
    nowSeconds: NOW,
    profile: null,
    profileLoading: false,
    onboardingComplete: true,
    recoveryPending: false,
  });
  assert.equal(state.action, 'redirect');
  assert.equal(state.redirectTo, '/auth');
});

// ── BUG-06: the bootstrap storage adapter's refresh semantics ────────────────

const bootstrap = run('services/authSessionBootstrap.ts');

const KEY = 'sb-kscan-auth-token';

function persistedSession(expiresAtMs) {
  return JSON.stringify({
    access_token: 'a1',
    refresh_token: 'r1',
    expires_at: Math.floor(expiresAtMs / 1000),
  });
}

function makeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    async getItem(k) {
      return map.has(k) ? map.get(k) : null;
    },
    async setItem(k, v) {
      map.set(k, v);
    },
    async removeItem(k) {
      map.delete(k);
    },
  };
}

test('BUG-06: a transient refresh failure keeps the session recoverable', async () => {
  const storage = makeStorage({ [KEY]: persistedSession(1000) });
  let attempts = 0;
  const adapter = bootstrap.createAuthBootstrapStorage({
    storage,
    now: () => 1000,
    refreshSession: async () => {
      attempts += 1;
      // AuthRetryableFetchError is the offline/5xx shape.
      return { session: null, error: { name: 'AuthRetryableFetchError', status: 0 } };
    },
    onRecoveryError: () => {},
  });

  assert.equal(await adapter.getItem(KEY), null);
  // The stored credential must survive — this is what a relaunch recovers from.
  assert.equal(storage.map.has(KEY), true);
  assert.equal(adapter.hasPendingSessionRecovery(), true);

  // The key is NOT hidden: the very next read tries again.
  await adapter.getItem(KEY);
  assert.equal(attempts, 2);
});

test('BUG-06: a terminal refresh rejection clears the stored session', async () => {
  const storage = makeStorage({ [KEY]: persistedSession(1000) });
  const adapter = bootstrap.createAuthBootstrapStorage({
    storage,
    now: () => 1000,
    refreshSession: async () => ({
      session: null,
      error: { code: 'refresh_token_already_used' },
    }),
    onRecoveryError: () => {},
  });

  assert.equal(await adapter.getItem(KEY), null);
  assert.equal(storage.map.has(KEY), false);
  assert.equal(adapter.hasPendingSessionRecovery(), false);
});

test('BUG-06: transient and terminal failures are classified apart', () => {
  assert.equal(bootstrap.isTerminalRefreshFailure({ code: 'refresh_token_not_found' }), true);
  assert.equal(bootstrap.isTerminalRefreshFailure({ code: 'user_not_found' }), true);
  assert.equal(bootstrap.isTerminalRefreshFailure({ name: 'AuthRetryableFetchError' }), false);
  // A rate limit or a 5xx must never be read as an authorization decision.
  assert.equal(bootstrap.isTerminalRefreshFailure({ status: 429 }), false);
  assert.equal(bootstrap.isTerminalRefreshFailure({ status: 500 }), false);
  assert.equal(bootstrap.isTerminalRefreshFailure(new Error('offline')), false);
});

test('BUG-06: concurrent reads share one refresh, so tokens rotate once', async () => {
  const storage = makeStorage({ [KEY]: persistedSession(1000) });
  let refreshCalls = 0;
  const adapter = bootstrap.createAuthBootstrapStorage({
    storage,
    now: () => 1000,
    refreshSession: async () => {
      refreshCalls += 1;
      await new Promise((r) => setTimeout(r, 5));
      return {
        session: { access_token: 'a2', refresh_token: 'r2', expires_at: 9_999_999 },
        error: null,
      };
    },
    onRecoveryError: () => {},
  });

  const [first, second, third] = await Promise.all([
    adapter.getItem(KEY),
    adapter.getItem(KEY),
    adapter.getItem(KEY),
  ]);
  assert.equal(refreshCalls, 1, 'a refresh token must never be rotated concurrently');
  assert.equal(first, second);
  assert.equal(second, third);
  assert.equal(JSON.parse(first).access_token, 'a2');
});

test('BUG-06: a refreshed session is persisted for the next launch', async () => {
  const storage = makeStorage({ [KEY]: persistedSession(1000) });
  const adapter = bootstrap.createAuthBootstrapStorage({
    storage,
    now: () => 1000,
    refreshSession: async () => ({
      session: { access_token: 'a2', refresh_token: 'r2', expires_at: 9_999_999 },
      error: null,
    }),
    onRecoveryError: () => {},
  });

  await adapter.getItem(KEY);
  assert.equal(JSON.parse(storage.map.get(KEY)).access_token, 'a2');
});

test('BUG-06: a session comfortably inside its lifetime is not refreshed', async () => {
  const storage = makeStorage({ [KEY]: persistedSession(10_000_000) });
  let refreshCalls = 0;
  const adapter = bootstrap.createAuthBootstrapStorage({
    storage,
    now: () => 1000,
    refreshSession: async () => {
      refreshCalls += 1;
      return { session: null, error: null };
    },
    onRecoveryError: () => {},
  });

  assert.notEqual(await adapter.getItem(KEY), null);
  assert.equal(refreshCalls, 0);
});

test('BUG-06: sign-out cleanup destroys stored session material', async () => {
  const storage = makeStorage({ [KEY]: persistedSession(10_000_000) });
  const adapter = bootstrap.createAuthBootstrapStorage({
    storage,
    now: () => 1000,
    refreshSession: async () => ({ session: null, error: null }),
    onRecoveryError: () => {},
  });

  await adapter.getItem(KEY);
  await adapter.clearPersistedSessions();
  assert.equal(storage.map.has(KEY), false);
  // And the cleared key stays unreadable for this client instance.
  assert.equal(await adapter.getItem(KEY), null);
});

// ── BUG-08: weather permission must not latch to a refusal never given ───────

function loadWeatherStore(storage, env = {}) {
  const constants = run('constants/weatherStyling.ts', {}, { process: { env } });
  return run(
    'services/weather/weatherPermissionStore.ts',
    {
      '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
      '../../constants/weatherStyling': constants,
    },
    { process: { env } },
  );
}

const weatherStore = loadWeatherStore(makeStorage());

test('BUG-08: an unanswered OS prompt never persists a denial', () => {
  // The defect: "undetermined" was collapsed to "denied" and then written,
  // permanently disabling a feature the user was never asked about.
  assert.equal(weatherStore.resolveOpenPermissionState('undetermined', true, 'not_asked'), null);
  assert.equal(weatherStore.resolveOpenPermissionState('undetermined', true, 'dismissed'), null);
  assert.equal(weatherStore.resolveOpenPermissionState('undetermined', false, 'not_asked'), null);
});

test('BUG-08: a dismissed prompt keeps its cooldown instead of becoming terminal', () => {
  // "Not now" must stay re-promptable; writing 'denied' would retire the
  // 7-day / 5-session policy for the life of the install.
  assert.equal(weatherStore.resolveOpenPermissionState('denied', true, 'dismissed'), null);
  assert.equal(weatherStore.resolveOpenPermissionState('unavailable', true, 'dismissed'), null);
});

test('BUG-08: a real OS refusal is still recorded truthfully', () => {
  assert.equal(weatherStore.resolveOpenPermissionState('denied', true, 'not_asked'), 'denied');
  assert.equal(weatherStore.resolveOpenPermissionState('unavailable', true, 'not_asked'), 'denied');
});

test('BUG-08: an OS grant is always adopted', () => {
  for (const state of ['not_asked', 'dismissed', 'denied', 'granted']) {
    assert.equal(weatherStore.resolveOpenPermissionState('granted', false, state), 'granted');
  }
});

test('BUG-08: a dismissed record stays prompt-eligible after the cooldown', () => {
  const dismissedAt = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const record = { schemaVersion: 1, state: 'dismissed', updatedAt: dismissedAt, dismissedAt, sessionsSinceDismiss: 0 };
  assert.equal(weatherStore.isPromptEligible(record), true);
  // A terminal 'denied' — which the defect used to write here — never re-offers.
  assert.equal(weatherStore.isPromptEligible({ schemaVersion: 1, state: 'denied', updatedAt: dismissedAt }), false);
});

// ── BUG-08: OS status classification ────────────────────────────────────────

function loadWeatherContext(locationModule, env = { EXPO_PUBLIC_WEATHER_STYLING_CONTEXT_ENABLED: 'true' }) {
  const constants = run('constants/weatherStyling.ts', {}, { process: { env } });
  return run(
    'services/weather/weatherStylingContext.ts',
    {
      'expo-location': locationModule,
      '../../constants/weatherStyling': constants,
    },
    { process: { env }, Date },
  );
}

const PermissionStatus = { GRANTED: 'granted', DENIED: 'denied', UNDETERMINED: 'undetermined' };

test('BUG-08: an unanswered OS prompt reports undetermined, not denied', async () => {
  const ctx = loadWeatherContext({
    PermissionStatus,
    getForegroundPermissionsAsync: async () => ({ status: 'undetermined', canAskAgain: true }),
    requestForegroundPermissionsAsync: async () => ({ status: 'undetermined' }),
    getCurrentPositionAsync: async () => ({ coords: { latitude: 0, longitude: 0 } }),
    Accuracy: { Low: 1 },
  });
  assert.equal(await ctx.getForegroundPermissionStatus(), 'undetermined');
});

test('BUG-08: a refusal the OS will not re-ask reports denied', async () => {
  const ctx = loadWeatherContext({
    PermissionStatus,
    getForegroundPermissionsAsync: async () => ({ status: 'denied', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: 'denied' }),
    getCurrentPositionAsync: async () => ({ coords: { latitude: 0, longitude: 0 } }),
    Accuracy: { Low: 1 },
  });
  assert.equal(await ctx.getForegroundPermissionStatus(), 'denied');
});

test('BUG-08: a granted OS permission reports granted', async () => {
  const ctx = loadWeatherContext({
    PermissionStatus,
    getForegroundPermissionsAsync: async () => ({ status: 'granted', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => ({ coords: { latitude: 0, longitude: 0 } }),
    Accuracy: { Low: 1 },
  });
  assert.equal(await ctx.getForegroundPermissionStatus(), 'granted');
});

test('BUG-08: weather stays foreground-only and coarse', async () => {
  const calls = [];
  const ctx = loadWeatherContext({
    PermissionStatus,
    getForegroundPermissionsAsync: async () => {
      calls.push('getForeground');
      return { status: 'granted', canAskAgain: false };
    },
    requestForegroundPermissionsAsync: async () => {
      calls.push('requestForeground');
      return { status: 'granted' };
    },
    getCurrentPositionAsync: async (opts) => {
      calls.push(`position:${opts.accuracy}`);
      return { coords: { latitude: 51.50735, longitude: -0.12776 } };
    },
    Accuracy: { Low: 1 },
  });

  const input = await ctx.getWeatherLocationInput();
  assert.equal(input.source, 'gps_foreground');
  // Coordinates are reduced to ~11km before they can leave the device.
  assert.equal(input.roundedLat, 51.5);
  assert.equal(input.roundedLon, -0.1);
  // Nothing may request background or continuous location.
  assert.equal(calls.some((c) => /background|watch/i.test(c)), false);
  assert.equal(calls.includes('position:1'), true);
});

test('BUG-08: a location failure yields no weather rather than blocking Elise', async () => {
  const ctx = loadWeatherContext({
    PermissionStatus,
    getForegroundPermissionsAsync: async () => ({ status: 'granted', canAskAgain: false }),
    requestForegroundPermissionsAsync: async () => ({ status: 'granted' }),
    getCurrentPositionAsync: async () => {
      throw new Error('no fix');
    },
    Accuracy: { Low: 1 },
  });
  assert.equal(await ctx.getWeatherLocationInput(), null);
});

test('BUG-08: weather is skipped entirely when permission is not granted', async () => {
  const ctx = loadWeatherContext({
    PermissionStatus,
    getForegroundPermissionsAsync: async () => ({ status: 'undetermined', canAskAgain: true }),
    requestForegroundPermissionsAsync: async () => ({ status: 'undetermined' }),
    getCurrentPositionAsync: async () => {
      throw new Error('must not be called');
    },
    Accuracy: { Low: 1 },
  });
  assert.equal(await ctx.getWeatherLocationInput(), null);
});
