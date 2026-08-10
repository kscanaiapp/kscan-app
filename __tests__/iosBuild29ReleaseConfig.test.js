/**
 * iOS Build 29 App Store release configuration guard.
 *
 * The Build 28 IPA audit found three configuration-level defects that only a
 * replacement archive can close. Two of them (IOS28-IPA-002, IOS28-IPA-003)
 * live entirely in app.json, and neither is visible in any runtime test —
 * they only appear once `expo prebuild` has run the config plugins. This file
 * is the source-level gate that keeps them closed.
 *
 * IOS28-IPA-002  the app-owned PrivacyInfo.xcprivacy declared only three data
 *                types while the app collects nine categories.
 * IOS28-IPA-003  expo-location's config plugin seeds ALL THREE iOS location
 *                purpose strings with a generic default. app.json overrode
 *                only the When-In-Use one, so Build 28 shipped two
 *                Always-location strings for authorization the app never
 *                requests.
 *
 * It also pins the release identity, because `eas.json` uses
 * `appVersionSource: "remote"` — under remote versioning EAS ignores
 * `ios.buildNumber` entirely. That is exactly how Build 28 shipped from a
 * tree whose app.json still said "26". Keeping the source value truthful
 * costs nothing and removes the landmine: if anyone ever flips
 * appVersionSource back to "local", a stale low number would produce an
 * archive App Store Connect rejects.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));

const expo = appJson.expo;
const ios = expo.ios;

const PRODUCTION_SUPABASE_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_SUPABASE_REF = 'yzqjvdfgefveprobvvyw';

/** Locate a plugin entry by module name, whether bare or `[name, options]`. */
function pluginOptions(name) {
  const entry = (expo.plugins || []).find(
    (p) => p === name || (Array.isArray(p) && p[0] === name),
  );
  assert.ok(entry, `app.json must declare the ${name} config plugin`);
  return Array.isArray(entry) ? (entry[1] ?? {}) : {};
}

test('release identity: the next archive is K Scan AI 1.0.1 (29) for com.kscanai.app', () => {
  assert.equal(expo.version, '1.0.1');
  assert.equal(ios.buildNumber, '29');
  assert.equal(ios.bundleIdentifier, 'com.kscanai.app');
});

test('release identity: the iOS line does not carry the Android release versionCode', () => {
  // The iOS and Android app.json lines diverge on purpose. Android Build 28
  // ships versionCode 28 from its own branch; this line has never been the
  // Android release source and must not start bumping it, or an iOS
  // remediation would silently mint an Android build number.
  assert.equal(expo.android.versionCode, 23);
});

test('IOS28-IPA-003: expo-location declares only the When-In-Use purpose string', () => {
  const options = pluginOptions('expo-location');

  assert.equal(
    typeof options.locationWhenInUsePermission,
    'string',
    'the justified foreground purpose string must stay',
  );
  assert.match(options.locationWhenInUsePermission, /weather/i);

  // `false` is what deletes the key: @expo/config-plugins applyPermissions()
  // removes any permission whose value is exactly false, and otherwise falls
  // back to the plugin's generic default. Omitting these is not equivalent.
  assert.equal(
    options.locationAlwaysPermission,
    false,
    'Always-location must be deleted, not defaulted',
  );
  assert.equal(
    options.locationAlwaysAndWhenInUsePermission,
    false,
    'Always-and-When-In-Use location must be deleted, not defaulted',
  );

  assert.equal(options.isIosBackgroundLocationEnabled, false);
  assert.equal(options.isAndroidBackgroundLocationEnabled, false);
});

test('IOS28-IPA-003: the app never requests Always or background location', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'services/weather/weatherStylingContext.ts'),
    'utf8',
  );
  assert.match(source, /requestForegroundPermissionsAsync/);
  assert.doesNotMatch(
    source,
    /requestBackgroundPermissionsAsync|startLocationUpdatesAsync|requestAlwaysAuthorization/,
    'weather styling is foreground-only; a background call would make the removed strings required again',
  );
});

test('no microphone permission is introduced by any media plugin', () => {
  assert.equal(pluginOptions('expo-camera').microphonePermission, false);
  assert.equal(pluginOptions('expo-audio').microphonePermission, false);
  assert.ok(
    !Object.keys(ios.infoPlist).some((k) => k.startsWith('NSMicrophone')),
    'no microphone purpose string may appear in the iOS Info.plist',
  );
});

test('Apple release posture: Sign in with Apple and the associated domain are configured', () => {
  assert.equal(ios.usesAppleSignIn, true);
  assert.deepEqual(ios.associatedDomains, ['applinks:kscan.app']);
  assert.equal(ios.supportsTablet, true, 'iPad support is deliberate; UIDeviceFamily [1,2] is intended');
  assert.equal(ios.infoPlist.ITSAppUsesNonExemptEncryption, false);
});

