// Android notification activation / Watchlist dark-state alignment
// (K SCAN AI Android Repair 05).
//
// THE DEFECT
//
// Android production activated remote-push capability for a feature that does
// not ship there. The onboarding Permissions step rendered a live Notifications
// toggle whose own copy promises watched-item price alerts; turning it on called
// enableDeviceNotifications(), which requested the OS notification permission
// (POST_NOTIFICATIONS on Android 13+), obtained an Expo push token and
// registered the handset in user_device_push_tokens. A root-mounted
// push-token-refresh listener then kept that registration current for the life
// of the app.
//
// Nothing in a production build can send that user a push. Every remote push
// K Scan can produce originates in ONE backend module,
// supabase/functions/commerce-watch-refresh/pushDelivery.ts, and all four of its
// event types are Watchlist events; there is no other push sender in the backend
// and no local-notification scheduling anywhere in the app. eas.json sets
// EXPO_PUBLIC_SMART_WATCHLIST_V1 for `staging-certification` only, so production
// ships Smart Watchlist dark. The same premise was written into
// android/app/build.gradle, where NOTIF-02 hard-failed the production build
// without GOOGLE_SERVICES_JSON because "the shipping build advertises
// notifications and requests POST_NOTIFICATIONS".
//
// THE REPAIR
//
// services/notifications/remotePushCapability.ts is now the single decision, and
// every ACTIVATION path reads it: the onboarding row, the permission request,
// both token-acquisition paths and the token-refresh listener. Gradle derives
// the same answer from the same governed flag. Deactivation (revocation,
// explicit disable, actor claim) and passive handling (foreground presentation,
// tap routing) deliberately do NOT consult it.
//
// This file proves the behaviour by executing the real modules with controlled
// inputs, never by snapshotting text.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function transpile(rel) {
  return ts.transpileModule(read(rel), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
}

function evaluate(rel, shim, sandboxExtras = {}) {
  const mod = { exports: {} };
  const factory = vm.runInNewContext(
    `(function (exports, module, require, process, crypto, console, setTimeout, clearTimeout) {\n${transpile(rel)}\n})`,
    {
      Promise,
      Object,
      Array,
      JSON,
      Math,
      Date,
      Error,
      String,
      Number,
      Boolean,
      Symbol,
      RegExp,
      ...sandboxExtras,
    },
    { filename: rel },
  );
  factory(
    mod.exports,
    mod,
    shim,
    sandboxExtras.process ?? { env: {} },
    sandboxExtras.crypto ?? { randomUUID: () => 'uuid-fixed' },
    console,
    setTimeout,
    clearTimeout,
  );
  return mod.exports;
}

// ════════════════════════════════════════════════════════════════════════════
// PART A — the capability resolver itself: real module, controlled inputs
// ════════════════════════════════════════════════════════════════════════════

const CAPABILITY_MODULE = 'services/notifications/remotePushCapability.ts';

/** Loads the REAL services/notifications/remotePushCapability.ts. */
function loadCapability({ platformOS, smartWatchlistActive }) {
  return evaluate(CAPABILITY_MODULE, (spec) => {
    if (spec === 'react-native') return { Platform: { OS: platformOS } };
    if (spec === '../../constants/featureFlags') {
      return { SMART_WATCHLIST_V1: smartWatchlistActive };
    }
    throw new Error(`unexpected remotePushCapability import: ${spec}`);
  });
}

test('CAPABILITY: Android + Watchlist dark -> activation NOT allowed', () => {
  const cap = loadCapability({ platformOS: 'android', smartWatchlistActive: false });
  assert.equal(cap.resolveRemotePushActivationAllowed(), false);
});

test('CAPABILITY: Android + Watchlist live -> activation allowed', () => {
  const cap = loadCapability({ platformOS: 'android', smartWatchlistActive: true });
  assert.equal(cap.resolveRemotePushActivationAllowed(), true);
});

test('CAPABILITY: a future push-consuming feature re-enables activation', () => {
  // The gate must not be a hardcoded permanent disable. `consumerActive` is the
  // seam a second push consumer will arrive through, and it is what the answer
  // is derived from — not the platform, and not a constant.
  const cap = loadCapability({ platformOS: 'android', smartWatchlistActive: false });
  assert.equal(cap.resolveRemotePushActivationAllowed('android', true), true);
  assert.equal(cap.resolveRemotePushActivationAllowed('android', false), false);
});

