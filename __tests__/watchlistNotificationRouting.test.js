// K+ Smart Watchlist V1 — notification tap routing.
//
// Proving tests for hostile-audit repair DEF-WL-03: pushDelivery.ts sends
// `data: { watchId, eventType, deepLink }` and documents that tapping the
// alert opens /watchlist/[watchId], but nothing in the app read that payload
// — there was no notification-response listener and no notification handler
// anywhere in source, so a tapped alert landed on the app's default route.
//
// The routing module is loaded and EXECUTED here (VM-transpile with an
// injected requireMap, the same technique as kplusEntitlementStore.test.js),
// not asserted against as source text: the point of these cases is what the
// function actually returns for a hostile payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const MODULE_PATH = path.join(ROOT, 'services', 'watchlist', 'watchNotificationRouting.ts');

function loadRouting() {
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      throw new Error(`Unexpected import in watchNotificationRouting.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: MODULE_PATH }).runInContext(sandbox);
  return mod.exports;
}

const VALID_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('a Watchlist payload resolves to that Watch detail route', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  assert.equal(
    watchRouteFromNotificationData({ watchId: VALID_ID, eventType: 'target_price_reached' }),
    `/watchlist/${VALID_ID}`,
  );
});

test('SECURITY: the URL-shaped payload field is never used as the destination', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  // A push payload is untrusted input. Even a payload carrying a plausible
  // deepLink must contribute nothing to the route.
  assert.equal(
    watchRouteFromNotificationData({ deepLink: 'https://attacker.example/steal' }),
    null,
  );
  assert.equal(
    watchRouteFromNotificationData({ watchId: VALID_ID, deepLink: 'https://attacker.example/steal' }),
    `/watchlist/${VALID_ID}`,
  );
});

test('SECURITY: a non-UUID watch id never becomes a route', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  for (const hostile of [
    '../../settings',
    'https://attacker.example',
    `${VALID_ID}/../../privacy`,
    `${VALID_ID}%2F..%2Fprivacy`,
    'kscan://watchlist/x',
    '',
    '   ',
    `${VALID_ID}extra`,
    123,
    null,
    { toString: () => VALID_ID },
  ]) {
    assert.equal(
      watchRouteFromNotificationData({ watchId: hostile }),
      null,
      `hostile watchId must not route: ${JSON.stringify(hostile)}`,
    );
  }
});

test('a non-Watchlist or malformed payload routes nowhere', () => {
  const { watchRouteFromNotificationData } = loadRouting();
  for (const payload of [null, undefined, 'string', 42, [], {}, { eventType: 'target_price_reached' }]) {
    assert.equal(watchRouteFromNotificationData(payload), null);
  }
});

test("a well-formed id belonging to another actor still only yields that actor's own route shape", () => {
  const { watchRouteFromNotificationData } = loadRouting();
  // Ownership is resolved by the destination screen's RLS-scoped read, never
  // here. What this asserts is that the payload cannot widen the route into
  // anything but the ordinary watch detail path.
  const other = '99999999-8888-7777-6666-555555555555';
  assert.equal(watchRouteFromNotificationData({ watchId: other }), `/watchlist/${other}`);
});

test('WIRING: the routing installer is mounted at the app root', () => {
  // The pure function above is useless if nothing installs the listener —
  // exactly the failure this repair closes.
  const layout = fs.readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
  assert.match(layout, /installWatchNotificationRouting/);
  assert.match(
    layout,
    /from '\.\.\/services\/watchlist\/watchNotificationRouting'/,
    'the root layout must import the routing installer',
  );
});

test('WIRING: the push payload still carries the id this router consumes', () => {
  const delivery = fs.readFileSync(
    path.join(ROOT, 'supabase', 'functions', 'commerce-watch-refresh', 'pushDelivery.ts'),
    'utf8',
  );
  assert.match(delivery, /data:\s*\{\s*watchId:/, 'the sender must keep emitting watchId');
});

// ════════════════════════════════════════════════════════════════════════════
// N-2 / N-3 — the launch-response lifecycle, executed
//
// N-2: a cold-start tap resolves through getLastNotificationResponseAsync()
// within the first frames of startup, before <Stack> has mounted. The old code
// called navigate() straight away, so expo-router dropped the push and the
// tapped alert was lost.
//
// N-3: the OS keeps returning that same launch response until it is cleared,
// so any re-installation of the handler in the same app lifetime read it again
// and navigated again.
//
// Everything below runs the REAL installWatchNotificationRouting against a
// recording expo-notifications double. A fresh module instance per harness is
// what makes the module-scoped launch state honest: each test gets its own app
// launch, and the reinstall cases deliberately reuse ONE instance because
// re-installation is the defect under test.
// ════════════════════════════════════════════════════════════════════════════

const OTHER_ID = '99999999-8888-7777-6666-555555555555';

/** Lets every pending promise inside the sandbox settle. */
const flush = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

function loadLifecycle({
  launchResponse = null,
  getLastThrows = false,
  clearThrows = false,
  omitSyncClear = false,
} = {}) {
  const calls = {
    navigations: [],
    getLast: 0,
    clearedSync: 0,
    clearedAsync: 0,
    listenersAdded: 0,
    listenersRemoved: 0,
    handlersSet: 0,
  };

  // The OS-held "last response". Clearing it here is what a real clear does,
  // which is precisely what makes the replay cases meaningful.
  let osLastResponse = launchResponse;
  let responseListener = null;

  const Notifications = {
    setNotificationHandler: () => {
      calls.handlersSet += 1;
    },
    getLastNotificationResponseAsync: async () => {
      calls.getLast += 1;
      if (getLastThrows) throw new Error('no launch response on this platform');
      return osLastResponse;
    },
    clearLastNotificationResponseAsync: async () => {
      calls.clearedAsync += 1;
      osLastResponse = null;
    },
    addNotificationResponseReceivedListener: (callback) => {
      calls.listenersAdded += 1;
      responseListener = callback;
      return {
        remove: () => {
          calls.listenersRemoved += 1;
          responseListener = null;
        },
      };
    },
  };
  if (!omitSyncClear) {
    Notifications.clearLastNotificationResponse = () => {
      calls.clearedSync += 1;
      if (clearThrows) throw new Error('clear unavailable');
      osLastResponse = null;
    };
  }

  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier === 'expo-notifications') return Notifications;
      throw new Error(`Unexpected import in watchNotificationRouting.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: MODULE_PATH }).runInContext(sandbox);

  return {
    calls,
    /** Installs a handle exactly as app/_layout.tsx does. */
    install: () => mod.exports.installWatchNotificationRouting((route) => calls.navigations.push(route)),
    /** Delivers a warm/background tap through the live listener. */
    deliver: (data) => {
      assert.ok(responseListener, 'a response listener must be installed');
      responseListener({ notification: { request: { content: { data } } } });
    },
    /** True while the OS would still hand the launch response back. */
    osStillHolds: () => osLastResponse !== null,
    /** Simulates the OS delivering a NEW launch response (not used by warm taps). */
    setOsLaunchResponse: (value) => {
      osLastResponse = value;
    },
  };
}