test('no App Tracking Transparency prompt is declared', () => {
  assert.ok(
    !('NSUserTrackingUsageDescription' in ios.infoPlist),
    'the app performs no tracking, so it must not declare an ATT purpose string',
  );
});

// ── IOS28-IPA-002 — privacy manifest ────────────────────────────────────────

// Every value Apple accepts for NSPrivacyCollectedDataType. Anything outside
// this set is silently ignored by App Store Connect, which is worse than a
// missing declaration because it looks correct in source.
const APPLE_DATA_TYPES = new Set([
  'NSPrivacyCollectedDataTypeName',
  'NSPrivacyCollectedDataTypeEmailAddress',
  'NSPrivacyCollectedDataTypePhoneNumber',
  'NSPrivacyCollectedDataTypePhysicalAddress',
  'NSPrivacyCollectedDataTypeOtherUserContactInfo',
  'NSPrivacyCollectedDataTypeHealth',
  'NSPrivacyCollectedDataTypeFitness',
  'NSPrivacyCollectedDataTypePaymentInfo',
  'NSPrivacyCollectedDataTypeCreditInfo',
  'NSPrivacyCollectedDataTypeOtherFinancialInfo',
  'NSPrivacyCollectedDataTypePreciseLocation',
  'NSPrivacyCollectedDataTypeCoarseLocation',
  'NSPrivacyCollectedDataTypeSensitiveInfo',
  'NSPrivacyCollectedDataTypeContacts',
  'NSPrivacyCollectedDataTypeEmailsOrTextMessages',
  'NSPrivacyCollectedDataTypePhotosorVideos',
  'NSPrivacyCollectedDataTypeAudioData',
  'NSPrivacyCollectedDataTypeGameplayContent',
  'NSPrivacyCollectedDataTypeCustomerSupport',
  'NSPrivacyCollectedDataTypeOtherUserContent',
  'NSPrivacyCollectedDataTypeBrowsingHistory',
  'NSPrivacyCollectedDataTypeSearchHistory',
  'NSPrivacyCollectedDataTypeUserID',
  'NSPrivacyCollectedDataTypeDeviceID',
  'NSPrivacyCollectedDataTypePurchaseHistory',
  'NSPrivacyCollectedDataTypeProductInteraction',
  'NSPrivacyCollectedDataTypeAdvertisingData',
  'NSPrivacyCollectedDataTypeOtherUsageData',
  'NSPrivacyCollectedDataTypeCrashData',
  'NSPrivacyCollectedDataTypePerformanceData',
  'NSPrivacyCollectedDataTypeOtherDiagnosticData',
  'NSPrivacyCollectedDataTypeOtherDataTypes',
]);

const APPLE_PURPOSES = new Set([
  'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
  'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
  'NSPrivacyCollectedDataTypePurposeAnalytics',
  'NSPrivacyCollectedDataTypePurposeProductPersonalization',
  'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  'NSPrivacyCollectedDataTypePurposeOther',
]);

/**
 * The inventory the Build 29 manifest must state, and the production storage
 * that makes each one true. Anything added to this list needs a real write
 * path; anything removed needs that write path gone.
 */
const EXPECTED_INVENTORY = {
  // Apple Sign In requests FULL_NAME; email sign-up collects a full name; the
  // Google provider returns one. All land in auth.users.raw_user_meta_data.
  NSPrivacyCollectedDataTypeName: { linked: true, purposes: ['AppFunctionality'] },
  // profiles.email
  NSPrivacyCollectedDataTypeEmailAddress: { linked: true, purposes: ['AppFunctionality'] },
  // profiles.id and the user_id on every owned row
  NSPrivacyCollectedDataTypeUserID: { linked: true, purposes: ['AppFunctionality'] },
  // saved_scans / inspiration_items / dressing_room_items storage objects
  NSPrivacyCollectedDataTypePhotosorVideos: { linked: true, purposes: ['AppFunctionality'] },
  // style_chat_messages.content, dressing_room_messages.body, item and care
  // notes, look descriptions, content_reports.notes. style_memory_events
  // derives personalization signals from the same content.
  NSPrivacyCollectedDataTypeOtherUserContent: {
    linked: true,
    purposes: ['AppFunctionality', 'ProductPersonalization'],
  },
  // scan_intelligence_events.commerce_query / .search_queries, stored with user_id
  NSPrivacyCollectedDataTypeSearchHistory: {
    linked: true,
    purposes: ['AppFunctionality', 'Analytics'],
  },
  // wardrobe_* activity, wear events, wishlist intents, reactions, votes,
  // ratings, and the per-user daily usage counters that enforce quotas
  NSPrivacyCollectedDataTypeProductInteraction: {
    linked: true,
    purposes: ['AppFunctionality', 'Analytics'],
  },
  // Optional foreground fix, rounded to one decimal (~11 km) before it leaves
  // the device, sent to the Edge Function for weather. No table stores it, so
  // it is declared on the strength of the transmission, which is authenticated.
  NSPrivacyCollectedDataTypeCoarseLocation: { linked: true, purposes: ['AppFunctionality'] },
  // scan_commerce_events / llm_routing_events: latency, failure reason, app
  // version and platform. Neither table has a user_id column.
  NSPrivacyCollectedDataTypePerformanceData: { linked: false, purposes: ['Analytics'] },
};

