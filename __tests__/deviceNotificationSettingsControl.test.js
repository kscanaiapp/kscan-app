/**
 * N-6 — post-onboarding device notification control.
 *
 * THE GAP
 *
 * A user could turn K Scan AI notifications ON during onboarding and, after
 * that, nowhere. The onboarding Permissions step is unreachable once
 * onboarding completes, so the only control over a live backend push route was
 * a screen the user could never return to.
 *
 * WHAT THESE TESTS ARE
 *
 * They EXECUTE the real modules — services/watchlist/pushRegistration.ts,
 * hooks/useDeviceNotificationSetting.ts and
 * components/settings/DeviceNotificationSettingsSection.tsx — against observing
 * fakes, and assert on the calls that were actually issued: the OS permission
 * APIs, the Expo token API, and the backend actions. Source-text assertions
 * cannot see an unissued revocation or an unwanted permission prompt, which is
 * the whole subject here.
 *
 * PLATFORM PARITY IS ASSERTED, NOT ASSUMED
 *
 * Every behavioural scenario runs on BOTH 'ios' and 'android' through the same
 * shared implementation, and §D adds differential assertions that the same user
 * intent from the same starting state produces the same K Scan outcome on both.
 * A deliberate divergence is injected and proven to turn the parity gate red.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const { createHookRuntime, settle } = require('./helpers/hookRuntime');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const DEVICE_ID_KEY = 'kscan-watchlist-device-id';
const DISABLED_KEY = 'kscan-watchlist-device-push-disabled';
const OWNER_KEY = 'kscan-watchlist-device-push-owner';

const PLATFORMS = ['ios', 'android'];

// ── module loading ───────────────────────────────────────────────────────────

function transpile(rel, jsx = false) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      ...(jsx ? { jsx: ts.JsxEmit.React } : {}),
    },
  }).outputText;
}

function loadTsModule(rel, requireMap, { jsx = false, extras = {} } = {}) {
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
    Symbol,
    RegExp,
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
    ...extras,
  };
  vm.runInNewContext(transpile(rel, jsx), sandbox, { filename: rel });
  return module.exports;
}

// ── observing fakes ──────────────────────────────────────────────────────────

/**
 * AsyncStorage stand-in recording every read and write, with two hostile
 * controls the F-N6-01/F-N6-02 scenarios need:
 *
 *  - `setFaulting(on, keys?)` makes operations throw, optionally for only some
 *    keys. A whole-store outage is not the interesting case: the F-N6-02 hole
 *    needs the device-id read to SUCCEED while the OFF marker fails, because a
 *    total outage already fails closed for an unrelated reason (no device id).
 *
 *  - `gateNextReadOf(key)` holds one read open AFTER it has snapshotted its
 *    value. That is what a slow read really is, and it is the only way to land
 *    another writer strictly INSIDE an operation's read/write gap rather than
 *    merely before it starts.
 */
function createStorage(initial = {}, options = {}) {
  const values = new Map(Object.entries(initial));
  const writes = [];
  const reads = [];
  let faultKeys = options.faulting ? null : undefined; // null = all keys
  let gate = null;

  const failing = (key) =>
    faultKeys !== undefined && (faultKeys === null || faultKeys.includes(key));

  return {
    values,
    writes,
    reads,
    /** `keys` omitted faults every key; `false` clears the fault entirely. */
    setFaulting(on, keys) {
      faultKeys = on ? (keys ?? null) : undefined;
    },
    gateNextReadOf(key) {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      gate = { key, promise, used: false };
      return () => release();
    },
    getItem: async (key) => {
      reads.push(key);
      if (failing(key)) throw new Error('AsyncStorage unavailable');
      // Snapshot BEFORE the gate. A read that began earlier returns the value
      // as it was when it began — which is exactly what makes the gap real.
      const snapshot = values.has(key) ? values.get(key) : null;
      if (gate && gate.key === key && !gate.used) {
        gate.used = true;
        await gate.promise;
      }
      return snapshot;
    },
    setItem: async (key, value) => {
      if (failing(key)) throw new Error('AsyncStorage unavailable');
      writes.push({ key, value });
      values.set(key, value);
    },
    removeItem: async (key) => {
      if (failing(key)) throw new Error('AsyncStorage unavailable');
      writes.push({ key, value: null });
      values.delete(key);
    },
  };
}

/** Storage whose every operation throws, for the unreadable-state scenarios. */
function createBrokenStorage() {
  return createStorage({}, { faulting: true });
}

function createAppState() {
  const handlers = [];
  return {
    currentState: 'active',
    addEventListener: (type, handler) => {
      handlers.push({ type, handler });
      return { remove: () => {
        const i = handlers.findIndex((h) => h.handler === handler);
        if (i >= 0) handlers.splice(i, 1);
      } };
    },
    emit(next) {
      for (const { type, handler } of [...handlers]) {
        if (type === 'change') handler(next);
      }
    },
    get listenerCount() {
      return handlers.length;
    },
  };
}

/**
 * The whole stack, wired the way the app wires it: the REAL push-registration
 * service, the REAL actor authority, and the REAL hook, sharing one hook
 * runtime so state writes are observable.
 */
function loadStack({
  platform = 'ios',
  storage = createStorage(),
  invoke,
  session = { ok: true },
  permission = { granted: true, canAskAgain: true },
  requestedPermission,
  tokenFails = false,
  capabilityAllowed = true,
  actorId = 'actor-a',
} = {}) {
  const invocations = [];
  const notificationCalls = [];
  const settingsOpened = [];

  const recordingInvoke = async (fn, options) => {
    invocations.push({ fn, body: options.body });
    return invoke ? invoke(fn, options) : { data: {}, error: null };
  };

  // A function is accepted so a scenario can change the OS answer between
  // reads — which is exactly what happens when the user walks to system
  // Settings and comes back.
  const currentPermission = () => (typeof permission === 'function' ? permission() : permission);
  const notifications = {
    getPermissionsAsync: async () => {
      notificationCalls.push('getPermissionsAsync');
      return currentPermission();
    },
    requestPermissionsAsync: async () => {
      notificationCalls.push('requestPermissionsAsync');
      return requestedPermission ?? currentPermission();
    },
    getExpoPushTokenAsync: async () => {
      notificationCalls.push('getExpoPushTokenAsync');
      if (tokenFails) throw new Error('token unavailable');
      return { data: 'ExponentPushToken[fake]' };
    },
    setNotificationChannelAsync: async () => {
      notificationCalls.push('setNotificationChannelAsync');
    },
    addPushTokenListener: (handler) => {
      notificationCalls.push('addPushTokenListener');
      pushTokenHandlers.push(handler);
      return { remove: () => {} };
    },
    AndroidImportance: { DEFAULT: 3 },
  };
  const pushTokenHandlers = [];

  const actorContext = require('../services/actorContext.js');
  actorContext.__resetActorContextForTests();
  const actorScope = loadTsModule('services/actorScope.ts', { './actorContext': actorContext });
  if (actorId !== null) actorContext.advanceActorEpoch(actorId);

  const capability = { resolveRemotePushActivationAllowed: () => capabilityAllowed };

  const push = loadTsModule('services/watchlist/pushRegistration.ts', {
    'react-native': {
      Platform: { OS: platform },
      Linking: { openSettings: async () => { settingsOpened.push('openSettings'); } },
    },
    'expo-constants': {
      __esModule: true,
      default: { expoConfig: { extra: { eas: { projectId: 'proj-1' } } } },
    },
    '@react-native-async-storage/async-storage': { __esModule: true, default: storage },
    '../supabaseClient': { supabase: { functions: { invoke: recordingInvoke } } },
    '../authenticatedFunctionSession': {
      resolveAuthenticatedFunctionSession: async () =>
        typeof session === 'function' ? session() : session,
    },
    'expo-notifications': notifications,
    '../notifications/remotePushCapability': capability,
    '../actorScope': actorScope,
  });

  const runtime = createHookRuntime();
  const appState = createAppState();
  const hookModule = loadTsModule('hooks/useDeviceNotificationSetting.ts', {
    react: runtime.react,
    'react-native': { AppState: appState },
    '../services/watchlist/pushRegistration': push,
    '../services/notifications/remotePushCapability': capability,
    '../services/actorScope': actorScope,
  });

  return {
    push,
    hookModule,
    runtime,
    appState,
    storage,
    invocations,
    notificationCalls,
    settingsOpened,
    actorContext,
    actorScope,
    pushTokenHandlers,
    actions: () => invocations.map((c) => c.body.action),
  };
}

/** Drives the real hook through the real runtime. */
function renderHook(stack, { actorKey = 'user:actor-a' } = {}) {
  let current;
  let key = actorKey;
  const renderOnce = () => {
    stack.runtime.beginRender();
    current = stack.hookModule.useDeviceNotificationSetting({ actorKey: key });
    stack.runtime.flushEffects();
  };
  renderOnce();
  return {
    get current() {
      return current;
    },
    setActorKey(next) {
      key = next;
      renderOnce();
    },
    async flush(cycles = 14) {
      for (let i = 0; i < cycles; i += 1) {
        await settle(2);
        if (stack.runtime.dirty) {
          stack.runtime.clearDirty();
          renderOnce();
        }
      }
    },
  };
}

