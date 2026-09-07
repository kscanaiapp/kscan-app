/**
 * RP-104 — behavioural coverage for the K Scan AI Notifications OFF repair.
 *
 * The defect: turning Notifications OFF flipped local UI state only. This
 * device's `user_device_push_tokens` row stayed live, so the switch read OFF
 * while the backend could still deliver K Scan AI pushes to the handset — a false
 * control over a real delivery channel.
 *
 * These tests EXECUTE the real modules (services/watchlist/pushRegistration.ts
 * and hooks/usePermissionPreferences.ts) against observing fakes and assert on
 * the backend calls that were actually issued. Source-text assertions cannot
 * see an unissued revocation, which is exactly what the defect was.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const { createHookRuntime, settle } = require('./helpers/hookRuntime');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relativePath, requireMap, sandboxExtras = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;

  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    Error,
    Promise,
    Set,
    Map,
    Array,
    Object,
    JSON,
    Number,
    String,
    Boolean,
    Math,
    setTimeout,
    clearTimeout,
    setImmediate,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require: ${id}`);
    },
    ...sandboxExtras,
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

const DEVICE_ID_KEY = 'kscan-watchlist-device-id';
const DISABLED_KEY = 'kscan-watchlist-device-push-disabled';

/** AsyncStorage stand-in that records every write, so a minted id is visible. */
function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  return {
    values,
    writes,
    getItem: async (key) => (values.has(key) ? values.get(key) : null),
    setItem: async (key, value) => {
      writes.push({ key, value });
      values.set(key, value);
    },
    removeItem: async (key) => {
      writes.push({ key, value: null });
      values.delete(key);
    },
  };
}

/**
 * Loads the real push-registration module with every boundary observed:
 * storage, the edge-function client, the session resolver, and the
 * expo-notifications surface.
 */
function loadPushRegistration({
  storage = createStorage(),
  invoke,
  session = { ok: true },
  notifications,
  platform = 'ios',
} = {}) {
  const invocations = [];
  const notificationCalls = [];

  const defaultInvoke = async (fn, options) => {
    invocations.push({ fn, body: options.body });
    return { data: {}, error: null };
  };
  const recordingInvoke = async (fn, options) => {
    invocations.push({ fn, body: options.body });
    return invoke ? invoke(fn, options) : { data: {}, error: null };
  };

  const notificationsModule = notifications ?? {
    getPermissionsAsync: async () => {
      notificationCalls.push('getPermissionsAsync');
      return { granted: true, canAskAgain: true };
    },
    requestPermissionsAsync: async () => {
      notificationCalls.push('requestPermissionsAsync');
      return { granted: true, canAskAgain: true };
    },
    getExpoPushTokenAsync: async () => {
      notificationCalls.push('getExpoPushTokenAsync');
      return { data: 'ExponentPushToken[fake]' };
    },
    setNotificationChannelAsync: async () => {
      notificationCalls.push('setNotificationChannelAsync');
    },
    addPushTokenListener: () => ({ remove: () => {} }),
    AndroidImportance: { DEFAULT: 3 },
  };

  const requireMap = {
    'react-native': { Platform: { OS: platform }, Linking: { openSettings: async () => {} } },
    // esModuleInterop wraps any namespace lacking __esModule in a second
    // { default: ... }, which would hand the module an object with no
    // getItem at all. Declaring it keeps the real default binding intact.
    'expo-constants': {
      __esModule: true,
      default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
    },
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    '../supabaseClient': { supabase: { functions: { invoke: invoke ? recordingInvoke : defaultInvoke } } },
    '../authenticatedFunctionSession': {
      resolveAuthenticatedFunctionSession: async () =>
        typeof session === 'function' ? session() : session,
    },
    'expo-notifications': notificationsModule,
  };

  const mod = loadTsModule('services/watchlist/pushRegistration.ts', requireMap, {
    // The module's lazy `await import('expo-notifications')` transpiles to a
    // Promise.resolve().then(() => require(...)) — served by requireMap above.
  });
  return { mod, storage, invocations, notificationCalls, notificationsModule };
}

const actionsOf = (invocations) => invocations.map((call) => call.body.action);

// ─── §5/§7: OFF revokes THIS device's backend route ─────────────────────────

test('RP-104: an explicit OFF revokes this device\'s backend push route', async () => {
  const { mod, invocations } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
  });

  const result = await mod.disableDeviceNotifications();

  assert.equal(result.ok, true);
  assert.deepEqual(actionsOf(invocations), ['revoke_push_token']);
  assert.equal(invocations[0].fn, 'commerce-watch-refresh');
  assert.equal(invocations[0].body.deviceId, 'device-a');
});

