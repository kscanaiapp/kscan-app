/**
 * RP-109 — behavioural coverage for the bounded logout push revocation.
 *
 * The defect: contexts/AuthSessionContext.tsx awaited
 * revokeWatchAlertsForThisDevice() with no network deadline. The helper caught
 * ordinary failures, but a request that HUNG — a captive portal, a stalled TLS
 * handshake, a dead radio — never settled, so the await never returned and the
 * user could not finish logging out. Ending the authenticated session is the
 * action the user asked for; push cleanup is not allowed to outrank it.
 *
 * These tests execute the real helper with fake timers, so "is the wait
 * bounded?" is answered by advancing the clock rather than by reading source.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const DEVICE_ID_KEY = 'kscan-watchlist-device-id';

/**
 * A controllable clock. The module under test captures setTimeout/clearTimeout
 * from its sandbox, so this observes whether the deadline timer is created AND
 * whether it is cleared on the fast path (§24.10).
 */
function createClock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    live: () => timers.size,
    cleared: 0,
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) {
      if (timers.delete(id)) this.cleared += 1;
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.fn();
        }
      }
    },
  };
}

function loadPushRegistration({ storage, invoke, session, clock }) {
  const filename = path.join(ROOT, 'services/watchlist/pushRegistration.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const invocations = [];
  const requireMap = {
    'react-native': { Platform: { OS: 'ios' }, Linking: { openSettings: async () => {} } },
    'expo-constants': { __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'p' } } } } },
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    '../supabaseClient': {
      supabase: {
        functions: {
          invoke: async (fn, options) => {
            invocations.push({ fn, body: options.body });
            return invoke ? invoke(fn, options) : { data: {}, error: null };
          },
        },
      },
    },
    '../authenticatedFunctionSession': {
      resolveAuthenticatedFunctionSession: async () => (session ? session() : { ok: true }),
    },
    'expo-notifications': { addPushTokenListener: () => ({ remove: () => {} }) },
    // Android Repair 05: this suite exercises revocation / refresh / actor
    // behaviour, not the activation gate, so the capability is supplied ACTIVE
    // -- the state in which every pre-repair behaviour asserted below must be
    // preserved byte-for-byte. The gate's own truth table (including the
    // states that suppress activation) is proven in
    // __tests__/androidNotificationActivationGating.test.js.
    '../notifications/remotePushCapability': { resolveRemotePushActivationAllowed: () => true },
  };

  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      __DEV__: false,
      console,
      Date,
      Error,
      Promise,
      Object,
      JSON,
      Math,
      Number,
      String,
      Boolean,
      Array,
      setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
      clearTimeout: (id) => clock.clearTimeout(id),
      exports: module.exports,
      module,
      require: (id) => {
        if (id in requireMap) return requireMap[id];
        if (id.startsWith('node:')) return require(id);
        throw new Error(`Unexpected require: ${id}`);
      },
    },
    { filename },
  );
  return { mod: module.exports, invocations };
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: async (key) => (values.has(key) ? values.get(key) : null),
    setItem: async (key, value) => values.set(key, value),
    removeItem: async (key) => values.delete(key),
  };
}

/** Let queued microtasks drain without advancing the fake clock. */
const drain = async (times = 8) => {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
};

// ─── §17: the deadline is explicit ──────────────────────────────────────────

test('RP-109 §17: the revocation deadline is an explicit, exported constant', () => {
  const clock = createClock();
  const { mod } = loadPushRegistration({ storage: memoryStorage(), clock });
  assert.equal(typeof mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS, 'number');
  assert.ok(mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS > 0);
  // A conservative few seconds: long enough for a slow mobile round trip,
  // short enough that a hung request never reads as a failed logout.
  assert.ok(mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS <= 10000);
});

test('RP-109 §17: no dependency was added for the deadline', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const names = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  for (const forbidden of ['p-timeout', 'promise-timeout', 'delay', 'abort-controller']) {
    assert.ok(!names.includes(forbidden), `must not add "${forbidden}"`);
  }
});

// ─── §24.1/§24.2: the attempt happens, with the old authority available ─────

test('RP-109: logout revocation targets this device and reports success', async () => {
  const clock = createClock();
  const { mod, invocations } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    clock,
  });

  const outcome = await mod.revokeWatchAlertsForThisDevice();

  assert.equal(outcome, 'revoked');
  assert.deepEqual(invocations.map((c) => c.body.action), ['revoke_push_token']);
  assert.equal(invocations[0].body.deviceId, 'device-a');
});

test('RP-109 §24.2: the attempt resolves the OLD authenticated session first', async () => {
  const order = [];
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    session: () => {
      order.push('resolve-session');
      return { ok: true };
    },
    invoke: async () => {
      order.push('invoke');
      return { data: {}, error: null };
    },
    clock,
  });

  await mod.revokeWatchAlertsForThisDevice();

  assert.deepEqual(order, ['resolve-session', 'invoke']);
});