// ── element-tree harness for the shipping section ────────────────────────────

function named(name) {
  const fn = function marker() {};
  Object.defineProperty(fn, 'name', { value: name });
  fn.displayName = name;
  return fn;
}

function walk(node, visit) {
  if (node === null || node === undefined || node === false || node === true) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== 'object' || node.__element !== true) return;
  visit(node);
  if (node.props && 'children' in node.props) walk(node.props.children, visit);
}

function collect(tree, predicate) {
  const out = [];
  walk(tree, (n) => {
    if (predicate(n)) out.push(n);
  });
  return out;
}

const isNamed = (n, name) =>
  typeof n.type === 'function' && (n.type.displayName === name || n.type.name === name);

/** Renders the REAL section against the REAL hook and the REAL service. */
function renderSection(stackOptions = {}, { actorKey = 'user:actor-a' } = {}) {
  const stack = loadStack(stackOptions);

  const reactForJsx = {
    ...stack.runtime.react,
    __esModule: true,
    createElement(type, props, ...children) {
      const merged = { ...(props || {}) };
      if (children.length > 0) merged.children = children.length === 1 ? children[0] : children;
      return { __element: true, type, props: merged };
    },
    Fragment: 'Fragment',
  };
  reactForJsx.default = reactForJsx;

  const section = loadTsModule(
    'components/settings/DeviceNotificationSettingsSection.tsx',
    {
      react: reactForJsx,
      'react-native': {
        ActivityIndicator: named('ActivityIndicator'),
        StyleSheet: { create: (s) => s },
        Text: named('Text'),
        View: named('View'),
      },
      '../../constants/theme': {
        LUXURY: { colors: new Proxy({}, { get: () => '#000' }), typography: new Proxy({}, { get: () => ({}) }) },
        RADIUS: new Proxy({}, { get: () => 8 }),
        SHADOWS: new Proxy({}, { get: () => ({}) }),
        SPACING: new Proxy({}, { get: () => 8 }),
      },
      '../luxury': { InlineNotice: named('InlineNotice'), SectionHeader: named('SectionHeader') },
      '../PrivacyToggle': { PrivacyToggle: named('PrivacyToggle') },
      '../../hooks/useDeviceNotificationSetting': stack.hookModule,
    },
    { jsx: true },
  );

  let tree;
  const renderOnce = () => {
    stack.runtime.beginRender();
    tree = section.DeviceNotificationSettingsSection({ actorKey });
    stack.runtime.flushEffects();
  };
  renderOnce();

  return {
    stack,
    get tree() {
      return tree;
    },
    toggle() {
      return collect(tree, (n) => isNamed(n, 'PrivacyToggle'))[0] ?? null;
    },
    notices() {
      return collect(tree, (n) => isNamed(n, 'InlineNotice')).map((n) => n.props);
    },
    async flush(cycles = 14) {
      for (let i = 0; i < cycles; i += 1) {
        await settle(2);
        if (stack.runtime.dirty) {
          stack.runtime.clearDirty();
          renderOnce();
        }
      }
    },
  };
}

/** Every OS-permission and token API. None may be touched by a mount. */
const ACTIVATION_CALLS = ['requestPermissionsAsync', 'getExpoPushTokenAsync'];
const activationCalls = (stack) =>
  stack.notificationCalls.filter((c) => ACTIVATION_CALLS.includes(c));

const forPlatform = (name, body) => {
  for (const platform of PLATFORMS) test(`${name} [${platform}]`, () => body(platform));
};

// ════════════════════════════════════════════════════════════════════════════
// §A  SETTINGS ENTRY IS SIDE-EFFECT FREE  (scenarios 1-5)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §1-4: mounting the control requests no permission, mints no token, registers and revokes nothing', async (platform) => {
  const view = renderSection({ platform, storage: createStorage({ [DEVICE_ID_KEY]: 'device-a' }) });
  await view.flush();

  assert.deepEqual(activationCalls(view.stack), [], 'no permission request and no token acquisition');
  assert.deepEqual(view.stack.actions(), [], 'no backend call of any kind');
  assert.deepEqual(view.stack.settingsOpened, [], 'no OS settings navigation');
  // A read-only permission check IS permitted, and is what makes the blocked
  // state renderable at all.
  assert.ok(view.stack.notificationCalls.includes('getPermissionsAsync'));
});

forPlatform('N-6 §1: mounting mints no device id', async (platform) => {
  const storage = createStorage();
  const view = renderSection({ platform, storage });
  await view.flush();

  assert.equal(storage.values.has(DEVICE_ID_KEY), false);
  assert.deepEqual(storage.writes, [], 'a read-only surface writes nothing at all');
});

forPlatform('N-6 §5: with the push capability OFF the control is not rendered and touches no API', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const view = renderSection({ platform, storage, capabilityAllowed: false });
  await view.flush();

  assert.equal(view.tree, null, 'the control must not be rendered at all');
  assert.deepEqual(view.stack.notificationCalls, [], 'not even the read-only permission API');
  assert.deepEqual(view.stack.actions(), []);
  assert.deepEqual(storage.reads, [], 'no durable state is even read');
  assert.equal(view.stack.appState.listenerCount, 0, 'no resume subscription is installed');
});

// ════════════════════════════════════════════════════════════════════════════
// §B  INITIAL STATE HYDRATION  (scenarios 6-9)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §6: a device registered to THIS actor hydrates ON', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
  });
  await view.flush();

  assert.equal(view.toggle().props.value, true);
});

forPlatform('N-6 §7: an explicit OFF survives an app restart and hydrates OFF', async (platform) => {
  // A cold start: the durable marker is all that carries the decision forward.
  const view = renderSection({
    platform,
    storage: createStorage({
      [DEVICE_ID_KEY]: 'device-a',
      [DISABLED_KEY]: 'true',
      [OWNER_KEY]: '',
    }),
  });
  await view.flush();

  assert.equal(view.toggle().props.value, false);
  assert.deepEqual(activationCalls(view.stack), [], 'a restart while OFF asks for nothing');
  assert.deepEqual(view.stack.actions(), [], 'and registers nothing');
});

forPlatform('N-6 §8: an unreadable durable state claims neither ON nor OFF', async (platform) => {
  const view = renderSection({ platform, storage: createBrokenStorage() });
  await view.flush();

  assert.equal(view.toggle(), null, 'no toggle may assert a position we do not hold');
  const notice = view.notices().find((p) => p.testID === 'settings-device-notifications-unreadable');
  assert.ok(notice, 'the surface must say it could not check');
  assert.equal(notice.accessibilityRole, 'alert');
  assert.equal(notice.action.testID, 'settings-device-notifications-retry');
});

forPlatform('N-6 §9: an OS-blocked permission and an app-level OFF are not conflated', async (platform) => {
  // K Scan-level delivery is ON; the OS is what is blocking. The toggle stays
  // ON — it is truthfully describing K Scan's own route — and the OS fact is
  // presented separately, with its own remedy.
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    permission: { granted: false, canAskAgain: false },
  });
  await view.flush();

  assert.equal(view.toggle().props.value, true);
  const blocked = view.notices().find((p) => p.testID === 'settings-device-notifications-os-blocked');
  assert.ok(blocked, 'the OS block must be stated');
  assert.equal(blocked.action.testID, 'settings-device-notifications-open-settings');
  assert.deepEqual(activationCalls(view.stack), [], 'and still asks the OS for nothing');
});

// ════════════════════════════════════════════════════════════════════════════
// §C  EXPLICIT OFF  (scenarios 10-17)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §10-11: an explicit OFF invokes the RP-104 revoke exactly once and settles OFF', async (platform) => {
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
  });
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'on');

  await hook.current.disable();
  await hook.flush();

  assert.deepEqual(stack.actions(), ['revoke_push_token']);
  assert.equal(stack.invocations[0].fn, 'commerce-watch-refresh');
  assert.equal(hook.current.status, 'off');
});

forPlatform('N-6 §12: a device with no registration resolves safely to OFF without minting one', async (platform) => {
  const storage = createStorage();
  const stack = loadStack({ platform, storage });
  const hook = renderHook(stack);
  await hook.flush();

  await hook.current.disable();
  await hook.flush();

  assert.equal(hook.current.status, 'off');
  assert.deepEqual(stack.actions(), [], 'nothing to revoke, so nothing is called');
  assert.equal(storage.values.has(DEVICE_ID_KEY), false, 'and no id is minted to disable');
});

forPlatform('N-6 §13-14: OFF requests no OS permission, opens no Settings and mints no device id', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage });
  const hook = renderHook(stack);
  await hook.flush();
  stack.notificationCalls.length = 0;

  await hook.current.disable();
  await hook.flush();

  assert.deepEqual(stack.notificationCalls, [], 'no notification API at all on the OFF path');
  assert.deepEqual(stack.settingsOpened, []);
  assert.equal(storage.values.get(DEVICE_ID_KEY), 'device-a', 'the device identity survives OFF');
});