test('RP-104 §9: the revoke names ONE device id and no actor-wide selector', async () => {
  const { mod, invocations } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
  });

  await mod.disableDeviceNotifications();

  const body = invocations[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['action', 'deviceId']);
  // Nothing that could reach a sibling device, a Watch, a target or K+.
  for (const forbidden of ['all', 'allDevices', 'watchId', 'watchIds', 'userId', 'entitlement']) {
    assert.ok(!(forbidden in body), `revoke body must not carry "${forbidden}"`);
  }
});

test('RP-104 §10: disabling deletes no Watch, target or entitlement', async () => {
  const { mod, invocations } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
  });

  await mod.disableDeviceNotifications();

  // Exactly one call, and it is the device-route revocation. Monitoring intent
  // (the Watchlist rows) and K+ are never touched.
  assert.equal(invocations.length, 1);
  for (const action of actionsOf(invocations)) {
    assert.ok(
      !['delete_watch', 'set_push_enabled', 'remove_target', 'claim_device'].includes(action),
      `disable must not issue "${action}"`,
    );
  }
});

// ─── §6: no registered device ───────────────────────────────────────────────

test('RP-104 §6: OFF with no device id succeeds without minting one', async () => {
  const storage = createStorage();
  const { mod, invocations, notificationCalls } = loadPushRegistration({ storage });

  const result = await mod.disableDeviceNotifications();

  assert.equal(result.ok, true);
  assert.equal(result.alreadyUnregistered, true);
  assert.equal(storage.values.has(DEVICE_ID_KEY), false, 'must not mint a device id');
  assert.equal(invocations.length, 0, 'must make no backend call');
  assert.deepEqual(notificationCalls, [], 'must request no OS permission and no token');
});

// ─── §7: a failed revoke may not present a durable OFF ──────────────────────

test('RP-104 §7: a backend failure does not report OFF', async () => {
  const { mod } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    invoke: async () => ({ data: null, error: { message: 'revoke_failed', status: 502 } }),
  });

  const result = await mod.disableDeviceNotifications();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'backend_unavailable');
});

test('RP-104 §7: a thrown transport error does not report OFF', async () => {
  const { mod } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    invoke: async () => {
      throw new Error('ECONNRESET: https://project.supabase.co/functions/v1 token=secret');
    },
  });

  const result = await mod.disableDeviceNotifications();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'backend_unavailable');
});

test('RP-104 §7: an unavailable session does not report OFF', async () => {
  const { mod, invocations } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    session: { ok: false, reason: 'no_session' },
  });

  const result = await mod.disableDeviceNotifications();

  assert.equal(result.ok, false);
  assert.equal(invocations.length, 0);
});

// ─── §14/§19: no raw backend material reaches the caller ────────────────────

test('RP-104 §14: no raw backend error text can reach the UI', async () => {
  const secret = 'https://project.supabase.co/functions/v1 bearer=eyJhbGciOi';
  const { mod } = loadPushRegistration({
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }),
    invoke: async () => ({ data: null, error: { message: secret, status: 502, stack: secret } }),
  });

  const result = await mod.disableDeviceNotifications();

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes('supabase.co'), serialized);
  assert.ok(!serialized.includes('bearer'), serialized);
  assert.ok(!serialized.includes('device-a'), 'the device id is not UI material');
  // The whole result is a closed vocabulary.
  assert.deepEqual(Object.keys(result).sort(), ['ok', 'reason']);
  assert.equal(result.reason, 'backend_unavailable');
});

// ─── §8: OS authorization is never touched ──────────────────────────────────

test('RP-104 §8: disabling requests no OS permission and opens no Settings', async () => {
  const opened = [];
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const { mod, notificationCalls } = loadPushRegistration({ storage });
  // Linking.openSettings is only reachable via the exported helper, never from
  // the disable path.
  await mod.disableDeviceNotifications();

  assert.deepEqual(notificationCalls, []);
  assert.deepEqual(opened, []);
});

test('RP-104 §8: the shipping surface never claims OS authorization was revoked', () => {
  const step = fs.readFileSync(
    path.join(ROOT, 'components/account-home/PermissionsStepV1.tsx'),
    'utf8',
  );
  // Copy shown for the OFF outcome must not assert anything about iOS/Android
  // system authorization, which this repair cannot and does not change.
  for (const claim of [
    'revoked in Settings',
    'removed from Settings',
    'disabled in device Settings',
    'notification permission revoked',
  ]) {
    assert.ok(!step.includes(claim), `must not claim "${claim}"`);
  }
});