test('RP-109: an unauthenticated attempt reports no_session and issues nothing', async () => {
  const clock = createClock();
  const { mod, invocations } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    session: () => ({ ok: false, reason: 'expired' }),
    clock,
  });

  assert.equal(await mod.revokeWatchAlertsForThisDevice(), 'no_session');
  assert.equal(invocations.length, 0);
});

test('RP-109: a device that never registered needs no call and mints no id', async () => {
  const clock = createClock();
  const storage = memoryStorage();
  const { mod, invocations } = loadPushRegistration({ storage, clock });

  assert.equal(await mod.revokeWatchAlertsForThisDevice(), 'not_registered');
  assert.equal(invocations.length, 0);
  assert.equal(storage.values.has(DEVICE_ID_KEY), false);
});

// ─── §24.3/§24.10: success is not delayed, and the timer is cleaned up ──────

test('RP-109 §24.3+§24.10: success settles without the clock and clears its timer', async () => {
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    clock,
  });

  // Never advanced: a successful revocation must not wait for the deadline.
  const outcome = await mod.revokeWatchAlertsForThisDevice();

  assert.equal(outcome, 'revoked');
  assert.equal(clock.live(), 0, 'the deadline timer must not be left pending');
  assert.equal(clock.cleared, 1, 'the deadline timer must be explicitly cleared');
});

// ─── §24.4/§24.5: a hung request is bounded and still lets logout finish ────

test('RP-109 §24.4+§24.5: a request that never settles times out at the deadline', async () => {
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    // The hostile case: a promise that never settles at all.
    invoke: () => new Promise(() => {}),
    clock,
  });

  let settled = null;
  const pending = mod.revokeWatchAlertsForThisDevice().then((value) => {
    settled = value;
  });

  await drain();
  assert.equal(settled, null, 'must still be waiting before the deadline');

  clock.advance(mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS);
  await pending;

  assert.equal(settled, 'timed_out');
});

test('RP-109 §24.5: a hung revocation resolves rather than rejecting', async () => {
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    invoke: () => new Promise(() => {}),
    clock,
  });

  const pending = mod.revokeWatchAlertsForThisDevice();
  await drain();
  clock.advance(mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS);

  // await, not .catch: a rejection here would propagate into signOut and
  // abort the logout it is supposed to precede.
  await assert.doesNotReject(() => pending);
});

// ─── §24.6/§24.7: ordinary failures, and no unhandled rejection ─────────────

test('RP-109 §24.6: an ordinary backend failure resolves as a reason code', async () => {
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    invoke: async () => ({ data: null, error: { message: 'revoke_failed', status: 502 } }),
    clock,
  });

  assert.equal(await mod.revokeWatchAlertsForThisDevice(), 'failed');
});

test('RP-109 §24.7: a rejection landing AFTER the deadline is not unhandled', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const clock = createClock();
    let rejectLate;
    const { mod } = loadPushRegistration({
      storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
      invoke: () =>
        new Promise((_resolve, reject) => {
          rejectLate = reject;
        }),
      clock,
    });

    const pending = mod.revokeWatchAlertsForThisDevice();
    await drain();
    clock.advance(mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS);
    assert.equal(await pending, 'timed_out');

    // The abandoned request fails long after logout moved on.
    rejectLate(new Error('socket closed after logout'));
    await drain(20);
    await new Promise((resolve) => setImmediate(resolve));
    await drain(20);

    assert.deepEqual(unhandled, [], 'the abandoned request must stay handled');
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('RP-109 §24.10: a timeout leaves no live timer behind', async () => {
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    invoke: () => new Promise(() => {}),
    clock,
  });

  const pending = mod.revokeWatchAlertsForThisDevice();
  await drain();
  clock.advance(mod.LOGOUT_PUSH_REVOCATION_DEADLINE_MS);
  await pending;

  assert.equal(clock.live(), 0);
});

// ─── §19: the outcome carries no private material ───────────────────────────

test('RP-109 §19: every outcome is an opaque reason code', async () => {
  const secret = 'bearer eyJhbGciOi... user@example.com https://project.supabase.co';
  const clock = createClock();
  const { mod } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-abcdef-0123456789' }),
    invoke: async () => ({ data: null, error: { message: secret, stack: secret } }),
    clock,
  });

  const outcome = await mod.revokeWatchAlertsForThisDevice();

  assert.equal(typeof outcome, 'string');
  assert.ok(
    ['revoked', 'not_registered', 'no_session', 'failed', 'timed_out'].includes(outcome),
    `unexpected outcome vocabulary: ${outcome}`,
  );
  assert.ok(!outcome.includes('device-abcdef'));
  assert.ok(!outcome.includes('@'));
  assert.ok(!outcome.includes('supabase'));
});

// ─── §16/§18/§20: the sign-out call site ────────────────────────────────────

const authContext = fs.readFileSync(path.join(ROOT, 'contexts/AuthSessionContext.tsx'), 'utf8');
const signOutBody = authContext.slice(
  authContext.indexOf('const signOut = useCallback'),
  authContext.indexOf('const retrySessionRecovery = useCallback'),
);