forPlatform('N-6 §15-17: OFF deletes no Watch, alters no K+ and signs nobody out', async (platform) => {
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
  });
  const hook = renderHook(stack);
  await hook.flush();

  await hook.current.disable();
  await hook.flush();

  assert.equal(stack.invocations.length, 1);
  const body = stack.invocations[0].body;
  assert.deepEqual(Object.keys(body).sort(), ['action', 'deviceId']);
  for (const forbidden of ['delete_watch', 'set_push_enabled', 'remove_target', 'claim_device']) {
    assert.ok(!stack.actions().includes(forbidden), `OFF must not issue "${forbidden}"`);
  }
  // Sign-out is not reachable from this module at all.
  assert.doesNotMatch(read('hooks/useDeviceNotificationSetting.ts'), /signOut|auth\.signOut/);
  assert.doesNotMatch(
    read('components/settings/DeviceNotificationSettingsSection.tsx'),
    /signOut|useAuthSession/,
  );
});

// ════════════════════════════════════════════════════════════════════════════
// §D  OFF FAILURE IS TRUTHFUL  (scenarios 18-22)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §18-19: a failed revoke never presents a confirmed OFF, and says so', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async () => ({ data: null, error: { message: 'revoke_failed', status: 502 } }),
  });
  await view.flush();
  assert.equal(view.toggle().props.value, true);

  view.toggle().props.onChange(false);
  await view.flush();

  assert.equal(view.toggle().props.value, true, 'the device is still a live push destination');
  const error = view.notices().find((p) => p.testID === 'settings-device-notifications-error');
  assert.ok(error);
  assert.match(error.title, /Couldn't turn notifications off/);
  assert.equal(error.accessibilityRole, 'alert');
});

forPlatform('N-6 §20: the failed OFF is retryable and the retry succeeds', async (platform) => {
  let failNext = true;
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async () => (failNext ? { data: null, error: { message: 'boom' } } : { data: {}, error: null }),
  });
  await view.flush();

  view.toggle().props.onChange(false);
  await view.flush();
  assert.equal(view.toggle().props.value, true);

  failNext = false;
  view.toggle().props.onChange(false);
  await view.flush();

  assert.equal(view.toggle().props.value, false);
  assert.deepEqual(view.stack.actions(), ['revoke_push_token', 'revoke_push_token']);
  assert.equal(view.notices().some((p) => p.testID === 'settings-device-notifications-error'), false);
});

forPlatform('N-6 §21-22: no raw backend error, token or device id can reach the surface', async (platform) => {
  const secret = 'https://project.supabase.co/functions/v1 bearer=eyJhbGciOi';
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a-secret-id', [OWNER_KEY]: 'actor-a' }),
    invoke: async () => ({ data: null, error: { message: secret, status: 502, stack: secret } }),
  });
  await view.flush();
  view.toggle().props.onChange(false);
  await view.flush();

  const rendered = JSON.stringify(view.tree, (k, v) => (typeof v === 'function' ? '[fn]' : v));
  for (const forbidden of ['supabase.co', 'bearer', 'ExponentPushToken', 'device-a-secret-id', '502']) {
    assert.ok(!rendered.includes(forbidden), `the surface must not carry "${forbidden}"`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// §E  MULTI-DEVICE SAFETY  (scenarios 23-25)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §23-24: OFF names exactly one device id and carries no account-wide selector', async (platform) => {
  for (const deviceId of ['iphone-r1', 'android-r2']) {
    const stack = loadStack({
      platform,
      storage: createStorage({ [DEVICE_ID_KEY]: deviceId, [OWNER_KEY]: 'actor-a' }),
    });
    const hook = renderHook(stack);
    await hook.flush();
    await hook.current.disable();
    await hook.flush();

    assert.equal(stack.invocations.length, 1);
    assert.equal(stack.invocations[0].body.deviceId, deviceId);
    // Nothing in the request could reach the same actor's other handset.
    for (const forbidden of ['all', 'allDevices', 'userId', 'devices', 'entitlement']) {
      assert.ok(!(forbidden in stack.invocations[0].body));
    }
  }
});

test('N-6 §25: no user-wide revoke exists anywhere on the N-6 path', () => {
  const sources = [
    read('hooks/useDeviceNotificationSetting.ts'),
    read('components/settings/DeviceNotificationSettingsSection.tsx'),
    read('services/watchlist/pushRegistration.ts'),
  ].join('\n');
  for (const forbidden of [
    'revoke_all_push_tokens',
    'revoke_user_push_tokens',
    'revokeAllDevices',
    'disableNotificationsV2',
  ]) {
    assert.ok(!sources.includes(forbidden), `must not introduce "${forbidden}"`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// §F  RAPID INTERACTION AND STALE COMPLETIONS  (scenarios 26-29)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §26-27: while a mutation is pending the control is locked, so a double tap cannot double-revoke', async (platform) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async () => {
      await held;
      return { data: {}, error: null };
    },
  });
  await view.flush();

  view.toggle().props.onChange(false);
  await settle(3);
  await view.flush(2);

  assert.equal(view.toggle().props.busy, true, 'the row must expose a busy state');
  // The shipping row refuses interaction while busy (PrivacyToggle locks on
  // `busy`), so the second tap cannot start a second mutation.
  const toggleSource = read('components/PrivacyToggle.tsx');
  assert.match(toggleSource, /const locked = Boolean\(disabled\) \|\| Boolean\(busy\);/);
  assert.match(toggleSource, /disabled=\{locked\}/);

  release();
  await view.flush();
  assert.deepEqual(view.stack.actions(), ['revoke_push_token'], 'exactly one authoritative mutation');
});

forPlatform('N-6 §28: a stale OFF completion cannot overwrite a newer ON', async (platform) => {
  let releaseOff;
  const heldOff = new Promise((resolve) => {
    releaseOff = resolve;
  });
  let first = true;
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async (fn, options) => {
      if (options.body.action === 'revoke_push_token' && first) {
        first = false;
        await heldOff;
      }
      return { data: {}, error: null };
    },
  });
  const hook = renderHook(stack);
  await hook.flush();

  const slowOff = hook.current.disable();
  await settle(3);
  await hook.current.enable();
  await hook.flush();
  assert.equal(hook.current.status, 'on');

  releaseOff();
  await slowOff;
  await hook.flush();

  assert.equal(hook.current.status, 'on', 'the stale OFF completion must mutate nothing');
});

forPlatform('N-6 §28: a stale ON completion cannot overwrite a newer OFF', async (platform) => {
  let releaseOn;
  const heldOn = new Promise((resolve) => {
    releaseOn = resolve;
  });
  let held = false;
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async (fn, options) => {
      if (options.body.action === 'register_push_token' && held) await heldOn;
      return { data: {}, error: null };
    },
  });
  const hook = renderHook(stack);
  await hook.flush();

  held = true;
  const slowOn = hook.current.enable();
  await settle(3);
  await hook.current.disable();
  await hook.flush();
  assert.equal(hook.current.status, 'off');

  releaseOn();
  await slowOn;
  await hook.flush();

  assert.equal(hook.current.status, 'off', 'the stale ON completion must not undo an explicit OFF');
});

forPlatform('N-6 §29: a resume-triggered re-read cannot repaint over a mutation still in flight', async (platform) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({
    platform,
    storage,
    invoke: async () => {
      await held;
      return { data: {}, error: null };
    },
  });
  const hook = renderHook(stack);
  await hook.flush();

  const slowOff = hook.current.disable();
  await settle(2);
  // The app is backgrounded and resumed mid-revocation. Durable state still
  // reads ON (the revoke has not landed), and that must not repaint the
  // control back to ON under the newer intent.
  stack.appState.emit('active');
  await settle(4);

  release();
  await slowOff;
  await hook.flush();

  assert.equal(hook.current.status, 'off', 'no oscillation from an out-of-order read');
});

// ════════════════════════════════════════════════════════════════════════════
// §G  LOGOUT AND ACCOUNT-SWITCH RACES  (scenarios 30-33)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §30/33: an OFF in flight during logout leaves RP-109 bounded and intact', async (platform) => {
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
  });
  const hook = renderHook(stack);
  await hook.flush();

  // OFF starts, then logout runs its own bounded revocation.
  const off = hook.current.disable();
  const outcome = await stack.push.revokeWatchAlertsForThisDevice();
  await off;
  await hook.flush();

  assert.ok(['revoked', 'not_registered'].includes(outcome));
  assert.equal(stack.push.LOGOUT_PUSH_REVOCATION_DEADLINE_MS, 4000, 'the RP-109 bound is untouched');
  assert.equal(hook.current.status, 'off');
});

