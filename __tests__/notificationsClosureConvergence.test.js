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
const rootLayout = read('app/_layout.tsx');
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

// ─── NOTIF-02 (Android Repair 05): FCM fail-closed on PUSH, not on profile ───
//
// TEST-FLIP. The old expectation was `easBuildProfile == PRODUCTION_PROFILE &&
// !googleServicesConfigured` -- production required Firebase configuration
// unconditionally, on the stated premise that "the shipping build advertises
// notifications and requests POST_NOTIFICATIONS". Repair 05 removed that
// premise: production ships Smart Watchlist dark, no other feature in the app
// consumes remote push, and the client no longer requests the permission or
// mints a token in that state. Demanding an FCM credential for a capability
// the artifact never activates is a requirement with nothing behind it.
//
// The fail-closed property itself is NOT relaxed: it now keys on the thing
// that actually matters -- whether this build activates push -- and therefore
// still fires for production the moment production turns a push consumer on.

test('NOTIF-02: FCM is required exactly when the build activates remote push', () => {
  assert.match(
    buildGradle,
    /def remotePushCapabilityEnabled = smartWatchlistEnabled/,
    'the native build must name the remote-push capability as one derived value',
  );
  assert.match(
    buildGradle,
    /if \(remotePushCapabilityEnabled && !googleServicesConfigured\) \{\s*\n\s*throw new GradleException/,
    'a build that activates remote push without FCM configuration must fail closed',
  );
});

test('NOTIF-02: the FCM requirement is not keyed on a profile name', () => {
  // A profile-name guard is what produced the defect: it demanded Firebase of
  // `production` regardless of whether production activated anything, and
  // would equally have missed a future profile that turns push on.
  const guard = buildGradle.slice(
    buildGradle.indexOf('def googleServicesConfigured'),
    buildGradle.indexOf('// Objective D'),
  );
  assert.ok(guard.length > 0, 'the FCM guard block must be locatable');
  assert.doesNotMatch(
    guard,
    /easBuildProfile == PRODUCTION_PROFILE[^\n]*!googleServicesConfigured/,
    'the FCM requirement must derive from the push capability, never from a profile name',
  );
});

test('NOTIF-02 NEGATIVE CONTROL: certification can still never be built without FCM', () => {
  // staging-certification is the one profile eas.json turns Smart Watchlist on
  // for, so the capability resolves true there and the guard above applies.
  // This is the half of the invariant Repair 05 must not have weakened.
  const eas = JSON.parse(read('eas.json'));
  const { resolveEasBuildProfiles } = require('../scripts/resolve-eas-build-profiles.js');
  const profiles = resolveEasBuildProfiles(eas);
  assert.equal(
    profiles['staging-certification'].env.EXPO_PUBLIC_SMART_WATCHLIST_V1,
    'true',
    'certification must keep the flag the native capability is derived from',
  );
  assert.match(
    buildGradle,
    /System\.getenv\('EXPO_PUBLIC_SMART_WATCHLIST_V1'\)/,
    'the native capability must read the same governed flag eas.json sets',
  );
  assert.match(
    buildGradle,
    /equalsIgnoreCase\('true'\)/,
    'the selector must fail closed on a missing or malformed value',
  );
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

test('NOTIF-16: the shipping app installs and removes the push-token refresh listener', () => {
  assert.match(pushRegistration, /export async function attachPushTokenRefreshListener/);
  assert.match(pushRegistration, /addPushTokenListener/);
  assert.match(rootLayout, /attachPushTokenRefreshListener\(\)/);
  assert.match(rootLayout, /removeListener\?\.\(\)/);
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

function notificationsCardSource() {
  const card = permissionsStep.slice(permissionsStep.indexOf('{/* Notifications'));
  // Strip JSX/line comments first: prose explaining which gates the card must
  // NOT carry legitimately names those very gates. Only executable code is
  // evidence of a gate.
  return card
    .slice(0, card.indexOf('/>') + 2)
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\/.*$/gm, '');
}

test('§22: the Notifications card carries no ad-hoc environment or entitlement gate', () => {
  // TEST-FLIP (Android Repair 05). The old expectation was "no gate at all".
  // That is no longer the truth and should not be: a build that ships nothing
  // able to send a push must not offer a live permission CTA. What the card
  // must never grow is a SECOND, ad-hoc authority — a raw env read, a remote
  // config lookup, an entitlement check — competing with the canonical one.
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
    'SMART_WATCHLIST_V1',
    'Platform.OS',
  ]) {
    assert.ok(
      !notificationsCardSource().includes(token),
      `Notifications card must not reference "${token}" — the capability decision has one home`,
    );
  }
});

test('§22: the Notifications card is never hidden, only made non-requesting', () => {
  // The education surface stays four cards in every state (PERM-REG-001).
  // Repair 05 changes actionability, never visibility.
  assert.match(permissionsStep, /title="Notifications"/);
  const card = notificationsCardSource();
  assert.doesNotMatch(card, /return null/);
  assert.doesNotMatch(
    permissionsStep,
    /remotePushAllowed \? \(?\s*<PermissionCard/,
    'the card must not be conditionally rendered away',
  );
  assert.doesNotMatch(
    permissionsStep,
    /\{remotePushAllowed && \s*\n?\s*<PermissionCard/,
    'the card must not be conditionally rendered away',
  );
});

// ─── §2: already-approved non-notification work preserved ───────────────────

test('§2: affirmative AI consent and AI_PROCESSING_VERSION are preserved', () => {
  assert.match(read('constants/legal.ts'), /AI_PROCESSING_VERSION/);
  const onboarding = read('app/onboarding/index.tsx');
  assert.match(onboarding, /onboarding-ai-consent-checkbox/);
  assert.match(onboarding, /onboarding-ai-processing-statement/);
  assert.match(onboarding, /aiProcessingVersion: AI_PROCESSING_VERSION/);
});