test('RP-109 §16: the actor is sealed before the revocation is attempted', () => {
  const seal = signOutBody.indexOf('signedOutRef.current = true');
  const revoke = signOutBody.indexOf('revokeWatchAlertsForThisDevice()');
  assert.ok(seal >= 0 && revoke >= 0);
  assert.ok(seal < revoke, 'the old actor must be sealed before any await');
});

test('RP-109 §16: the revocation runs while the old session still exists', () => {
  // Strip comments first: the prose explaining this ordering legitimately
  // names both calls, so only executable code is evidence of the order.
  const code = signOutBody.replace(/\/\/.*$/gm, '');
  const revoke = code.indexOf('await revokeWatchAlertsForThisDevice()');
  const destroy = code.indexOf('await supabase.auth.signOut()');
  assert.ok(revoke >= 0 && destroy >= 0);
  assert.ok(
    revoke < destroy,
    'moving the revocation after session destruction would make it unauthorized',
  );
});

test('RP-109 §18: no revocation outcome can stop the logout', () => {
  const code = signOutBody.replace(/\/\/.*$/gm, '');
  const revoke = code.indexOf('const pushRevocation = await revokeWatchAlertsForThisDevice()');
  assert.ok(revoke >= 0, 'the outcome must be captured, not discarded');
  const destroy = code.indexOf('await supabase.auth.signOut()');
  assert.ok(destroy > revoke, 'logout must still run after the revocation');

  // Unlike the explicit-OFF surface, logout has NO failure branch. Nothing
  // between the revocation and the session teardown may return or throw, or a
  // timed-out cleanup would leave the user stuck inside the session this call
  // exists to end.
  const between = code.slice(revoke, destroy);
  assert.doesNotMatch(between, /\breturn\b/, 'must not short-circuit the logout');
  assert.doesNotMatch(between, /\bthrow\b/, 'must not abort the logout');
});

test('RP-109 §19: the outcome is recorded only through the privacy-typed trace', () => {
  assert.match(signOutBody, /traceAuthLifecycle\('signout-push-revocation', \{ outcome: pushRevocation \}\)/);
  // The trace's detail type declares no FIELD able to carry a token, an email,
  // a device id or a backend body, and no second analytics surface was
  // introduced for this. (`callbackKind?: 'code' | 'tokens' | ...` is a closed
  // set of status words, not a carrier, so field NAMES are what is checked.)
  const trace = fs.readFileSync(path.join(ROOT, 'services/authLifecycleTrace.ts'), 'utf8');
  const details = trace.slice(trace.indexOf('type AuthLifecycleDetails'), trace.indexOf('};'));
  const fields = [...details.matchAll(/^\s{2}(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(fields.includes('outcome'), 'outcome is the field the reason code uses');
  for (const forbidden of [
    'token',
    'accessToken',
    'refreshToken',
    'pushToken',
    'email',
    'deviceId',
    'userId',
    'body',
    'error',
  ]) {
    assert.ok(!fields.includes(forbidden), `trace must have no "${forbidden}" field`);
  }
  // And `outcome` is a plain status string, never a rendered error.
  assert.match(details, /outcome\?: string;/);
});

test('RP-109 §20: the revocation result mutates no actor-bound state', () => {
  const code = signOutBody.replace(/\/\/.*$/gm, '');
  // Every line that READS the outcome. `setSession(null)` and the actor reset
  // also live after the revocation, but they are the logout itself and run
  // unconditionally -- they are not consumers of this result.
  const consumers = code
    .split('\n')
    .filter((line) => line.includes('pushRevocation') && !line.includes('const pushRevocation'));

  assert.ok(consumers.length > 0, 'the outcome must be captured, not discarded');
  // The only consumers are the guard and the privacy-typed trace, so a
  // completion that lands after the next actor signed in is structurally
  // incapable of registering, claiming, or re-enabling anything for them.
  for (const line of consumers) {
    assert.ok(
      /pushRevocation !== '(revoked|not_registered)'/.test(line) ||
        /traceAuthLifecycle\(/.test(line),
      `unexpected consumer of the revocation outcome: ${line.trim()}`,
    );
  }
  for (const forbidden of [
    'claimDeviceForCurrentActor',
    'enableDeviceNotifications',
    'register_push_token',
    'setPreference',
  ]) {
    assert.ok(
      !consumers.some((line) => line.includes(forbidden)),
      `must not reach "${forbidden}" on the outcome`,
    );
  }
});

test('RP-109 §20: sign-in claims the device; the departing revocation never does', () => {
  const clock = createClock();
  const { mod, invocations } = loadPushRegistration({
    storage: memoryStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    clock,
  });
  return mod.revokeWatchAlertsForThisDevice().then(() => {
    assert.deepEqual(invocations.map((c) => c.body.action), ['revoke_push_token']);
    assert.ok(
      !invocations.some((c) => c.body.action === 'claim_device'),
      "the departing actor must not claim the device the next actor will own",
    );
  });
});