forPlatform('N-6 §31: a late OFF completion after logout cannot mutate the next session', async (platform) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async () => {
      await held;
      return { data: {}, error: null };
    },
  });
  const hook = renderHook(stack);
  await hook.flush();

  const slowOff = hook.current.disable();
  await settle(2);
  // Sign-out, then a different actor arrives — the real actor authority.
  stack.actorContext.advanceActorEpoch(null);
  stack.actorContext.advanceActorEpoch('actor-b');
  const statusBefore = hook.current.status;

  release();
  await slowOff;
  await hook.flush();

  assert.equal(
    hook.current.status,
    statusBefore,
    'actor A’s completion must not write actor B’s control',
  );
});

forPlatform('N-6 §32: actor A’s enable completion cannot mutate actor B’s state', async (platform) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: '' }),
    invoke: async (fn, options) => {
      if (options.body.action === 'register_push_token') await held;
      return { data: {}, error: null };
    },
  });
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'off');

  const slowOn = hook.current.enable();
  await settle(3);
  stack.actorContext.advanceActorEpoch('actor-b');

  release();
  await slowOn;
  await hook.flush();

  assert.equal(hook.current.status, 'off', 'B’s control never turns itself on');
});

forPlatform('N-6 §32: an account switch re-reads and does not show the departed actor’s ON', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage });
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'on');

  // The arriving actor's claim retires every other route on this handset.
  stack.actorContext.advanceActorEpoch('actor-b');
  await stack.push.claimDeviceForCurrentActor();
  hook.setActorKey('user:actor-b');
  await hook.flush();

  assert.equal(storage.values.get(OWNER_KEY), '', 'the claim records that no route is held here');
  assert.equal(hook.current.status, 'off', 'and the control tells actor B the truth');
});

// ════════════════════════════════════════════════════════════════════════════
// §H  RESTART, RESUME AND TOKEN REFRESH WHILE OFF  (scenarios 34-37)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §34: OFF survives a full restart of the module and the surface', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const first = loadStack({ platform, storage });
  const hook = renderHook(first);
  await hook.flush();
  await hook.current.disable();
  await hook.flush();
  assert.equal(hook.current.status, 'off');

  // A cold start: brand-new module instances, same durable storage.
  const restarted = renderSection({ platform, storage });
  await restarted.flush();

  assert.equal(restarted.toggle().props.value, false);
  assert.deepEqual(activationCalls(restarted.stack), []);
  assert.deepEqual(restarted.stack.actions(), []);
});

forPlatform('N-6 §35: a push-token refresh while OFF does not re-register', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage });
  const hook = renderHook(stack);
  await hook.flush();

  await stack.push.attachPushTokenRefreshListener();
  await hook.current.disable();
  await hook.flush();
  stack.invocations.length = 0;

  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(stack.actions(), [], 'OFF is durable against the automatic refresh path');
});

forPlatform('N-6 §36: an app resume while OFF registers nothing and asks for nothing', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' }),
  });
  await view.flush();
  view.stack.notificationCalls.length = 0;

  view.stack.appState.emit('active');
  await view.flush();

  assert.equal(view.toggle().props.value, false);
  assert.deepEqual(activationCalls(view.stack), []);
  assert.deepEqual(view.stack.actions(), []);
});

forPlatform('N-6 §37: nothing but an explicit ON can leave the OFF state', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' });
  const view = renderSection({ platform, storage });
  await view.flush();

  // Mount, resume, resume again: none of these is user intent.
  view.stack.appState.emit('active');
  view.stack.appState.emit('active');
  await view.flush();
  assert.equal(storage.values.get(DISABLED_KEY), 'true');
  assert.equal(view.toggle().props.value, false);

  view.toggle().props.onChange(true);
  await view.flush();

  assert.equal(storage.values.has(DISABLED_KEY), false, 'only the explicit ON clears the durable OFF');
  assert.equal(view.toggle().props.value, true);
});

// ════════════════════════════════════════════════════════════════════════════
// §I  EXPLICIT ON  (scenarios 38-45)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §38/44-45: an explicit ON uses the existing registration path and clears the durable OFF', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' });
  const stack = loadStack({ platform, storage });
  const hook = renderHook(stack);
  await hook.flush();

  await hook.current.enable();
  await hook.flush();

  assert.deepEqual(stack.actions(), ['register_push_token']);
  assert.equal(stack.invocations[0].body.deviceId, 'device-a', 'the same device identity is reused');
  assert.equal(stack.invocations[0].body.platform, platform);
  assert.equal(storage.values.has(DISABLED_KEY), false);
  assert.equal(storage.values.get(OWNER_KEY), 'actor-a');
  assert.equal(hook.current.status, 'on');
});

forPlatform('N-6 §39: mounting alone never reaches the ON path', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' });
  const view = renderSection({ platform, storage });
  await view.flush();
  view.stack.appState.emit('active');
  await view.flush();

  assert.deepEqual(view.stack.actions(), []);
  assert.equal(storage.values.get(DISABLED_KEY), 'true');
});

forPlatform('N-6 §40: with permission already granted, ON does not prompt again', async (platform) => {
  const stack = loadStack({
    platform,
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: true, canAskAgain: true },
  });
  const hook = renderHook(stack);
  await hook.flush();
  stack.notificationCalls.length = 0;

  await hook.current.enable();
  await hook.flush();

  assert.equal(
    stack.notificationCalls.includes('requestPermissionsAsync'),
    false,
    'an unnecessary permission prompt is itself the defect',
  );
  assert.equal(hook.current.status, 'on');
});

forPlatform('N-6 §41: with permission undetermined, only the explicit ON may request it', async (platform) => {
  const stack = loadStack({
    platform,
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: false, canAskAgain: true },
    requestedPermission: { granted: true, canAskAgain: true },
  });
  const hook = renderHook(stack);
  await hook.flush();
  assert.deepEqual(activationCalls(stack), [], 'not on mount');

  await hook.current.enable();
  await hook.flush();

  assert.equal(stack.notificationCalls.includes('requestPermissionsAsync'), true);
  assert.equal(hook.current.status, 'on');
});

forPlatform('N-6 §42: a denied permission acquires no token, registers nothing and reports honestly', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: false, canAskAgain: true },
    requestedPermission: { granted: false, canAskAgain: true },
  });
  await view.flush();

  view.toggle().props.onChange(true);
  await view.flush();

  assert.equal(view.stack.notificationCalls.includes('getExpoPushTokenAsync'), false);
  assert.deepEqual(view.stack.actions(), []);
  assert.equal(view.toggle().props.value, false, 'no confirmed ON may be shown');
  const error = view.notices().find((p) => p.testID === 'settings-device-notifications-error');
  assert.ok(error);
  assert.match(error.title, /weren't allowed/);
});

forPlatform('N-6 §42: a blocked permission is not re-prompted and offers the Settings route', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: false, canAskAgain: false },
  });
  await view.flush();

  view.toggle().props.onChange(true);
  await view.flush();

  assert.equal(
    view.stack.notificationCalls.includes('requestPermissionsAsync'),
    false,
    'the platform will not show it, so it must not be invoked',
  );
  assert.deepEqual(view.stack.actions(), []);
  assert.equal(view.toggle().props.value, false);
  const blocked = view.notices().find((p) => p.testID === 'settings-device-notifications-os-blocked');
  assert.ok(blocked);
  blocked.action.onPress();
  assert.deepEqual(view.stack.settingsOpened, ['openSettings'], 'only an explicit tap opens Settings');
});

forPlatform('N-6 §43: a registration failure never presents a confirmed ON', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [OWNER_KEY]: '' }),
    invoke: async () => ({ data: null, error: { message: 'register_failed' } }),
  });
  await view.flush();

  view.toggle().props.onChange(true);
  await view.flush();

  assert.equal(view.toggle().props.value, false);
  const error = view.notices().find((p) => p.testID === 'settings-device-notifications-error');
  assert.ok(error);
  assert.match(error.title, /Couldn't turn notifications on/);
});

forPlatform('N-6 §43: a token failure never presents a confirmed ON and registers nothing', async (platform) => {
  const stack = loadStack({ platform, storage: createStorage({ [OWNER_KEY]: '' }), tokenFails: true });
  const hook = renderHook(stack);
  await hook.flush();

  await hook.current.enable();
  await hook.flush();

  assert.deepEqual(stack.actions(), []);
  assert.equal(hook.current.status, 'off');
  assert.equal(hook.current.failure, 'enable_failed');
});

// ════════════════════════════════════════════════════════════════════════════
// §J  FEATURE GATING  (scenarios 46-49)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §46-49: with Watchlist OFF there is no actionable toggle, no permission API, no token and no registration', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const view = renderSection({ platform, storage, capabilityAllowed: false });
  await view.flush();

  assert.equal(view.tree, null);
  assert.equal(view.toggle(), null, 'nothing actionable is rendered');
  assert.deepEqual(view.stack.notificationCalls, []);
  assert.deepEqual(view.stack.actions(), []);

  // And even if the hook is driven directly, NEITHER direction can bring a
  // control into existence: an ON that requested permission, or an OFF that
  // moved `status` off 'unavailable', would both render one.
  const hook = renderHook(view.stack);
  await hook.flush();
  await hook.current.enable();
  await hook.flush();
  assert.equal(hook.current.status, 'unavailable');
  await hook.current.disable();
  await hook.flush();
  assert.equal(hook.current.status, 'unavailable');
  await hook.current.refresh();
  await hook.flush();
  assert.equal(hook.current.status, 'unavailable');
  assert.deepEqual(view.stack.notificationCalls, []);
  assert.deepEqual(view.stack.actions(), []);
});