const launchResponseFor = (watchId) => ({
  notification: { request: { content: { data: { watchId } } } },
});

// ── cold-start readiness (N-2) ──────────────────────────────────────────────

test('COLD START: a valid launch response with the router already ready navigates once', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`]);
});

test('COLD START (the defect): a valid launch response does NOT navigate before the router is ready', async () => {
  // The whole of N-2. Before the repair this navigated immediately, into a
  // navigator that did not exist yet, and the tap was silently dropped.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  h.install();
  await flush();
  assert.deepEqual(h.calls.navigations, [], 'no navigation may be attempted before readiness');
});

test('COLD START: the retained response navigates exactly once when the router becomes ready', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  await flush();
  assert.deepEqual(h.calls.navigations, []);
  handle.notifyNavigationReady();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`], 'the response was retained, not lost');
});

test('COLD START: repeated readiness transitions cannot navigate the same response twice', async () => {
  // app/_layout.tsx fires readiness on every navigation state change, so this
  // is the ordinary case, not an exotic one.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  await flush();
  for (let i = 0; i < 5; i += 1) handle.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1, 'the pending slot is emptied before navigating');
});

test('COLD START: no arbitrary timer is used to reach readiness', () => {
  // §4: the repair must be a deterministic readiness signal, never a delay.
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const timer of ['setTimeout', 'setInterval', 'requestAnimationFrame', 'InteractionManager']) {
    assert.ok(!executable.includes(timer), `routing must not depend on ${timer}`);
  }
});

// ── launch-response clearing (N-3) ──────────────────────────────────────────