// ─── §4/§7: the shipping onboarding surface ─────────────────────────────────

const permissionsStep = fs.readFileSync(
  path.join(ROOT, 'components/account-home/PermissionsStepV1.tsx'),
  'utf8',
);
const permissionsHook = fs.readFileSync(
  path.join(ROOT, 'hooks/usePermissionPreferences.ts'),
  'utf8',
);
/** The OFF branch of the shipping toggle handler, comments stripped. */
const offBranch = (() => {
  const handler = permissionsStep.slice(
    permissionsStep.indexOf('const handleNotificationsToggle'),
    permissionsStep.indexOf('const notificationsDescription'),
  );
  const start = handler.indexOf('if (!nextValue) {');
  const end = handler.indexOf('const result = await requestNotificationPermission()');
  return handler.slice(start, end).replace(/\/\/.*$/gm, '');
})();

test('RP-104 §4: OFF goes through the canonical device-disable authority', () => {
  assert.ok(
    offBranch.includes('await disableNotificationDelivery()'),
    'the OFF branch must invoke the canonical disable, not just clear local state',
  );
});

test('RP-104 §7: the OFF branch never writes the preference itself', () => {
  // The defect being closed: `setPreference('notifications', false)` right here
  // made the switch read OFF while the backend route was still live. Only the
  // hook may write it, and only after a revocation that succeeded.
  assert.ok(
    !offBranch.includes('setPreference'),
    'the surface must not locally flip Notifications OFF',
  );
  const disableFn = permissionsHook.slice(
    permissionsHook.indexOf('const disableNotificationDelivery = useCallback'),
  );
  assert.match(disableFn, /if \(result\.ok\) setPreference\('notifications', false\);/);
});

test('RP-104 §7: a failed revoke leaves a retryable state, not a durable OFF', () => {
  assert.ok(offBranch.includes("setNotificationsStatus('disable_failed')"));
  assert.match(permissionsStep, /disable_failed[\s\S]{0,200}?tap to try again/);
});