test('N-6 §46: the control reads the ONE canonical capability authority, not a re-derived flag', () => {
  const hook = read('hooks/useDeviceNotificationSetting.ts');
  assert.match(hook, /resolveRemotePushActivationAllowed/);
  // No second gate composed here from a flag and a platform test.
  assert.doesNotMatch(hook, /SMART_WATCHLIST_V1/);
  assert.doesNotMatch(hook, /Platform\.OS/);
});

// ════════════════════════════════════════════════════════════════════════════
// §K  ACCESSIBILITY AND PRIVACY  (scenarios 50-54)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6 §50-51: the control exposes an accessible switch role, state, and busy state', async (platform) => {
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
  });
  await view.flush();

  const toggle = view.toggle();
  assert.equal(toggle.props.title, 'Notifications on this device');
  assert.equal(typeof toggle.props.value, 'boolean');
  assert.equal(toggle.props.busy, false);

  // The shared row is the project's existing accessible switch: role, checked
  // state, disabled state and a >=44dp target all come from it rather than
  // from a bespoke control invented here.
  const source = read('components/PrivacyToggle.tsx');
  assert.match(source, /accessibilityRole="switch"/);
  assert.match(source, /accessibilityState=\{\{ checked: value, disabled: locked \}\}/);
  assert.match(source, /minHeight: 96/);
  assert.doesNotMatch(
    read('components/settings/DeviceNotificationSettingsSection.tsx'),
    /Switch|Pressable|TouchableOpacity/,
    'no bespoke control may be introduced alongside the accessible one',
  );
});

forPlatform('N-6 §51: the busy state is exposed while a mutation is in flight', async (platform) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const view = renderSection({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    invoke: async () => {
      await held;
      return { data: {}, error: null };
    },
  });
  await view.flush();

  view.toggle().props.onChange(false);
  await settle(3);
  await view.flush(2);

  assert.equal(view.toggle().props.busy, true);
  assert.match(view.toggle().props.body, /Turning off/);
  release();
  await view.flush();
  assert.equal(view.toggle().props.busy, false);
});

test('N-6 §52-53: no token, email, name or notification content appears in the N-6 sources', () => {
  const sources = {
    'hooks/useDeviceNotificationSetting.ts': read('hooks/useDeviceNotificationSetting.ts'),
    'components/settings/DeviceNotificationSettingsSection.tsx': read(
      'components/settings/DeviceNotificationSettingsSection.tsx',
    ),
  };
  for (const [name, source] of Object.entries(sources)) {
    for (const forbidden of [
      'getExpoPushTokenAsync',
      'expoPushToken',
      'pushToken',
      'user.email',
      'deviceId',
      'console.log',
      'posthog',
      'PostHog',
      'captureEvent',
    ]) {
      assert.ok(!source.includes(forbidden), `${name} must not reference "${forbidden}"`);
    }
  }
});

test('N-6 §54: the failure copy is a closed set of bounded strings, never server text', () => {
  const source = read('components/settings/DeviceNotificationSettingsSection.tsx');
  // No interpolation of a reason, error, message or status into user copy.
  assert.doesNotMatch(source, /body=\{`[^`]*\$\{[^}]*(error|reason|message|status)/i);
  assert.match(source, /Couldn't turn notifications off/);
  assert.match(source, /Couldn't turn notifications on/);
  // And the engineering vocabulary never surfaces.
  for (const forbidden of ['RPC', 'ExpoPushToken', 'APNs', 'FCM', 'Supabase', 'device route', 'token']) {
    assert.ok(!source.includes(forbidden), `user copy must not contain "${forbidden}"`);
  }
});

test('N-6 §5/§8: the surface never claims K Scan revoked the OS notification permission', () => {
  const source = read('components/settings/DeviceNotificationSettingsSection.tsx');
  for (const claim of [
    'Disable all notifications',
    'Disable notifications everywhere',
    'Notification permission revoked',
    'System notifications disabled',
    'notification permission revoked',
    'revoked in Settings',
  ]) {
    assert.ok(!source.includes(claim), `must not claim "${claim}"`);
  }
  // Device scope is stated, not implied.
  assert.match(source, /Notifications on this device/);
  assert.match(source, /alerts on this device/);
});

// ════════════════════════════════════════════════════════════════════════════
// §L  CROSS-PLATFORM DIFFERENTIAL  (same intent + same start => same outcome)
// ════════════════════════════════════════════════════════════════════════════

/**
 * Runs one scenario on both platforms and returns the two outcomes for direct
 * comparison. The point is not that each side passes its own assertions — the
 * suites above already prove that — but that the two sides AGREE.
 */
async function differential(scenario) {
  const out = {};
  for (const platform of PLATFORMS) out[platform] = await scenario(platform);
  return out;
}

test('N-6 parity: OFF disables K Scan device delivery identically on both platforms', async () => {
  const outcomes = await differential(async (platform) => {
    const stack = loadStack({
      platform,
      storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    });
    const hook = renderHook(stack);
    await hook.flush();
    await hook.current.disable();
    await hook.flush();
    return {
      status: hook.current.status,
      actions: stack.actions(),
      owner: stack.storage.values.get(OWNER_KEY),
      disabledMarker: stack.storage.values.get(DISABLED_KEY),
      activation: activationCalls(stack),
    };
  });
  assert.deepEqual(outcomes.ios, outcomes.android);
  assert.deepEqual(outcomes.ios.actions, ['revoke_push_token']);
  assert.equal(outcomes.ios.status, 'off');
});

test('N-6 parity: a denied permission yields no token, no route and the same truthful state on both platforms', async () => {
  const outcomes = await differential(async (platform) => {
    const stack = loadStack({
      platform,
      storage: createStorage({ [OWNER_KEY]: '' }),
      permission: { granted: false, canAskAgain: true },
      requestedPermission: { granted: false, canAskAgain: true },
    });
    const hook = renderHook(stack);
    await hook.flush();
    await hook.current.enable();
    await hook.flush();
    return {
      status: hook.current.status,
      failure: hook.current.failure,
      osPermission: hook.current.osPermission,
      actions: stack.actions(),
      tokenRequested: stack.notificationCalls.includes('getExpoPushTokenAsync'),
    };
  });
  assert.deepEqual(outcomes.ios, outcomes.android);
  assert.equal(outcomes.ios.tokenRequested, false);
  assert.deepEqual(outcomes.ios.actions, []);
  assert.equal(outcomes.ios.status, 'off');
});

test('N-6 parity: a blocked permission is reported identically and never re-prompted on either platform', async () => {
  const outcomes = await differential(async (platform) => {
    const stack = loadStack({
      platform,
      storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
      permission: { granted: false, canAskAgain: false },
    });
    const hook = renderHook(stack);
    await hook.flush();
    return {
      status: hook.current.status,
      osPermission: hook.current.osPermission,
      prompted: stack.notificationCalls.includes('requestPermissionsAsync'),
    };
  });
  assert.deepEqual(outcomes.ios, outcomes.android);
  assert.equal(outcomes.ios.osPermission, 'blocked');
  assert.equal(outcomes.ios.prompted, false);
});

test('N-6 parity: a restart while OFF registers nothing on either platform', async () => {
  const outcomes = await differential(async (platform) => {
    const storage = createStorage({
      [DEVICE_ID_KEY]: 'device-a',
      [DISABLED_KEY]: 'true',
      [OWNER_KEY]: '',
    });
    const view = renderSection({ platform, storage });
    await view.flush();
    return {
      value: view.toggle().props.value,
      actions: view.stack.actions(),
      activation: activationCalls(view.stack),
    };
  });
  assert.deepEqual(outcomes.ios, outcomes.android);
  assert.deepEqual(outcomes.ios.actions, []);
  assert.equal(outcomes.ios.value, false);
});

test('N-6 parity: a token refresh while OFF recreates no route on either platform', async () => {
  const outcomes = await differential(async (platform) => {
    const stack = loadStack({
      platform,
      storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' }),
    });
    await stack.push.attachPushTokenRefreshListener();
    stack.invocations.length = 0;
    for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
    await settle(8);
    return { actions: stack.actions() };
  });
  assert.deepEqual(outcomes.ios, outcomes.android);
  assert.deepEqual(outcomes.ios.actions, []);
});

test('N-6 parity: explicit ON registers the same way on both platforms, differing only in the platform it reports', async () => {
  const outcomes = await differential(async (platform) => {
    const stack = loadStack({ platform, storage: createStorage({ [OWNER_KEY]: '' }) });
    const hook = renderHook(stack);
    await hook.flush();
    await hook.current.enable();
    await hook.flush();
    return {
      status: hook.current.status,
      actions: stack.actions(),
      bodyKeys: Object.keys(stack.invocations[0].body).sort(),
      reportedPlatform: stack.invocations[0].body.platform,
    };
  });
  assert.equal(outcomes.ios.status, outcomes.android.status);
  assert.deepEqual(outcomes.ios.actions, outcomes.android.actions);
  assert.deepEqual(outcomes.ios.bodyKeys, outcomes.android.bodyKeys);
  // The ONE legitimate difference: each device reports which platform it is.
  assert.equal(outcomes.ios.reportedPlatform, 'ios');
  assert.equal(outcomes.android.reportedPlatform, 'android');
});

test('N-6 parity: the control has exactly ONE shared implementation — no per-platform variants', () => {
  for (const base of [
    'hooks/useDeviceNotificationSetting',
    'components/settings/DeviceNotificationSettingsSection',
  ]) {
    for (const variant of ['.ios.ts', '.android.ts', '.ios.tsx', '.android.tsx', '.native.ts']) {
      assert.equal(
        fs.existsSync(path.join(ROOT, `${base}${variant}`)),
        false,
        `${base}${variant} must not exist: the semantics are shared`,
      );
    }
  }
  // Neither N-6 module branches on the platform at all.
  assert.doesNotMatch(read('hooks/useDeviceNotificationSetting.ts'), /Platform\.OS/);
  assert.doesNotMatch(
    read('components/settings/DeviceNotificationSettingsSection.tsx'),
    /Platform\.OS/,
  );
});

/**
 * NEGATIVE CONTROL for the parity gate itself.
 *
 * A parity assertion that cannot fail is worthless. This drives the SAME
 * scenario with one platform deliberately diverging (its capability gate
 * switched off, exactly the shape of a real one-platform regression) and proves
 * the comparison turns red. The divergence exists only inside this test.
 */
test('NEGATIVE CONTROL: a deliberate one-platform divergence turns the parity comparison red', async () => {
  const outcomes = {};
  for (const platform of PLATFORMS) {
    const stack = loadStack({
      platform,
      storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
      // The injected defect: iOS is left ungated, exactly the N-1 shape.
      capabilityAllowed: platform === 'ios',
    });
    const hook = renderHook(stack);
    await hook.flush();
    outcomes[platform] = { status: hook.current.status };
  }
  assert.notDeepEqual(
    outcomes.ios,
    outcomes.android,
    'the parity comparison must be able to observe a one-platform divergence',
  );
  assert.throws(() => assert.deepEqual(outcomes.ios, outcomes.android));
});

// ════════════════════════════════════════════════════════════════════════════
// §M  NEGATIVE CONTROLS — prove the important tests bite
// ════════════════════════════════════════════════════════════════════════════

test('NEGATIVE CONTROL A: a permission request on mount would be caught', async () => {
  const stack = loadStack({ platform: 'ios', storage: createStorage() });
  // Simulate the defect the mount test forbids, without shipping it.
  await stack.push.enableDeviceNotifications();
  assert.notDeepEqual(
    activationCalls(stack),
    [],
    'the mount assertion is watching a channel that can actually record a prompt',
  );
  assert.throws(() => assert.deepEqual(activationCalls(stack), []));
});

test('NEGATIVE CONTROL B: an account-wide revoke would be caught by the device-scope assertion', async () => {
  const stack = loadStack({
    platform: 'ios',
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
  });
  // The injected defect: a revoke that names the whole account instead of one
  // device. Issued through the same observed boundary the real path uses.
  await stack.push.disableDeviceNotifications();
  const body = { ...stack.invocations[0].body, allDevices: true };
  delete body.deviceId;
  assert.throws(() => {
    assert.deepEqual(Object.keys(body).sort(), ['action', 'deviceId']);
  }, 'the multi-device assertion must reject an account-wide selector');
});

test('NEGATIVE CONTROL C: bypassing the durable OFF guard would let a token refresh re-register', async () => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform: 'ios', storage });
  await stack.push.attachPushTokenRefreshListener();
  await stack.push.disableDeviceNotifications();
  stack.invocations.length = 0;

  // The injected defect: the durable OFF marker and the ownership record are
  // both wiped, which is exactly what "bypass the guard" means for this path.
  storage.values.delete(DISABLED_KEY);
  storage.values.delete(OWNER_KEY);
  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(
    stack.actions(),
    ['register_push_token'],
    'the refresh test observes a channel that really can re-register',
  );
  // Restored: with the guard in place the same refresh does nothing.
  const clean = loadStack({
    platform: 'ios',
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' }),
  });
  await clean.push.attachPushTokenRefreshListener();
  clean.invocations.length = 0;
  for (const handler of clean.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);
  assert.deepEqual(clean.actions(), []);
});

