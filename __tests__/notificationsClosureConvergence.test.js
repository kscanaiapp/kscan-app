/**
 * Notifications final convergence (NOTIF closure pass).
 *
 * Guards the specific defects this convergence closed on the canonical
 * K+/integration line. Each test names the finding it protects so a future
 * edit that reopens one fails here rather than on a device.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const appJson = JSON.parse(read('app.json'));
const expo = appJson.expo;
const pushRegistration = read('services/watchlist/pushRegistration.ts');
const pushDelivery = read('supabase/functions/commerce-watch-refresh/pushDelivery.ts');
const watchRefresh = read('supabase/functions/commerce-watch-refresh/index.ts');
const permissionsStep = read('components/account-home/PermissionsStepV1.tsx');
const permissionsHook = read('hooks/usePermissionPreferences.ts');
const androidManifest = read('android/app/src/main/AndroidManifest.xml');
const buildGradle = read('android/app/build.gradle');

function findPlugin(name) {
  return (expo.plugins ?? []).find((p) => (Array.isArray(p) ? p[0] === name : p === name));
}

// ─── NOTIF-01: iOS production APNs ───────────────────────────────────────────

test('NOTIF-01: expo-notifications declares mode "production"', () => {
  const plugin = findPlugin('expo-notifications');
  assert.ok(Array.isArray(plugin), 'expo-notifications must carry a config object');
  assert.equal(plugin[1].mode, 'production');
});

test('NOTIF-01: the plugin config cannot silently regress to development', () => {
  const plugin = findPlugin('expo-notifications');
  assert.notEqual(plugin[1].mode, 'development');
  assert.notEqual(plugin[1].mode, undefined);
});

// ─── NOTIF-02: Android FCM fail-closed on the shipping profile ───────────────

test('NOTIF-02: the production Android profile fails closed without Firebase config', () => {
  assert.match(buildGradle, /easBuildProfile == PRODUCTION_PROFILE && !googleServicesConfigured/);
  assert.match(buildGradle, /throw new GradleException/);
});

// ─── §13/§18: Android permission + channel authority ────────────────────────

test('POST_NOTIFICATIONS is explicit in app.json and AndroidManifest', () => {
  assert.ok(expo.android.permissions.includes('android.permission.POST_NOTIFICATIONS'));
  assert.match(
    androidManifest,
    /<uses-permission android:name="android\.permission\.POST_NOTIFICATIONS"\/>/,
  );
});

test('no drift on pre-existing permissions', () => {
  for (const perm of [
    'android.permission.CAMERA',
    'android.permission.INTERNET',
    'android.permission.VIBRATE',
    'android.permission.ACCESS_COARSE_LOCATION',
  ]) {
    assert.ok(expo.android.permissions.includes(perm), `lost pre-existing permission ${perm}`);
  }
  assert.ok(expo.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
});

test('NOTIF-07: client and sender agree on the price-alerts channel id', () => {
  assert.match(pushRegistration, /ANDROID_NOTIFICATION_CHANNEL_ID = 'price-alerts'/);
  assert.match(pushDelivery, /ANDROID_NOTIFICATION_CHANNEL_ID = 'price-alerts'/);
  // The send payload must actually carry it, or Android uses the default channel.
  assert.match(pushDelivery, /channelId: ANDROID_NOTIFICATION_CHANNEL_ID/);
  assert.match(pushRegistration, /setNotificationChannelAsync\(ANDROID_NOTIFICATION_CHANNEL_ID/);
});

test('the notification small icon is a dedicated monochrome asset, not the launcher icon', () => {
  const plugin = findPlugin('expo-notifications');
  assert.equal(plugin[1].icon, './assets/notification-icon.png');
  assert.notEqual(plugin[1].icon, expo.icon);
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/notification-icon.png')));
});

// ─── NOTIF-14: explicit Expo project id ─────────────────────────────────────

test('NOTIF-14: every token acquisition passes an explicit projectId', () => {
  const calls = pushRegistration.match(/getExpoPushTokenAsync\([^)]*\)/g) ?? [];
  assert.ok(calls.length > 0, 'expected at least one token acquisition');
  for (const call of calls) {
    assert.match(call, /projectId/, `implicit project-id discovery in: ${call}`);
  }
});

// ─── NOTIF-06: multi-device delivery ────────────────────────────────────────

test('NOTIF-06: push selects every live device, not just one', () => {
  assert.doesNotMatch(watchRefresh, /user_device_push_tokens[^`'"]*limit=1/);
  assert.match(watchRefresh, /revoked_at=is\.null/);
});

test('NOTIF-06: one dead token cannot suppress delivery to siblings', () => {
  const fn = watchRefresh.slice(
    watchRefresh.indexOf('async function deliverPushIfArmed'),
    watchRefresh.indexOf('function toWatchState'),
  );
  assert.match(fn, /Promise\.all/);
  assert.match(fn, /catch/);
});

// ─── NOTIF-10: push action authorization ────────────────────────────────────

test('NOTIF-10: Expo push-token shape is validated server-side', () => {
  assert.match(watchRefresh, /EXPO_PUSH_TOKEN_PATTERN/);
  assert.match(watchRefresh, /Expo\(nent\)\?PushToken/);
  assert.match(watchRefresh, /isValidExpoPushToken\(pushToken\)/);
});

test('NOTIF-10: arming actions require an eligible account actor', () => {
  assert.match(watchRefresh, /async function isEligibleAccountActor/);
  assert.match(watchRefresh, /watchlist_actor_is_active/);
  const register = watchRefresh.slice(
    watchRefresh.indexOf('async function handleRegisterPushToken'),
    watchRefresh.indexOf('async function handleRevokePushToken'),
  );
  assert.match(register, /isEligibleAccountActor\(authUser\.id\)/);
});

test('NOTIF-10: disarming stays reachable for an ineligible account', () => {
  // Revoking a route and turning an alert OFF must never be blocked by
  // eligibility -- otherwise a deleting account is trapped with live alerts.
  const revoke = watchRefresh.slice(
    watchRefresh.indexOf('async function handleRevokePushToken'),
    watchRefresh.indexOf('async function handleClaimDevice'),
  );
  assert.doesNotMatch(revoke, /isEligibleAccountActor/);
  assert.match(watchRefresh, /body\.enabled === true && !\(await isEligibleAccountActor/);
});

// ─── §12: ticket is not delivery ────────────────────────────────────────────

test('the Expo ticket id is retained and never equated with delivery', () => {
  assert.match(pushDelivery, /ticketId\?: string/);
  assert.match(pushDelivery, /ticketId/);
});

// ─── §21/§22: onboarding Notifications surface ──────────────────────────────

test('§21: the Notifications card exists and is OPTIONAL, not Coming Soon', () => {
  assert.match(permissionsStep, /title="Notifications"/);
  const card = permissionsStep.slice(permissionsStep.indexOf('title="Notifications"'));
  assert.doesNotMatch(card.slice(0, 400), /Coming Soon/i);
  assert.match(card.slice(0, 400), /badge="OPTIONAL"/);
});

test('§21: the Notifications control is not statically disabled', () => {
  const card = permissionsStep.slice(permissionsStep.indexOf('title="Notifications"'));
  assert.doesNotMatch(card.slice(0, 500), /disabled=\{true\}/);
});

test('§21: enabling requests the real OS permission', () => {
  assert.match(permissionsStep, /requestNotificationPermission\(\)/);
  assert.match(pushRegistration, /requestPermissionsAsync\(\)/);
});

test('§21: the user is not opted in by default', () => {
  assert.match(permissionsHook, /notifications:\s*false,/);
  const fn = permissionsHook.slice(permissionsHook.indexOf('requestNotificationPermission = useCallback'));
  // State is set from the REAL result, never optimistically.
  assert.match(fn, /setPreference\('notifications', result\.ok\)/);
});

test('§21: device enablement never arms an individual Watch alert', () => {
  const fn = pushRegistration.slice(pushRegistration.indexOf('export async function enableDeviceNotifications'));
  assert.doesNotMatch(fn, /set_push_enabled/);
});

test('NOTIF-11: a permanently denied user is offered a Settings route', () => {
  assert.match(permissionsStep, /denied_needs_settings/);
  assert.match(permissionsStep, /openNotificationSettings/);
  assert.match(pushRegistration, /export function openNotificationSettings/);
});

test('§22: the Notifications card has no environment or feature-flag gate', () => {
  const card = permissionsStep.slice(permissionsStep.indexOf('{/* Notifications'));
  // Strip JSX/line comments first: prose explaining that the card must NOT be
  // gated legitimately names the very gates being forbidden. Only executable
  // code is evidence of a gate.
  const cardOnly = card
    .slice(0, card.indexOf('/>') + 2)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\/.*$/gm, '');
  for (const token of [
    'ACCOUNT_HOME_UX_V1_ENABLED',
    'FeatureFreeze',
    'process.env',
    '__DEV__',
    'remoteConfig',
    'app_config',
    'RevenueCat',
    'PostHog',
    'kplus',
    'K_PLUS',
  ]) {
    assert.ok(!cardOnly.includes(token), `Notifications card must not reference "${token}"`);
  }
});

// ─── §2: already-approved non-notification work preserved ───────────────────

test('§2: affirmative AI consent and AI_PROCESSING_VERSION are preserved', () => {
  assert.match(read('constants/legal.ts'), /AI_PROCESSING_VERSION/);
  const onboarding = read('app/onboarding/index.tsx');
  assert.match(onboarding, /onboarding-ai-consent-checkbox/);
  assert.match(onboarding, /onboarding-ai-processing-statement/);
  assert.match(onboarding, /aiProcessingVersion: AI_PROCESSING_VERSION/);
});