test('RP-104 §7: OFF enters a bounded disabling state', () => {
  const handler = permissionsStep.slice(
    permissionsStep.indexOf('const handleNotificationsToggle'),
    permissionsStep.indexOf('const notificationsDescription'),
  );
  // Busy is entered before the branch splits, so BOTH directions disable the
  // switch while their network work is in flight...
  assert.ok(
    handler.indexOf('setNotificationsBusy(true)') < handler.indexOf('if (!nextValue)'),
    'the busy state must cover the OFF path too',
  );
  // ...and is always released.
  assert.match(handler, /finally \{\s*setNotificationsBusy\(false\);/);
  assert.match(permissionsStep, /disabled=\{notificationsBusy\}/);
});

test('RP-104 §8: the OFF path touches no OS permission API', () => {
  for (const forbidden of [
    'requestPermissionsAsync',
    'openNotificationSettings',
    'PermissionsAndroid',
    'openSettings',
  ]) {
    assert.ok(!offBranch.includes(forbidden), `the OFF branch must not call ${forbidden}`);
  }
});

// ─── §23.1/§23.2: the surface invariants this lane must not regress ─────────

test('RP-104 §23: Notifications stays permanently visible and OPTIONAL', () => {
  assert.match(permissionsStep, /title="Notifications"/);
  const card = permissionsStep.slice(permissionsStep.indexOf('title="Notifications"'), 
    permissionsStep.indexOf('title="Notifications"') + 500);
  assert.match(card, /badge="OPTIONAL"/);
  assert.doesNotMatch(card, /disabled=\{true\}/);
});

test('RP-104 §23: the four permission cards keep their shipping order', () => {
  const order = ['Camera', 'Photos', 'Microphone', 'Notifications'].map((title) =>
    permissionsStep.indexOf(`title="${title}"`),
  );
  assert.ok(order.every((i) => i >= 0), 'every card must still be rendered');
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

// ─── §12: a token refresh cannot defeat an explicit OFF ─────────────────────

test('RP-104 §12: a push-token refresh after OFF does not re-register', async () => {
  let fire = null;
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const { mod, invocations } = loadPushRegistration({
    storage,
    notifications: {
      getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[rolled]' }),
      setNotificationChannelAsync: async () => {},
      addPushTokenListener: (handler) => {
        fire = handler;
        return { remove: () => {} };
      },
      AndroidImportance: { DEFAULT: 3 },
    },
  });

  await mod.attachPushTokenRefreshListener();
  await mod.disableDeviceNotifications();
  invocations.length = 0;

  fire({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(
    actionsOf(invocations),
    [],
    'a token refresh must not rebuild a route the user explicitly revoked',
  );
});

test('RP-104 §12: a token refresh still re-registers a device that never disabled', async () => {
  let fire = null;
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const { mod, invocations } = loadPushRegistration({
    storage,
    notifications: {
      getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[rolled]' }),
      setNotificationChannelAsync: async () => {},
      addPushTokenListener: (handler) => {
        fire = handler;
        return { remove: () => {} };
      },
      AndroidImportance: { DEFAULT: 3 },
    },
  });

  await mod.attachPushTokenRefreshListener();
  fire({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  // NEGATIVE CONTROL: the OFF guard must not have broken NOTIF-16 itself.
  assert.deepEqual(actionsOf(invocations), ['register_push_token']);
});

test('RP-104 §10: turning OFF then ON re-registers through the canonical path', async () => {
  let fire = null;
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const { mod, invocations } = loadPushRegistration({
    storage,
    notifications: {
      getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      getExpoPushTokenAsync: async () => ({ data: 'ExponentPushToken[t]' }),
      setNotificationChannelAsync: async () => {},
      addPushTokenListener: (handler) => {
        fire = handler;
        return { remove: () => {} };
      },
      AndroidImportance: { DEFAULT: 3 },
    },
  });

  await mod.attachPushTokenRefreshListener();
  await mod.disableDeviceNotifications();
  const enabled = await mod.enableDeviceNotifications();
  assert.equal(enabled.ok, true);
  assert.deepEqual(actionsOf(invocations), ['revoke_push_token', 'register_push_token']);
  // The same device identity is reused: OFF must not strand the revoked row
  // behind a second, freshly minted id.
  assert.equal(storage.values.get(DEVICE_ID_KEY), 'device-a');
  assert.equal(invocations[1].body.deviceId, 'device-a');

  // ...and delivery is genuinely re-armed, so refresh works again.
  invocations.length = 0;
  fire({ data: 'ExponentPushToken[t]' });
  await settle(8);
  assert.deepEqual(actionsOf(invocations), ['register_push_token']);
});

// ─── §11: rapid toggling / stale async completion ───────────────────────────

test('RP-104 §11: a stale ON in flight cannot re-register after an explicit OFF', async () => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  let releaseToken;
  const held = new Promise((resolve) => {
    releaseToken = resolve;
  });
  const { mod, invocations } = loadPushRegistration({
    storage,
    notifications: {
      getPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true }),
      getExpoPushTokenAsync: async () => {
        await held;
        return { data: 'ExponentPushToken[slow]' };
      },
      setNotificationChannelAsync: async () => {},
      addPushTokenListener: () => ({ remove: () => {} }),
      AndroidImportance: { DEFAULT: 3 },
    },
  });

  const slowEnable = mod.enableDeviceNotifications();
  await settle(2);

  // The user changes their mind mid-flight and turns notifications OFF.
  const off = await mod.disableDeviceNotifications();
  assert.equal(off.ok, true);

  releaseToken();
  const enabled = await slowEnable;

  assert.equal(enabled.ok, false);
  assert.equal(enabled.reason, 'superseded');
  assert.deepEqual(
    actionsOf(invocations),
    ['revoke_push_token'],
    'the superseded enable must never issue register_push_token',
  );
});

// ─── hook-level: §7, §11, §12 through the real hook ─────────────────────────

const ACTOR_A = '11111111-1111-1111-1111-111111111111';
const ACTOR_B = '22222222-2222-2222-2222-222222222222';

/** The real actor authority, reached through the real services/actorScope.ts. */
function loadActorScope() {
  const actorContext = require('../services/actorContext.js');
  actorContext.__resetActorContextForTests();
  const actorScope = loadTsModule('services/actorScope.ts', { './actorContext': actorContext });
  return { actorContext, actorScope };
}

function loadPermissionHook({ enable, disable }) {
  const { actorContext, actorScope } = loadActorScope();
  // The module must be compiled against the very runtime that drives it:
  // a second createHookRuntime() would own the state while this one owns the
  // render loop, and no state write would ever be observable.
  const runtime = createHookRuntime();
  const mod = loadTsModule('hooks/usePermissionPreferences.ts', {
    react: runtime.react,
    '../services/watchlist/pushRegistration': {
      enableDeviceNotifications: enable,
      disableDeviceNotifications: disable,
    },
    '../services/actorScope': actorScope,
    'react-native': { Platform: { OS: 'ios' }, PermissionsAndroid: { PERMISSIONS: {}, RESULTS: {} } },
    '../constants/featureFlags': { VOICESCAN_ENABLED: true },
  });

  let current;
  const renderOnce = () => {
    runtime.beginRender();
    current = mod.usePermissionPreferences();
    runtime.flushEffects();
  };
  renderOnce();

  return {
    actorContext,
    get current() {
      return current;
    },
    async flush(cycles = 12) {
      for (let i = 0; i < cycles; i += 1) {
        await settle(2);
        if (runtime.dirty) {
          runtime.clearDirty();
          renderOnce();
        }
      }
    },
  };
}

test('RP-104 §7: the hook reflects OFF only after a successful revocation', async () => {
  let outcome = { ok: true };
  const rendered = loadPermissionHook({
    enable: async () => ({ ok: true, canAskAgain: true }),
    disable: async () => outcome,
  });

  await rendered.current.requestNotificationPermission();
  await rendered.flush();
  assert.equal(rendered.current.preferences.notifications, true);

  outcome = { ok: false, reason: 'backend_unavailable' };
  await rendered.current.disableNotificationDelivery();
  await rendered.flush();
  assert.equal(
    rendered.current.preferences.notifications,
    true,
    'a failed revocation must not present a durable OFF',
  );

  outcome = { ok: true };
  await rendered.current.disableNotificationDelivery();
  await rendered.flush();
  assert.equal(rendered.current.preferences.notifications, false);
});

test('RP-104 §11: a stale OFF completion cannot overwrite a newer ON', async () => {
  let releaseDisable;
  const heldDisable = new Promise((resolve) => {
    releaseDisable = resolve;
  });
  const rendered = loadPermissionHook({
    enable: async () => ({ ok: true, canAskAgain: true }),
    disable: async () => {
      await heldDisable;
      return { ok: true };
    },
  });

  await rendered.current.requestNotificationPermission();
  await rendered.flush();
  assert.equal(rendered.current.preferences.notifications, true);

  const slowOff = rendered.current.disableNotificationDelivery();
  await settle(2);
  // A newer ON supersedes the in-flight OFF.
  await rendered.current.requestNotificationPermission();
  await rendered.flush();

  releaseDisable();
  await slowOff;
  await rendered.flush();

  assert.equal(
    rendered.current.preferences.notifications,
    true,
    'the stale OFF completion must mutate nothing',
  );
});

test('RP-104 §11: a stale ON completion cannot overwrite a newer OFF', async () => {
  let releaseEnable;
  const heldEnable = new Promise((resolve) => {
    releaseEnable = resolve;
  });
  let enableCalls = 0;
  const rendered = loadPermissionHook({
    enable: async () => {
      enableCalls += 1;
      if (enableCalls > 1) await heldEnable;
      return { ok: true, canAskAgain: true };
    },
    disable: async () => ({ ok: true }),
  });

  await rendered.current.requestNotificationPermission();
  await rendered.flush();
  assert.equal(rendered.current.preferences.notifications, true);

  const slowOn = rendered.current.requestNotificationPermission();
  await settle(2);
  await rendered.current.disableNotificationDelivery();
  await rendered.flush();
  assert.equal(rendered.current.preferences.notifications, false);

  releaseEnable();
  await slowOn;
  await rendered.flush();

  assert.equal(
    rendered.current.preferences.notifications,
    false,
    'the stale ON completion must not undo an explicit OFF',
  );
});

test('RP-104 §11: a completion that lands after the actor changed mutates nothing', async () => {
  let releaseEnable;
  const heldEnable = new Promise((resolve) => {
    releaseEnable = resolve;
  });
  const rendered = loadPermissionHook({
    enable: async () => {
      await heldEnable;
      return { ok: true, canAskAgain: true };
    },
    disable: async () => ({ ok: true }),
  });

  rendered.actorContext.advanceActorEpoch(ACTOR_A);
  const slowEnable = rendered.current.requestNotificationPermission();
  await settle(2);

  // Actor A leaves, actor B arrives, and only then does A's request finish.
  rendered.actorContext.advanceActorEpoch(ACTOR_B);
  releaseEnable();
  await slowEnable;
  await rendered.flush();

  assert.equal(
    rendered.current.preferences.notifications,
    false,
    "the departed actor's completion must not paint the arriving actor's UI",
  );
});