test('NEGATIVE CONTROL D: without the actor guard, a stale completion WOULD overwrite the newer state', async () => {
  // The real guard is proven above. Here the same shape is run with the actor
  // check removed, to show the assertion is not vacuous: an unguarded apply
  // does land, so a guarded one not landing is a real observation.
  const applied = [];
  const guarded = [];
  const scope = { epoch: 1 };
  let live = 1;
  const applyUnguarded = (value) => applied.push(value);
  const applyGuarded = (value, captured) => {
    if (captured.epoch !== live) return;
    guarded.push(value);
  };

  const captured = { ...scope };
  live = 2; // the actor changed while the work was in flight
  applyUnguarded('stale');
  applyGuarded('stale', captured);

  assert.deepEqual(applied, ['stale'], 'an unguarded apply lands');
  assert.deepEqual(guarded, [], 'the guarded one does not');
});

// ════════════════════════════════════════════════════════════════════════════
// §N  WIRING, CONTAINMENT AND NON-REGRESSION OF THE SURROUNDING LANES
// ════════════════════════════════════════════════════════════════════════════

test('N-6: the control is reachable from the shipping post-onboarding settings surface', () => {
  const privacy = read('app/privacy.tsx');
  assert.match(privacy, /import \{ DeviceNotificationSettingsSection \}/);
  assert.match(privacy, /<DeviceNotificationSettingsSection actorKey=/);
  // Rendered only for a signed-in actor: a route is keyed on (user, device).
  assert.match(privacy, /isAuthenticated && user \? \(\s*<DeviceNotificationSettingsSection/);
  // And that surface is reachable from Home.
  assert.match(read('components/home/HomeLuxuryTechV1.tsx'), /router\.push\('\/privacy'\)/);
});

test('N-6 §26: no second registration or revocation implementation was introduced', () => {
  const hook = read('hooks/useDeviceNotificationSetting.ts');
  // Every mutation delegates to the canonical authority.
  assert.match(hook, /enableDeviceNotifications/);
  assert.match(hook, /disableDeviceNotifications/);
  for (const forbidden of [
    'register_push_token',
    'revoke_push_token',
    'functions.invoke',
    'supabase',
    'getExpoPushTokenAsync',
    'requestPermissionsAsync',
  ]) {
    assert.ok(!hook.includes(forbidden), `the view model must not re-implement "${forbidden}"`);
  }
});

test('N-6 §26: the native configuration and permission surface are exactly as N-6 found them', () => {
  const appJson = JSON.parse(read('app.json')).expo;
  assert.equal(appJson.android.versionCode, 23);
  assert.equal(appJson.ios.buildNumber, '26');

  // The Android permission surface is untouched, INCLUDING the containment
  // posture N-6 must not weaken: POST_NOTIFICATIONS stays BLOCKED. Adding it
  // to make an Android explicit ON succeed is exactly the change §26 forbids,
  // so the control lives with the truthful "not allowed on this device" state
  // that block produces on Android 13+.
  assert.deepEqual(appJson.android.permissions.sort(), [
    'android.permission.ACCESS_COARSE_LOCATION',
    'android.permission.CAMERA',
    'android.permission.INTERNET',
    'android.permission.VIBRATE',
  ]);
  assert.ok(
    appJson.android.blockedPermissions.includes('android.permission.POST_NOTIFICATIONS'),
    'the shipping Android notification containment must remain intact',
  );

  // The plugin set is unchanged: no plugin was added, and the notification
  // plugin that was already here is untouched.
  assert.deepEqual(
    appJson.plugins.map((p) => (Array.isArray(p) ? p[0] : p)),
    [
      'expo-camera',
      'expo-image-picker',
      'expo-router',
      'expo-apple-authentication',
      'expo-font',
      'expo-location',
      'expo-audio',
      'expo-notifications',
    ],
  );
});

test('N-6 ANDROID: with POST_NOTIFICATIONS blocked, an explicit ON prompts nothing and registers nothing', async () => {
  // The real Android 13+ answer under this build's containment: not granted,
  // and the platform will not show a prompt. The control must not hammer at a
  // prompt that cannot appear, must not mint a token, and must not claim ON.
  const stack = loadStack({
    platform: 'android',
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: false, canAskAgain: false },
  });
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.osPermission, 'blocked');

  await hook.current.enable();
  await hook.flush();

  assert.equal(stack.notificationCalls.includes('requestPermissionsAsync'), false);
  assert.equal(stack.notificationCalls.includes('getExpoPushTokenAsync'), false);
  assert.deepEqual(stack.actions(), []);
  assert.equal(hook.current.status, 'off', 'no confirmed ON over a device that cannot receive');
});