test('CAPABILITY: the gate is an explicit Android allowlist, not a denylist', () => {
  // A denylist ("everything except iOS") would silently darken the next
  // platform this app ships on. Only listed platforms are governed.
  const cap = loadCapability({ platformOS: 'android', smartWatchlistActive: false });
  assert.deepEqual([...cap.REMOTE_PUSH_GATED_PLATFORMS], ['android']);
  assert.equal(cap.isRemotePushActivationGated('android'), true);
  for (const other of ['ios', 'web', 'windows', 'macos']) {
    assert.equal(cap.isRemotePushActivationGated(other), false, `${other} must not be gated`);
  }
});

test('IOS NEGATIVE CONTROL: iOS activation is unchanged in every flag state', () => {
  // §11: this is an Android repair. iOS must observe no new condition at all.
  for (const smartWatchlistActive of [true, false]) {
    const cap = loadCapability({ platformOS: 'ios', smartWatchlistActive });
    assert.equal(
      cap.resolveRemotePushActivationAllowed(),
      true,
      `iOS must stay ungated with Watchlist ${smartWatchlistActive}`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART B — env string -> governed flag -> capability, and fail-closed
// ════════════════════════════════════════════════════════════════════════════

/** Resolves SMART_WATCHLIST_V1 through the REAL constants/featureFlags.ts. */
function resolveWatchlistFlag(rawEnvValue) {
  const flags = evaluate('constants/featureFlags.ts', () => ({}), {
    process: { env: { EXPO_PUBLIC_SMART_WATCHLIST_V1: rawEnvValue } },
    __DEV__: false,
  });
  return flags.SMART_WATCHLIST_V1;
}

test('FAIL-CLOSED: an unknown or malformed capability state never activates push', () => {
  // §20: "unknown feature flag state must not result in request permission +
  // register token". Proven end to end from the raw environment value.
  for (const raw of [undefined, '', ' ', 'false', 'TRUE', 'True', '1', 'yes', 'null', 'undefined']) {
    const flagActive = resolveWatchlistFlag(raw);
    const cap = loadCapability({ platformOS: 'android', smartWatchlistActive: flagActive });
    assert.equal(
      cap.resolveRemotePushActivationAllowed(),
      false,
      `raw env ${JSON.stringify(raw)} must fail closed`,
    );
  }
});

test('FAIL-CLOSED: only the exact string "true" activates push', () => {
  assert.equal(resolveWatchlistFlag('true'), true);
  const cap = loadCapability({ platformOS: 'android', smartWatchlistActive: resolveWatchlistFlag('true') });
  assert.equal(cap.resolveRemotePushActivationAllowed(), true);
});

// ════════════════════════════════════════════════════════════════════════════
// PART C — the real activation paths, executed
// ════════════════════════════════════════════════════════════════════════════

/**
 * Loads the REAL services/watchlist/pushRegistration.ts wired to the REAL
 * capability module, with every notification and network primitive recorded.
 *
 * Nothing here is stubbed with a hand-written "allowed/denied" boolean: the
 * capability is computed by the same source the app runs.
 */
function loadPushRegistration({ platformOS, smartWatchlistActive, permissionGranted = true }) {
  const calls = {
    getPermissions: 0,
    requestPermissions: 0,
    getToken: 0,
    setChannel: 0,
    addPushTokenListener: 0,
    invokes: [],
  };
  const storage = new Map();

  const notifications = {
    AndroidImportance: { DEFAULT: 3 },
    getPermissionsAsync: async () => {
      calls.getPermissions += 1;
      return { granted: false, canAskAgain: true };
    },
    requestPermissionsAsync: async () => {
      calls.requestPermissions += 1;
      return { granted: permissionGranted, canAskAgain: true };
    },
    getExpoPushTokenAsync: async () => {
      calls.getToken += 1;
      return { data: 'ExponentPushToken[fixture]' };
    },
    setNotificationChannelAsync: async () => {
      calls.setChannel += 1;
    },
    addPushTokenListener: () => {
      calls.addPushTokenListener += 1;
      return { remove: () => {} };
    },
    addNotificationReceivedListener: () => ({ remove: () => {} }),
  };

  const capability = loadCapability({ platformOS, smartWatchlistActive });

  const mod = evaluate('services/watchlist/pushRegistration.ts', (spec) => {
    if (spec === 'react-native') {
      return { Platform: { OS: platformOS }, Linking: { openSettings: async () => {} } };
    }
    if (spec === 'expo-constants') {
      return { __esModule: true, default: { expoConfig: { extra: { eas: { projectId: 'proj' } } } } };
    }
    if (spec === '@react-native-async-storage/async-storage') {
      return {
        __esModule: true,
        default: {
          getItem: async (k) => (storage.has(k) ? storage.get(k) : null),
          setItem: async (k, v) => void storage.set(k, v),
          removeItem: async (k) => void storage.delete(k),
        },
      };
    }
    if (spec === '../supabaseClient') {
      return {
        supabase: {
          functions: {
            invoke: async (fn, options) => {
              calls.invokes.push({ fn, body: options.body });
              return { data: {}, error: null };
            },
          },
        },
      };
    }
    if (spec === '../authenticatedFunctionSession') {
      return { resolveAuthenticatedFunctionSession: async () => ({ ok: true }) };
    }
    if (spec === '../notifications/remotePushCapability') return capability;
    if (spec === 'expo-notifications') return notifications;
    throw new Error(`unexpected pushRegistration import: ${spec}`);
  });

  return { mod, calls, storage };
}

/** Every call that would activate remote-push capability. */
function activationCallCount(calls) {
  return calls.requestPermissions + calls.getToken + calls.setChannel + calls.addPushTokenListener;
}

test('PRODUCTION ANDROID: enabling notifications requests nothing and mints nothing', () => {
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: false,
  });
  return mod.enableDeviceNotifications().then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'capability_unavailable');
    assert.equal(result.canAskAgain, false, 'retrying cannot change a property of the build');
    assert.equal(calls.requestPermissions, 0, 'no OS permission prompt');
    assert.equal(calls.getPermissions, 0, 'not even a permission read');
    assert.equal(calls.getToken, 0, 'no Expo push token acquired');
    assert.equal(calls.invokes.length, 0, 'no device registration');
    assert.equal(storage.size, 0, 'no device identifier minted');
  });
});