test('IOS28-IPA-002: the privacy manifest declares no tracking', () => {
  const manifest = ios.privacyManifests;
  assert.ok(manifest, 'app.json must own the root PrivacyInfo.xcprivacy');
  assert.equal(manifest.NSPrivacyTracking, false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);

  for (const entry of manifest.NSPrivacyCollectedDataTypes) {
    assert.equal(
      entry.NSPrivacyCollectedDataTypeTracking,
      false,
      `${entry.NSPrivacyCollectedDataType} must not be marked as tracking`,
    );
    assert.ok(
      !entry.NSPrivacyCollectedDataTypePurposes.some((p) => p.includes('Advertising')),
      'the app ships no advertising SDK, so no advertising purpose is truthful',
    );
  }
});

test('IOS28-IPA-002: the declared inventory matches what the app actually stores', () => {
  const declared = ios.privacyManifests.NSPrivacyCollectedDataTypes;
  const seen = new Set();

  for (const entry of declared) {
    const type = entry.NSPrivacyCollectedDataType;
    assert.ok(APPLE_DATA_TYPES.has(type), `${type} is not an Apple-supported data type`);
    assert.ok(!seen.has(type), `${type} is declared more than once`);
    seen.add(type);

    const expected = EXPECTED_INVENTORY[type];
    assert.ok(expected, `${type} is declared with no documented collection path`);

    assert.equal(
      entry.NSPrivacyCollectedDataTypeLinked,
      expected.linked,
      `${type} linked-to-user status must match the retained record`,
    );

    for (const purpose of entry.NSPrivacyCollectedDataTypePurposes) {
      assert.ok(APPLE_PURPOSES.has(purpose), `${purpose} is not an Apple-supported purpose`);
    }
    assert.deepEqual(
      entry.NSPrivacyCollectedDataTypePurposes,
      expected.purposes.map((p) => `NSPrivacyCollectedDataTypePurpose${p}`),
      `${type} purposes must match its documented use`,
    );
  }

  assert.deepEqual(
    [...seen].sort(),
    Object.keys(EXPECTED_INVENTORY).sort(),
    'every category the app collects must be declared, and nothing it does not',
  );
});

test('IOS28-IPA-002: the required-reason API declarations survive', () => {
  const apis = ios.privacyManifests.NSPrivacyAccessedAPITypes;
  const byType = Object.fromEntries(
    apis.map((a) => [a.NSPrivacyAccessedAPIType, a.NSPrivacyAccessedAPITypeReasons]),
  );
  assert.deepEqual(byType.NSPrivacyAccessedAPICategoryUserDefaults, ['CA92.1']);
  assert.deepEqual(byType.NSPrivacyAccessedAPICategoryFileTimestamp, ['C617.1']);
});

// ── backend configuration ───────────────────────────────────────────────────

test('every EAS profile points at the production Supabase project', () => {
  const profiles = Object.entries(easJson.build);
  assert.ok(profiles.length > 0);
  for (const [name, profile] of profiles) {
    const url = (profile.env || {}).EXPO_PUBLIC_SUPABASE_URL;
    assert.ok(url, `profile ${name} must pin an explicit Supabase URL`);
    assert.ok(url.includes(PRODUCTION_SUPABASE_REF), `profile ${name} must use production Supabase`);
  }
});

test('the staging Supabase project is absent from the release configuration', () => {
  for (const file of ['app.json', 'eas.json']) {
    const raw = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.ok(
      !raw.includes(STAGING_SUPABASE_REF),
      `${file} must not reference the staging Supabase project`,
    );
  }
});

test('EAS owns the archive build number, and the production profile increments it', () => {
  // Documented so the "app.json says 26 but the IPA says 28" surprise that
  // opened this audit cannot repeat as an unexplained finding.
  assert.equal(easJson.cli.appVersionSource, 'remote');
  assert.equal(easJson.build.production.autoIncrement, true);
  assert.equal(easJson.build.production.distribution, 'store');
  assert.equal(easJson.build.production.ios.buildConfiguration, 'Release');
});