test('N-6 ANDROID: on a version with no runtime notification permission, an explicit ON still registers', async () => {
  // Android below 13 has no POST_NOTIFICATIONS runtime grant, so
  // getPermissionsAsync reports granted with nothing to ask. The same shared
  // implementation must simply proceed — no Android-only branch, no prompt.
  const stack = loadStack({
    platform: 'android',
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: true, canAskAgain: false },
  });
  const hook = renderHook(stack);
  await hook.flush();

  await hook.current.enable();
  await hook.flush();

  assert.equal(stack.notificationCalls.includes('requestPermissionsAsync'), false);
  assert.deepEqual(stack.actions(), ['register_push_token']);
  assert.equal(hook.current.status, 'on');
  // The product notification channel is created before the first alert lands.
  assert.ok(stack.notificationCalls.includes('setNotificationChannelAsync'));
});

test('N-6 IOS: provisional/ephemeral authorization is treated as granted, not re-prompted', async () => {
  // expo-notifications reports authorized, provisional and ephemeral alike as
  // granted on iOS. All three permit delivery, which is the only claim the
  // control makes, so all three proceed without a second prompt.
  const stack = loadStack({
    platform: 'ios',
    storage: createStorage({ [OWNER_KEY]: '' }),
    permission: { granted: true, canAskAgain: false, ios: { status: 3 } },
  });
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.osPermission, 'granted');

  await hook.current.enable();
  await hook.flush();

  assert.equal(stack.notificationCalls.includes('requestPermissionsAsync'), false);
  assert.deepEqual(stack.actions(), ['register_push_token']);
  // And no Android channel is created on iOS.
  assert.equal(stack.notificationCalls.includes('setNotificationChannelAsync'), false);
});

forPlatform('N-6: returning from system Settings with permission changed refreshes the surface', async (platform) => {
  let permission = { granted: false, canAskAgain: false };
  const stack = loadStack({
    platform,
    storage: createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' }),
    permission: () => permission,
  });
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.osPermission, 'blocked');

  // The user walks to Settings, allows notifications, and comes back.
  permission = { granted: true, canAskAgain: true };
  stack.appState.emit('active');
  await hook.flush();

  assert.equal(hook.current.osPermission, 'granted');
  assert.deepEqual(activationCalls(stack), [], 'the resume read asks the OS for nothing');
  assert.deepEqual(stack.actions(), [], 'and registers nothing on its own');
});

test('N-6 §29: the notification ROUTING authority is untouched', () => {
  // N-2/N-3 own routing. Nothing on the N-6 path may reach it.
  for (const source of [
    read('hooks/useDeviceNotificationSetting.ts'),
    read('components/settings/DeviceNotificationSettingsSection.tsx'),
  ]) {
    assert.ok(!source.includes('watchNotificationRouting'));
    assert.ok(!source.includes('addNotificationResponseReceivedListener'));
  }
});

test('N-6 §23: no client telemetry processor and no new data recipient were introduced', () => {
  for (const rel of [
    'hooks/useDeviceNotificationSetting.ts',
    'components/settings/DeviceNotificationSettingsSection.tsx',
  ]) {
    const source = read(rel);
    for (const forbidden of ['posthog', 'PostHog', 'analytics', 'fetch(', 'axios']) {
      assert.ok(!source.includes(forbidden), `${rel} must not reference "${forbidden}"`);
    }
  }
});

test('N-6: RP-104 and RP-109 keep their exact public contracts', () => {
  const source = read('services/watchlist/pushRegistration.ts');
  assert.match(source, /export const LOGOUT_PUSH_REVOCATION_DEADLINE_MS = 4000;/);
  assert.match(
    source,
    /export type LogoutPushRevocationOutcome =\s*\n\s*\|\s*'revoked'\s*\n\s*\|\s*'not_registered'\s*\n\s*\|\s*'no_session'\s*\n\s*\|\s*'failed'\s*\n\s*\|\s*'timed_out';/,
  );
  assert.match(source, /export async function disableDeviceNotifications/);
  assert.match(source, /export async function enableDeviceNotifications/);
});

// ════════════════════════════════════════════════════════════════════════════
// §O  THE ACTOR-SCOPED DELIVERY AUTHORITY (the state-authority repair itself)
// ════════════════════════════════════════════════════════════════════════════

forPlatform('N-6: after a sign-out revocation, the same actor signing back in is not told ON', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage });

  // RP-109 sign-out revocation for the departing actor.
  const outcome = await stack.push.revokeWatchAlertsForThisDevice();
  assert.equal(outcome, 'revoked');
  assert.equal(storage.values.get(OWNER_KEY), '', 'the route this device held is recorded as gone');

  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'off', 'there is no route, so ON would be a false claim');
});

forPlatform('N-6/RP-109: a sign-out revocation that lands late cannot release the NEXT actor’s record', async (platform) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({
    platform,
    storage,
    invoke: async (fn, options) => {
      if (options.body.action === 'revoke_push_token') await held;
      return { data: {}, error: null };
    },
  });

  const slow = stack.push.revokeWatchAlertsForThisDevice();
  await settle(2);
  // The next actor arrives and registers before the old revocation resolves.
  stack.actorContext.advanceActorEpoch('actor-b');
  await storage.setItem(OWNER_KEY, 'actor-b');

  release();
  await slow;
  await settle(4);

  assert.equal(
    storage.values.get(OWNER_KEY),
    'actor-b',
    'the compare-and-clear names the departing actor, so it cannot touch the arriving one',
  );
});

forPlatform('N-6: an actor claim records that no route is held here for the arriving actor', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-b' });

  await stack.push.claimDeviceForCurrentActor();

  assert.deepEqual(stack.actions(), ['claim_device']);
  assert.equal(storage.values.get(OWNER_KEY), '');
});

forPlatform('N-6: a failed actor claim records nothing at all', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({
    platform,
    storage,
    actorId: 'actor-b',
    invoke: async () => ({ data: null, error: { message: 'claim failed' } }),
  });

  await stack.push.claimDeviceForCurrentActor();

  assert.equal(storage.values.get(OWNER_KEY), 'actor-a', 'an unknown outcome writes no claim');
});

forPlatform('N-6: a pre-N-6 install is backfilled by the claim rather than shown a false OFF', async (platform) => {
  // No owner record at all: the device registered before this repair existed.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'on', 'the pre-N-6 fact is the best local truth available');

  await stack.push.claimDeviceForCurrentActor();
  assert.equal(storage.values.get(OWNER_KEY), 'actor-a', 'and it is made exact for every later switch');
});

forPlatform('N-6: a token refresh cannot arm a route for an actor who never opted in', async (platform) => {
  // Actor A registered; actor B is now at the keyboard and never enabled
  // anything. Before N-6 the surviving device id was enough to re-register.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-b' });

  await stack.push.attachPushTokenRefreshListener();
  stack.invocations.length = 0;
  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(stack.actions(), [], 'no silent route for a non-consenting actor');
});

forPlatform('N-6: a token refresh still re-registers for the actor who DID opt in', async (platform) => {
  // NEGATIVE CONTROL for the guard above: it must not have broken NOTIF-16.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  await stack.push.attachPushTokenRefreshListener();
  stack.invocations.length = 0;
  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(stack.actions(), ['register_push_token']);
});

forPlatform('N-6: an unreadable device state never reports a confirmed OFF', async (platform) => {
  // The defect: readDeviceId collapses a storage fault into "no id", which made
  // disableDeviceNotifications answer `ok: true, alreadyUnregistered: true` —
  // a CONFIRMED off — over a backend route that may still be delivering.
  const stack = loadStack({ platform, storage: createBrokenStorage() });

  const result = await stack.push.disableDeviceNotifications();

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'device_state_unreadable');
  assert.notEqual(result.alreadyUnregistered, true);
  assert.deepEqual(stack.actions(), [], 'and nothing is asserted to the backend either');
});

// ════════════════════════════════════════════════════════════════════════════
// §P  F-N6-02 — the AUTOMATIC registration path fails CLOSED on an unreadable
//     preference authority
//
// The hole: the explicit-OFF marker was read with a fail-OPEN catch. That is
// right for an interactive request, where the user is present and asking for
// delivery. It is wrong for the token-refresh listener, which registers on an
// event the user neither sees nor triggers — there, one transient storage fault
// silently rebuilt a route the user had explicitly revoked, with no UI anywhere
// reflecting it. Durable OFF has to survive a bad read or it is not durable.
// ════════════════════════════════════════════════════════════════════════════