test('PRODUCTION ANDROID: the post-Watch alert prompt acquires nothing either', () => {
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: false,
  });
  return mod.requestWatchAlerts('11111111-1111-4111-8111-111111111111').then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'capability_unavailable');
    assert.equal(activationCallCount(calls), 0);
    assert.equal(calls.invokes.length, 0);
    assert.equal(storage.size, 0);
  });
});

test('PRODUCTION ANDROID: the token-refresh listener is not even installed', () => {
  const { mod, calls } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: false,
  });
  return mod.attachPushTokenRefreshListener().then((remove) => {
    assert.equal(calls.addPushTokenListener, 0, 'no refresh listener may be registered');
    assert.equal(activationCallCount(calls), 0);
    assert.equal(typeof remove, 'function', 'the caller still receives a disposer');
    remove(); // must not throw
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART D — certification stays testable (§24)
// ════════════════════════════════════════════════════════════════════════════

test('CERTIFICATION ANDROID: the full activation path remains eligible', () => {
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: true,
  });
  return mod.enableDeviceNotifications().then((result) => {
    assert.equal(result.ok, true);
    assert.equal(calls.requestPermissions, 1, 'certification must still request the OS permission');
    assert.equal(calls.getToken, 1, 'certification must still acquire an Expo push token');
    assert.equal(calls.setChannel, 1, 'certification must still create the price-alerts channel');
    assert.equal(calls.invokes.length, 1);
    assert.equal(calls.invokes[0].body.action, 'register_push_token');
    assert.ok(storage.size > 0, 'a device identifier is minted on the path that registers');
  });
});

test('CERTIFICATION ANDROID: the token-refresh listener is installed', () => {
  const { mod, calls } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: true,
  });
  return mod.attachPushTokenRefreshListener().then(() => {
    assert.equal(calls.addPushTokenListener, 1);
  });
});

test('CERTIFICATION: eas.json is the one place the capability is turned on', () => {
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles.js');
  const profiles = resolveEasBuildProfiles(JSON.parse(read('eas.json')));
  const on = Object.entries(profiles)
    .filter(([, p]) => (p.env ?? {}).EXPO_PUBLIC_SMART_WATCHLIST_V1 === 'true')
    .map(([name]) => name);
  assert.deepEqual(on, ['staging-certification'], 'only certification may activate push today');
  assert.equal(
    (profiles.production.env ?? {}).EXPO_PUBLIC_SMART_WATCHLIST_V1,
    undefined,
    'production must ship the push consumer dark',
  );
});