test('CLEARING: a consumed launch response is cleared through the expo API', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.clearedSync, 1, 'the current (non-deprecated) clear is used');
  assert.equal(h.osStillHolds(), false, 'the OS must no longer hand this response back');
});

test('CLEARING: the deprecated async spelling is used when the current one is absent', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID), omitSyncClear: true });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.clearedAsync, 1, 'an SDK shipping only the old name must still clear');
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`], 'and routing is unaffected');
});

test('CLEARING: a launch response that is not a Watchlist one is discarded, never navigated', async () => {
  const h = loadLifecycle({
    launchResponse: { notification: { request: { content: { data: { eventType: 'other' } } } } },
  });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  assert.deepEqual(h.calls.navigations, [], 'an invalid payload routes nowhere');
  assert.equal(h.calls.clearedSync, 1, 'and is still consumed so it cannot be re-read');
});

test('CLEARING: clearing never costs a valid pending route', async () => {
  // §8's bad sequence — clear before the router is ready, then lose the route.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  await flush();
  assert.equal(h.calls.clearedSync, 1, 'the OS response is cleared while still not ready');
  assert.equal(h.osStillHolds(), false);
  handle.notifyNavigationReady();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`], 'the route survived the clear');
});

test('CLEARING: reinstalling the handler after a consumed launch does not replay it', async () => {
  // N-3 exactly: one app launch, the effect re-runs (Fast Refresh, a StrictMode
  // double mount, a root remount), and the same tap must not navigate twice.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const first = h.install();
  first.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1);

  first.remove();
  const second = h.install();
  second.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1, 'the launch response must not be routed a second time');
});

test('CLEARING: a re-read is refused even if the OS still holds the response', async () => {
  // The consumed flag is an authority independent of the clear succeeding, so
  // a platform that cannot clear still cannot replay.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const first = h.install();
  first.notifyNavigationReady();
  await flush();
  first.remove();

  h.setOsLaunchResponse(launchResponseFor(VALID_ID)); // the clear "failed"
  const second = h.install();
  second.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1);
  assert.equal(h.calls.getLast, 1, 'the launch response is not even read a second time');
});

test('CLEARING: a clear that throws neither crashes nor loops', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID), clearThrows: true });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`], 'routing still completes');

  handle.remove();
  const second = h.install();
  second.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1, 'and a failed clear cannot become a navigation loop');
});

test('CLEARING: an unsupported getLastNotificationResponseAsync is survivable', async () => {
  const h = loadLifecycle({ getLastThrows: true });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  assert.deepEqual(h.calls.navigations, []);
  assert.equal(h.calls.listenersAdded, 1, 'the warm listener is still installed');
});

// ── warm / background responses ─────────────────────────────────────────────

test('WARM: a tap while the app is running navigates once', async () => {
  const h = loadLifecycle();
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  h.deliver({ watchId: VALID_ID });
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`]);
});

test('WARM: a background-mounted tap navigates once and is consumed', async () => {
  const h = loadLifecycle();
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  h.deliver({ watchId: VALID_ID });
  assert.equal(h.calls.navigations.length, 1);
  // Consumed too: a later remount must not re-read this as a launch response.
  handle.remove();
  const second = h.install();
  second.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1, 'a handled warm tap must not replay as a launch');
});

test('WARM: two distinct legitimate taps stay distinguishable', async () => {
  const h = loadLifecycle();
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  h.deliver({ watchId: VALID_ID });
  h.deliver({ watchId: OTHER_ID });
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`, `/watchlist/${OTHER_ID}`]);
});

test('WARM: a malformed tap navigates nowhere', async () => {
  const h = loadLifecycle();
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  for (const hostile of [
    { watchId: '../../settings' },
    { deepLink: 'https://attacker.example/steal' },
    { eventType: 'target_price_reached' },
    {},
    null,
  ]) {
    h.deliver(hostile);
  }
  assert.deepEqual(h.calls.navigations, [], 'no invalid payload may produce a route');
});

// ── the hostile races (§16) ─────────────────────────────────────────────────

test('RACE A: launch response and readiness landing together navigate exactly once', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  // Readiness interleaved with the in-flight async read, then again after it.
  handle.notifyNavigationReady();
  handle.notifyNavigationReady();
  await flush();
  handle.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1);
});

test('RACE B: a double install consumes the launch response once and keeps one listener', async () => {
  // StrictMode-shaped: install, tear down, install again, all before readiness.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const first = h.install();
  await flush();
  first.remove();
  const second = h.install();
  await flush();

  assert.equal(h.calls.getLast, 1, 'the launch response is read once');
  assert.equal(h.calls.listenersRemoved, 1, 'the first listener was cleaned up');
  assert.equal(h.calls.listenersAdded, 2);

  second.notifyNavigationReady();
  assert.deepEqual(
    h.calls.navigations,
    [`/watchlist/${VALID_ID}`],
    'a response read by the torn-down install is delivered through the live one, exactly once',
  );
});

test('RACE C: a response cleared before readiness still navigates when readiness arrives', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  await flush();
  assert.equal(h.osStillHolds(), false, 'already cleared');
  assert.deepEqual(h.calls.navigations, []);
  handle.notifyNavigationReady();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`]);
});