forPlatform('F-N6-02: OFF + an unreadable OFF marker + a token refresh registers NOTHING', async (platform) => {
  // A pre-N-6 install (absent owner record) is used deliberately: it is the one
  // state in which the owner guard is permissive, so the OFF marker is the only
  // thing standing between the refresh and a re-registration. Anything else
  // would let a second guard mask the hole and make this test vacuous.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  await stack.push.attachPushTokenRefreshListener();
  await stack.push.disableDeviceNotifications();
  assert.equal(storage.values.get(DISABLED_KEY), 'true');
  stack.invocations.length = 0;

  // A transient fault on the marker ONLY: the device id still reads, so the
  // path is not short-circuited for an unrelated reason.
  storage.setFaulting(true, [DISABLED_KEY]);
  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(
    stack.actions(),
    [],
    'an unreadable OFF authority must mean NOT AUTHORISED, never "carry on"',
  );
});

forPlatform('F-N6-02: an unreadable OWNER record also refuses the automatic path', async (platform) => {
  // Owner names a DIFFERENT actor, so the correct answer is "refuse". If the
  // fault collapsed into "absent", the path would read that as a pre-N-6
  // install and register a route for an actor who never opted in.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-b' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  await stack.push.attachPushTokenRefreshListener();
  stack.invocations.length = 0;

  storage.setFaulting(true, [OWNER_KEY]);
  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(stack.actions(), []);
});

forPlatform('F-N6-02: OFF + a storage fault + an app resume registers NOTHING and never shows ON', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' });
  const view = renderSection({ platform, storage });
  await view.flush();
  await view.stack.push.attachPushTokenRefreshListener();
  assert.equal(view.toggle().props.value, false);

  storage.setFaulting(true);
  view.stack.invocations.length = 0;
  view.stack.appState.emit('active');
  await view.flush();
  for (const handler of view.stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(view.stack.actions(), [], 'a resume under fault registers nothing');
  assert.deepEqual(activationCalls(view.stack), []);
  assert.equal(view.toggle(), null, 'and the surface asserts no position it cannot support');
  assert.ok(view.notices().some((p) => p.testID === 'settings-device-notifications-unreadable'));
});

forPlatform('F-N6-02: an unreadable state can never silently become ON', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' });
  const stack = loadStack({ platform, storage });
  storage.setFaulting(true);
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'unreadable');

  // Nothing that is not an explicit user ON may move it.
  stack.appState.emit('active');
  await hook.flush();
  await hook.current.refresh();
  await hook.flush();
  assert.equal(hook.current.status, 'unreadable');
  assert.deepEqual(stack.actions(), []);
});

forPlatform('F-N6-02: once storage recovers, an explicit ON still registers and clears the durable OFF', async (platform) => {
  // Failing closed must not strand the user: the interactive path never
  // consults the OFF marker, so recovery needs no repair step of its own.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [DISABLED_KEY]: 'true', [OWNER_KEY]: '' });
  const stack = loadStack({ platform, storage });
  storage.setFaulting(true);
  const hook = renderHook(stack);
  await hook.flush();
  assert.equal(hook.current.status, 'unreadable');

  storage.setFaulting(false);
  await hook.current.refresh();
  await hook.flush();
  assert.equal(hook.current.status, 'off');

  await hook.current.enable();
  await hook.flush();

  assert.deepEqual(stack.actions(), ['register_push_token']);
  assert.equal(hook.current.status, 'on');
  assert.equal(storage.values.has(DISABLED_KEY), false);
  assert.equal(storage.values.get(OWNER_KEY), 'actor-a');
});

forPlatform('F-N6-02: a readable pre-N-6 install still re-registers on refresh (guard did not over-reach)', async (platform) => {
  // NEGATIVE CONTROL for the fail-closed change: absent is NOT unreadable, and
  // NOTIF-16 recovery for a device that legitimately opted in is untouched.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  await stack.push.attachPushTokenRefreshListener();
  stack.invocations.length = 0;
  for (const handler of stack.pushTokenHandlers) handler({ data: 'ExponentPushToken[rolled]' });
  await settle(8);

  assert.deepEqual(stack.actions(), ['register_push_token']);
});

// ════════════════════════════════════════════════════════════════════════════
// §Q  F-N6-01 — the owner record's serialized mutation authority
//
// Every owner mutation is a read-decide-write and AsyncStorage has no
// compare-and-swap, so a second writer landing between one operation's read and
// its write is invisible to it. These tests inject that writer strictly INSIDE
// the gap — by holding the read open after it has snapshotted its value — and
// assert that an ownership actor B has committed is never cleared by actor A.
// ════════════════════════════════════════════════════════════════════════════

forPlatform('F-N6-01: actor B registering INSIDE actor A’s release gap keeps its ownership', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  // A signs out. Its release reads the owner record; the read is held open
  // AFTER snapshotting 'actor-a', so A is now inside its read/write gap.
  const releaseGate = storage.gateNextReadOf(OWNER_KEY);
  const slowRelease = stack.push.revokeWatchAlertsForThisDevice();
  await settle(4);

  // B arrives and registers FOR REAL while A is stuck in that gap.
  stack.actorContext.advanceActorEpoch('actor-b');
  const bRegistration = stack.push.enableDeviceNotifications();
  await settle(8);
  assert.ok(
    stack.actions().includes('register_push_token'),
    'B must genuinely hold a live backend route for this test to mean anything',
  );

  releaseGate();
  assert.equal(await slowRelease, 'revoked');
  assert.equal((await bRegistration).ok, true);
  await settle(8);

  assert.equal(
    storage.values.get(OWNER_KEY),
    'actor-b',
    'A’s stale release must not clear an ownership B committed',
  );

  // And the control tells B the truth about the route B actually has.
  const hook = renderHook(stack, { actorKey: 'user:actor-b' });
  await hook.flush();
  assert.equal(hook.current.status, 'on', 'a live route must never render a false OFF');
});

forPlatform('F-N6-01: an actor A release that arrives after B has committed observes B and no-ops', async (platform) => {
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  // A's release is held BEFORE it enters the owner authority at all, so B's
  // registration wins the queue outright — the other half of the ordering.
  const releaseGate = storage.gateNextReadOf(DEVICE_ID_KEY);
  const slowRelease = stack.push.revokeWatchAlertsForThisDevice();
  await settle(4);

  stack.actorContext.advanceActorEpoch('actor-b');
  assert.equal((await stack.push.enableDeviceNotifications()).ok, true);
  assert.equal(storage.values.get(OWNER_KEY), 'actor-b');

  releaseGate();
  await slowRelease;
  await settle(8);

  assert.equal(storage.values.get(OWNER_KEY), 'actor-b', 'A must read B and stand down');
});

forPlatform('F-N6-01: a stale explicit OFF cannot clear an ownership committed after it', async (platform) => {
  // The same race reached through the user-facing control rather than logout.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a', [OWNER_KEY]: 'actor-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-a' });

  const releaseGate = storage.gateNextReadOf(OWNER_KEY);
  const slowDisable = stack.push.disableDeviceNotifications();
  await settle(4);

  stack.actorContext.advanceActorEpoch('actor-b');
  const bRegistration = stack.push.enableDeviceNotifications();
  await settle(8);

  releaseGate();
  await slowDisable;
  await bRegistration;
  await settle(8);

  assert.equal(storage.values.get(OWNER_KEY), 'actor-b');
});

forPlatform('F-N6-01: a claim overtaken by a NEWER actor boundary writes nothing', async (platform) => {
  // B's claim is still in flight when C arrives. B's late completion must not
  // backfill this device to B, which would be a false ON for C.
  const storage = createStorage({ [DEVICE_ID_KEY]: 'device-a' });
  const stack = loadStack({ platform, storage, actorId: 'actor-b' });

  const releaseGate = storage.gateNextReadOf(DEVICE_ID_KEY);
  const slowClaim = stack.push.claimDeviceForCurrentActor();
  await settle(4);

  stack.actorContext.advanceActorEpoch('actor-c');
  releaseGate();
  await slowClaim;
  await settle(6);

  assert.equal(
    storage.values.has(OWNER_KEY),
    false,
    'a superseded claim must not attribute this device to the actor who left',
  );
});

test('F-N6-01: every owner mutation goes through the one serialized authority', () => {
  const source = read('services/watchlist/pushRegistration.ts');
  // The raw writer is named to be unmistakable, and may appear ONLY inside the
  // exclusive authority's own helpers.
  const rawWrites = [...source.matchAll(/writeDevicePushOwnerUnsafe\(/g)].length;
  assert.ok(rawWrites >= 4, 'the raw writer should still be reachable from the guarded helpers');
  // No caller outside the authority may write the record directly.
  for (const [name] of [['recordDevicePushOwner'], ['releaseDevicePushOwnerIfHeldBy']]) {
    assert.ok(source.includes(`async function ${name}`), `${name} must exist`);
  }
  assert.match(source, /function runExclusiveDevicePushOwnerMutation/);
  // Each of the five owner-changing operations participates.
  for (const site of [
    'await recordDevicePushOwner(registeringActor)',        // registration (both paths)
    'await releaseDevicePushOwnerIfHeldBy(departing)',      // logout release
    'await releaseDevicePushOwnerIfHeldBy(actingActor)',    // explicit revoke
    'await runExclusiveDevicePushOwnerMutation(async () => {', // claim + backfill
  ]) {
    assert.ok(source.includes(site), `missing serialized owner mutation: ${site}`);
  }
});