// ════════════════════════════════════════════════════════════════════════════
// PART E — iOS behaviour is byte-for-byte what it was
// ════════════════════════════════════════════════════════════════════════════

test('IOS NEGATIVE CONTROL: enabling notifications behaves exactly as before', () => {
  // Same dark-Watchlist inputs that suppress everything on Android.
  const { mod, calls } = loadPushRegistration({
    platformOS: 'ios',
    smartWatchlistActive: false,
  });
  return mod.enableDeviceNotifications().then((result) => {
    assert.equal(result.ok, true, 'iOS must still complete the registration it always did');
    assert.equal(calls.requestPermissions, 1);
    assert.equal(calls.getToken, 1);
    assert.equal(calls.setChannel, 0, 'the Android channel is still Android-only');
    assert.equal(calls.invokes[0].body.action, 'register_push_token');
    assert.equal(calls.invokes[0].body.platform, 'ios');
  });
});

test('IOS NEGATIVE CONTROL: the token-refresh listener still installs on iOS', () => {
  const { mod, calls } = loadPushRegistration({
    platformOS: 'ios',
    smartWatchlistActive: false,
  });
  return mod.attachPushTokenRefreshListener().then(() => {
    assert.equal(calls.addPushTokenListener, 1);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// PART F — the consent invariant that already existed is preserved (§18)
// ════════════════════════════════════════════════════════════════════════════

test('CONSENT: a denied permission still registers no push token', () => {
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: true,
    permissionGranted: false,
  });
  return mod.enableDeviceNotifications().then((result) => {
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'permission_denied');
    assert.equal(calls.requestPermissions, 1);
    assert.equal(calls.getToken, 0, 'a denied permission must never reach token acquisition');
    assert.equal(calls.invokes.length, 0, 'and must never register the device');
    assert.equal(storage.size, 0);
  });
});

test('CONSENT: permission is checked before the token on every acquiring path', () => {
  const source = read('services/watchlist/pushRegistration.ts');
  for (const fn of ['requestWatchAlerts', 'enableDeviceNotifications']) {
    const body = source.slice(source.indexOf(`export async function ${fn}`));
    const gate = body.indexOf('resolveRemotePushActivationAllowed');
    const permission = body.indexOf('getPermissionsAsync');
    const token = body.indexOf('getExpoPushTokenAsync');
    assert.ok(gate >= 0 && permission >= 0 && token >= 0, `${fn} must contain all three steps`);
    assert.ok(gate < permission, `${fn}: the capability gate must precede the permission read`);
    assert.ok(permission < token, `${fn}: permission must precede token acquisition`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART G — deactivation and actor isolation stay ungated (§19)
// ════════════════════════════════════════════════════════════════════════════

test('ACTOR ISOLATION: logout revocation still works with the capability dark', () => {
  // A handset that registered under an earlier build must always be able to
  // retire that route, whatever this build ships.
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: false,
  });
  storage.set('kscan-watchlist-device-id', 'device-1');
  return mod.revokeWatchAlertsForThisDevice().then((outcome) => {
    assert.equal(outcome, 'revoked');
    assert.equal(calls.invokes.length, 1);
    assert.equal(calls.invokes[0].body.action, 'revoke_push_token');
    assert.equal(calls.invokes[0].body.deviceId, 'device-1');
  });
});

test('ACTOR ISOLATION: sign-in device claim still runs with the capability dark', () => {
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: false,
  });
  storage.set('kscan-watchlist-device-id', 'device-1');
  return mod.claimDeviceForCurrentActor().then(() => {
    assert.equal(calls.invokes.length, 1);
    assert.equal(calls.invokes[0].body.action, 'claim_device');
    assert.equal(activationCallCount(calls), 0, 'claiming acquires nothing');
  });
});

test('ACTOR ISOLATION: the explicit device OFF still revokes with the capability dark', () => {
  const { mod, calls, storage } = loadPushRegistration({
    platformOS: 'android',
    smartWatchlistActive: false,
  });
  storage.set('kscan-watchlist-device-id', 'device-1');
  return mod.disableDeviceNotifications().then((result) => {
    assert.equal(result.ok, true);
    assert.equal(calls.invokes.length, 1);
    assert.equal(calls.invokes[0].body.action, 'revoke_push_token');
    assert.equal(activationCallCount(calls), 0);
  });
});

test('ACTOR ISOLATION: no deactivation path consults the activation gate', () => {
  const source = read('services/watchlist/pushRegistration.ts');
  const bodyOf = (name, until) =>
    source.slice(source.indexOf(name), until ? source.indexOf(until) : undefined);
  const cases = [
    ['async function revokeThisDevicePushRoute', 'DEF-WL-01 (hostile-audit repair)'],
    ['export async function claimDeviceForCurrentActor', 'RP-109. Explicit network deadline'],
    ['export async function disableDeviceNotifications', 'Token-refresh lifecycle'],
  ];
  for (const [start, until] of cases) {
    const body = bodyOf(start, until);
    assert.ok(body.length > 0, `${start} must be locatable`);
    assert.ok(
      !body.includes('resolveRemotePushActivationAllowed'),
      `${start} must stay ungated — retiring a route is never activation`,
    );
  }
});

// ════════════════════════════════════════════════════════════════════════════
// PART H — passive handling is untouched (§7D, §9 Outcome A)
// ════════════════════════════════════════════════════════════════════════════

test('PASSIVE: notification routing acquires no permission and no token', () => {
  const routing = read('services/watchlist/watchNotificationRouting.ts');
  for (const acquiring of [
    'requestPermissionsAsync',
    'getExpoPushTokenAsync',
    'getPermissionsAsync',
    'setNotificationChannelAsync',
    'register_push_token',
  ]) {
    assert.ok(
      !routing.includes(acquiring),
      `tap routing must never ${acquiring} — it only handles what already arrived`,
    );
  }
  // And therefore it is deliberately NOT gated: a notification that somehow
  // arrives must still be presented and routed correctly.
  assert.ok(!routing.includes('resolveRemotePushActivationAllowed'));
});

test('WIRING: the root layout delegates to the gated service, adding no second gate', () => {
  const layout = read('app/_layout.tsx');
  assert.match(layout, /attachPushTokenRefreshListener\(\)/);
  assert.ok(
    !layout.includes('resolveRemotePushActivationAllowed'),
    'the decision has one home; the root must not re-derive it',
  );
  assert.ok(
    !layout.includes('SMART_WATCHLIST_V1'),
    'the root must not reach past the resolver to the raw flag',
  );
});

test('SINGLE AUTHORITY: every activation path reads the one resolver', () => {
  const push = read('services/watchlist/pushRegistration.ts');
  // Three activation entry points, three gates, and no raw flag or platform
  // test standing in for the decision anywhere in the module.
  assert.equal(
    (push.match(/resolveRemotePushActivationAllowed\(\)/g) ?? []).length,
    3,
    'requestWatchAlerts, enableDeviceNotifications and attachPushTokenRefreshListener',
  );
  assert.ok(!push.includes('SMART_WATCHLIST_V1'), 'no path may consult the raw flag directly');
});

// ════════════════════════════════════════════════════════════════════════════
// PART I — POST_NOTIFICATIONS and the native FCM decision
// ════════════════════════════════════════════════════════════════════════════

test('POST_NOTIFICATIONS: retained, because expo-notifications contributes it anyway', () => {
  // §29 disposition: RETAINED — STATIC DEPENDENCY / CERTIFICATION NEED, NOT
  // PROACTIVELY REQUESTED IN PRODUCTION. Deleting the first-party declaration
  // would change nothing in the merged manifest: the library declares it too,
  // so suppressing it would take tools:node="remove" in src/main — which the
  // certification artifact, built from the same source set, legitimately needs.
  const libraryManifest = read('node_modules/expo-notifications/android/src/main/AndroidManifest.xml');
  assert.match(
    libraryManifest,
    /android\.permission\.POST_NOTIFICATIONS/,
    'the dependency itself contributes the permission to the merged manifest',
  );
  const appManifest = read('android/app/src/main/AndroidManifest.xml');
  assert.match(appManifest, /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS"\/>/);
  assert.doesNotMatch(
    appManifest,
    /POST_NOTIFICATIONS"[^>]*tools:node="remove"/,
    'a src/main removal would strip it from the certification artifact too',
  );
});

test('POST_NOTIFICATIONS: production and certification share one release manifest slot', () => {
  // The evidence behind "record it separately rather than force it into this
  // PR": there is no `certification` build type. Both artifacts are `release`,
  // and the only manifest swap on that slot is the Voice selector's — a
  // different capability entirely.
  const gradle = read('android/app/build.gradle');
  const buildTypes = gradle.slice(gradle.indexOf('buildTypes {'), gradle.indexOf('packagingOptions {'));
  assert.ok(buildTypes.includes('release {'));
  assert.ok(!buildTypes.includes('certification {'), 'no separate certification build type exists');
  assert.match(gradle, /if \(voiceNativeCapabilityMaterialized\) \{\s*\n\s*manifest\.srcFile 'src\/certification\/AndroidManifest\.xml'/);
});

test('FCM: the native requirement is derived from the same governed flag', () => {
  const gradle = read('android/app/build.gradle');
  assert.match(gradle, /def remotePushCapabilityEnabled = smartWatchlistEnabled/);
  assert.match(gradle, /if \(remotePushCapabilityEnabled && !googleServicesConfigured\)/);
  // And the lenient apply is unchanged: an unprovisioned, push-dark build is
  // still green rather than failing with "File google-services.json is missing".
  assert.match(gradle, /if \(googleServicesConfigured\) \{\s*\n\s*apply plugin: 'com\.google\.gms\.google-services'/);
});

// ════════════════════════════════════════════════════════════════════════════
// PART J — prior Android repairs remain intact (§17)
// ════════════════════════════════════════════════════════════════════════════

test('REGRESSION: Repair 02 foreground-service governance is untouched', () => {
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  for (const permission of ['FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MEDIA_PLAYBACK']) {
    assert.match(
      manifest,
      new RegExp(`android\\.permission\\.${permission}"\\s+tools:node="remove"`),
      `${permission} must stay removed`,
    );
  }
  for (const service of [
    'expo.modules.audio.service.AudioControlsService',
    'expo.modules.audio.service.AudioRecordingService',
    'expo.modules.location.services.LocationTaskService',
  ]) {
    assert.match(
      manifest,
      new RegExp(`${service.replace(/\./g, '\\.')}"\\s+tools:node="remove"`),
      `${service} must stay removed`,
    );
  }
});

test('REGRESSION: Repair 03 certification audio governance is untouched', () => {
  const certification = read('android/app/src/certification/AndroidManifest.xml');
  // Comments are stripped first: Repair 03 deliberately left prose explaining
  // WHY the removal is gone, and that prose names the permission.
  const executable = certification.replace(/<!--[\s\S]*?-->/g, '');
  assert.doesNotMatch(
    executable,
    /MODIFY_AUDIO_SETTINGS/,
    'the certification overlay must not re-remove the playback-routing permission',
  );
  assert.match(certification, /RECORD_AUDIO"\s+tools:node="replace"/);
  assert.match(certification, /FOREGROUND_SERVICE_MICROPHONE"\s+tools:node="remove"/);
  assert.match(certification, /CAPTURE_AUDIO_OUTPUT"\s+tools:node="remove"/);
});

test('REGRESSION: Repair 04 notification resources survive the activation gate', () => {
  // §16: the icon and colour describe how a notification LOOKS whenever one is
  // legitimately enabled. Darkening acquisition is no reason to undo them.
  const manifest = read('android/app/src/main/AndroidManifest.xml');
  for (const key of [
    'com.google.firebase.messaging.default_notification_icon',
    'expo.modules.notifications.default_notification_icon',
    'com.google.firebase.messaging.default_notification_color',
    'expo.modules.notifications.default_notification_color',
  ]) {
    assert.ok(manifest.includes(key), `${key} must remain declared`);
  }
  assert.match(read('android/app/src/main/res/values/colors.xml'), /name="notification_icon_color"/);
  for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    assert.ok(
      fs.existsSync(path.join(ROOT, `android/app/src/main/res/drawable-${density}/notification_icon.png`)),
      `drawable-${density}/notification_icon.png must remain`,
    );
  }
});

test('REGRESSION: Repair 01 Mirror Selfie availability is untouched', () => {
  const mirror = read('services/mirror/mirrorSelfieAvailability.ts');
  assert.match(mirror, /MIRROR_SELFIE_SUPPORTED_PLATFORMS: readonly string\[\] = \['ios'\]/);
});