test('RACE D: readiness before the response resolves navigates immediately, once', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  handle.notifyNavigationReady(); // ready first, response still in flight
  await flush();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`]);
});

test('RACE E: a warm tap arriving while a cold route is pending yields one navigation, newest first', async () => {
  // Deterministic rule: the newest tap is the one the user actually asked for,
  // so it replaces the still-unrouted cold-start route. Neither is dropped
  // silently — exactly one navigation happens, to the newer destination.
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  await flush();
  assert.deepEqual(h.calls.navigations, [], 'cold route still pending');
  h.deliver({ watchId: OTHER_ID });
  assert.deepEqual(h.calls.navigations, [], 'still not ready, so still nothing navigates');
  handle.notifyNavigationReady();
  assert.deepEqual(h.calls.navigations, [`/watchlist/${OTHER_ID}`], 'exactly one navigation, the newer tap');
});

// ── lifecycle ───────────────────────────────────────────────────────────────

test('LIFECYCLE: a foreground return does not replay a consumed launch response', async () => {
  const h = loadLifecycle({ launchResponse: launchResponseFor(VALID_ID) });
  const handle = h.install();
  handle.notifyNavigationReady();
  await flush();
  // A background/foreground cycle re-fires readiness; nothing may replay.
  handle.notifyNavigationReady();
  await flush();
  assert.equal(h.calls.navigations.length, 1);
});

test('LIFECYCLE: listener cleanup leaves no duplicate subscription behind', async () => {
  const h = loadLifecycle();
  const first = h.install();
  await flush();
  first.remove();
  const second = h.install();
  await flush();
  assert.equal(h.calls.listenersAdded, 2);
  assert.equal(h.calls.listenersRemoved, 1);
  second.notifyNavigationReady();
  h.deliver({ watchId: VALID_ID });
  assert.deepEqual(h.calls.navigations, [`/watchlist/${VALID_ID}`], 'exactly one live listener routes');
});

// ── the root-layout wiring ──────────────────────────────────────────────────

test('CONTAINMENT: the launch lifecycle is in-memory only and reports nothing', () => {
  // §17: retaining a pending route must not create a new data-retention
  // surface — no storage, no backend, and no notification identifier kept.
  // §18: notification observability belongs to N-5, not here; a payload,
  // watch id or user id must never reach a telemetry sink from this module.
  const source = fs.readFileSync(MODULE_PATH, 'utf8');
  const executable = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  for (const forbidden of [
    'AsyncStorage', 'SecureStore', 'localStorage', 'supabase',
    'PostHog', 'posthog', 'Sentry', 'captureEvent', 'analytics', 'console.',
  ]) {
    assert.ok(!executable.includes(forbidden), `the routing lifecycle must not reach "${forbidden}"`);
  }
});

test('WIRING: the root layout drives readiness from the navigator, not from a timer', () => {
  const layout = fs.readFileSync(path.join(ROOT, 'app', '_layout.tsx'), 'utf8');
  const start = layout.indexOf('export default function Layout()');
  assert.ok(start >= 0, 'the root Layout component must be locatable');
  const body = layout.slice(start);

  assert.match(body, /notifyNavigationReady\(\)/, 'the layout must report readiness to the router module');
  assert.match(
    body,
    /navigationRef\.addListener\('state'/,
    "readiness must come from the navigator's own state signal",
  );
  assert.match(body, /navigationRef\.isReady\(\)/, 'and from a synchronous already-ready check');
  for (const timer of ['setTimeout', 'setInterval']) {
    assert.ok(
      !body.includes(timer),
      `the notification-routing readiness path must not use ${timer}`,
    );
  }
});
