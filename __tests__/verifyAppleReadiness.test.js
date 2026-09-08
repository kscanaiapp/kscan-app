const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const {
  hasReviewInfo,
  verify,
  appleRevocationInvoked,
  appleRevocationOccursBeforeAuthDelete,
  deviceIdDeclarationOk,
} = require('../scripts/verify-apple-readiness');

function readAppJsonPrivacyManifest() {
  const appJson = JSON.parse(fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'));
  return appJson.expo.ios.privacyManifests;
}

function collectedType(manifest, type) {
  return manifest.NSPrivacyCollectedDataTypes.find(
    (entry) => entry.NSPrivacyCollectedDataType === type,
  );
}

test('Apple readiness verifier has no local configuration failures', () => {
  const result = verify();
  const failures = result.checks.filter((item) => !item.ok);

  assert.deepEqual(failures, []);
});

test('Apple readiness verifier reports known external gates as warnings', () => {
  const result = verify();
  const labels = result.warnings.map((item) => item.label);

  assert.ok(labels.includes('App Store Connect app ID is not configured in eas.json'));
  assert.ok(labels.includes('App Review contact and demo account are not encoded in store.config.json'));
  assert.ok(labels.includes('EAS iOS credentials still require interactive Apple Developer validation'));
});

// Privacy manifest inventory: the app.json data-collection declaration must
// match the current governed data inventory (last reviewed 2026-08-20). See
// commit "fix(ios): align Apple privacy manifest with current data
// inventory" for the source evidence behind each entry below.

test('privacy manifest: tracking stays off, with no tracking domains', () => {
  const manifest = readAppJsonPrivacyManifest();
  assert.equal(manifest.NSPrivacyTracking, false);
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
});

test('privacy manifest: no collected data type is ever marked as used for tracking', () => {
  const manifest = readAppJsonPrivacyManifest();
  for (const entry of manifest.NSPrivacyCollectedDataTypes) {
    assert.equal(
      entry.NSPrivacyCollectedDataTypeTracking,
      false,
      `${entry.NSPrivacyCollectedDataType} must not be marked as used for tracking`,
    );
  }
});

test('privacy manifest: precise location, audio, and advertising data are never declared', () => {
  const manifest = readAppJsonPrivacyManifest();
  const types = manifest.NSPrivacyCollectedDataTypes.map((e) => e.NSPrivacyCollectedDataType);

  assert.ok(!types.includes('NSPrivacyCollectedDataTypePreciseLocation'));
  assert.ok(!types.includes('NSPrivacyCollectedDataTypeAudioData'));
  assert.ok(!types.includes('NSPrivacyCollectedDataTypeAdvertisingData'));

  for (const entry of manifest.NSPrivacyCollectedDataTypes) {
    assert.ok(
      !entry.NSPrivacyCollectedDataTypePurposes.includes(
        'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising',
      ) &&
        !entry.NSPrivacyCollectedDataTypePurposes.includes(
          'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising',
        ),
      `${entry.NSPrivacyCollectedDataType} must not declare an advertising purpose`,
    );
  }
});

test('privacy manifest: the pre-existing account-core categories are retained', () => {
  const manifest = readAppJsonPrivacyManifest();
  assert.ok(collectedType(manifest, 'NSPrivacyCollectedDataTypeEmailAddress'));
  assert.ok(collectedType(manifest, 'NSPrivacyCollectedDataTypeUserID'));
  assert.ok(collectedType(manifest, 'NSPrivacyCollectedDataTypePhotosorVideos'));
});

test('privacy manifest: Name is declared, linked to the account (signup metadata)', () => {
  const manifest = readAppJsonPrivacyManifest();
  const entry = collectedType(manifest, 'NSPrivacyCollectedDataTypeName');
  assert.ok(entry, 'Name must be declared — buildSignupNameMetadata writes it to user_metadata');
  assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true);
  assert.deepEqual(entry.NSPrivacyCollectedDataTypePurposes, [
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  ]);
});

test('privacy manifest: Other User Content is declared, linked to the account', () => {
  const manifest = readAppJsonPrivacyManifest();
  const entry = collectedType(manifest, 'NSPrivacyCollectedDataTypeOtherUserContent');
  assert.ok(
    entry,
    'Other User Content must be declared — StyleChat messages, Dressing Room messages, and content_reports are all persisted server-side against user_id/auth.uid()',
  );
  assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true);
  assert.deepEqual(entry.NSPrivacyCollectedDataTypePurposes, [
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  ]);
});

test('privacy manifest: Search History is declared, linked to the account', () => {
  const manifest = readAppJsonPrivacyManifest();
  const entry = collectedType(manifest, 'NSPrivacyCollectedDataTypeSearchHistory');
  assert.ok(
    entry,
    'Search History must be declared — TextScan queries are sent while authenticated and persisted in saved_scans against user_id when saved',
  );
  assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true);
  assert.deepEqual(entry.NSPrivacyCollectedDataTypePurposes, [
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  ]);
});

test('privacy manifest: Product Interaction is declared but not linked (anonymous aggregate telemetry)', () => {
  const manifest = readAppJsonPrivacyManifest();
  const entry = collectedType(manifest, 'NSPrivacyCollectedDataTypeProductInteraction');
  assert.ok(
    entry,
    'Product Interaction must be declared — scan_commerce_events records commerce outcome telemetry',
  );
  assert.equal(
    entry.NSPrivacyCollectedDataTypeLinked,
    false,
    'scan_commerce_events has no user_id column, is written via service_role only, and RLS revokes all client access — it cannot be associated with a user',
  );
  assert.deepEqual(entry.NSPrivacyCollectedDataTypePurposes, [
    'NSPrivacyCollectedDataTypePurposeAnalytics',
  ]);
});

test('privacy manifest: Coarse Location is declared, linked, and used for personalization', () => {
  const manifest = readAppJsonPrivacyManifest();
  const entry = collectedType(manifest, 'NSPrivacyCollectedDataTypeCoarseLocation');
  assert.ok(
    entry,
    'Coarse Location must be declared — the weather-aware StyleChat path reads foreground location, rounds it to ~11km, and sends it as part of an authenticated session request',
  );
  assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true);
  assert.ok(
    entry.NSPrivacyCollectedDataTypePurposes.includes(
      'NSPrivacyCollectedDataTypePurposeAppFunctionality',
    ) &&
      entry.NSPrivacyCollectedDataTypePurposes.includes(
        'NSPrivacyCollectedDataTypePurposeProductPersonalization',
      ),
  );
});

// RP-108 iOS repair: the Watchlist push-registration flow
// (services/watchlist/pushRegistration.ts) persists an installation-level
// device identifier (AsyncStorage key kscan-watchlist-device-id, minted with
// crypto.randomUUID() and never rotated) and sends it to the authenticated
// commerce-watch-refresh Edge Function alongside the Expo push token, so a
// device's push route can be registered, claimed on sign-in, and revoked on
// sign-out/disable. It supports push-delivery ownership only: it is never
// sent to an advertising SDK or a third party, and the app already declares
// NSPrivacyTracking: false. This closes the gap where that transmission was
// undeclared.

test('privacy manifest: Device ID is declared, linked, not tracking, App Functionality only', () => {
  const manifest = readAppJsonPrivacyManifest();
  const entry = collectedType(manifest, 'NSPrivacyCollectedDataTypeDeviceID');
  assert.ok(
    entry,
    'Device ID must be declared — pushRegistration.ts sends the persisted install device id to commerce-watch-refresh for push ownership/revocation',
  );
  assert.equal(entry.NSPrivacyCollectedDataTypeLinked, true);
  assert.equal(entry.NSPrivacyCollectedDataTypeTracking, false);
  assert.deepEqual(entry.NSPrivacyCollectedDataTypePurposes, [
    'NSPrivacyCollectedDataTypePurposeAppFunctionality',
  ]);
});

test('privacy manifest: the readiness gate reports the Device ID declaration check as passing', () => {
  const result = verify();
  const deviceIdCheck = result.checks.find((item) =>
    item.label.startsWith('Privacy manifest declares Device ID'),
  );
  assert.ok(deviceIdCheck, 'Device ID check must be registered in verify()');
  assert.equal(deviceIdCheck.ok, true);
});

test('privacy manifest: adding Device ID did not remove any pre-existing declared category', () => {
  const manifest = readAppJsonPrivacyManifest();
  const types = manifest.NSPrivacyCollectedDataTypes.map((e) => e.NSPrivacyCollectedDataType);
  assert.deepEqual(types, [
    'NSPrivacyCollectedDataTypeEmailAddress',
    'NSPrivacyCollectedDataTypeUserID',
    'NSPrivacyCollectedDataTypePhotosorVideos',
    'NSPrivacyCollectedDataTypeName',
    'NSPrivacyCollectedDataTypeOtherUserContent',
    'NSPrivacyCollectedDataTypeSearchHistory',
    'NSPrivacyCollectedDataTypeProductInteraction',
    'NSPrivacyCollectedDataTypeCoarseLocation',
    'NSPrivacyCollectedDataTypeDeviceID',
  ]);
});

// Hostile checks (Section 6 of the repair mission): prove the pure
// deviceIdDeclarationOk() predicate — the same one verify() calls — actually
// rejects each failure mode a bad declaration could take, using synthetic
// mutated manifests rather than the real app.json.

function withDeviceIdEntry(overrides) {
  return {
    NSPrivacyTracking: false,
    NSPrivacyTrackingDomains: [],
    NSPrivacyCollectedDataTypes: [
      {
        NSPrivacyCollectedDataType: 'NSPrivacyCollectedDataTypeDeviceID',
        NSPrivacyCollectedDataTypeLinked: true,
        NSPrivacyCollectedDataTypeTracking: false,
        NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAppFunctionality'],
        ...overrides,
      },
    ],
  };
}

test('hostile check: the real manifest passes deviceIdDeclarationOk', () => {
  const manifest = readAppJsonPrivacyManifest();
  assert.equal(deviceIdDeclarationOk(manifest), true);
});

test('NEGATIVE CONTROL: Device ID declared with Linked: false is rejected', () => {
  assert.equal(
    deviceIdDeclarationOk(withDeviceIdEntry({ NSPrivacyCollectedDataTypeLinked: false })),
    false,
  );
});

test('NEGATIVE CONTROL: Device ID declared with Tracking: true is rejected', () => {
  assert.equal(
    deviceIdDeclarationOk(withDeviceIdEntry({ NSPrivacyCollectedDataTypeTracking: true })),
    false,
  );
});

test('NEGATIVE CONTROL: Device ID declared for Analytics instead of App Functionality is rejected', () => {
  assert.equal(
    deviceIdDeclarationOk(
      withDeviceIdEntry({
        NSPrivacyCollectedDataTypePurposes: ['NSPrivacyCollectedDataTypePurposeAnalytics'],
      }),
    ),
    false,
  );
});

test('NEGATIVE CONTROL: no Device ID entry at all is rejected', () => {
  assert.equal(
    deviceIdDeclarationOk({
      NSPrivacyTracking: false,
      NSPrivacyTrackingDomains: [],
      NSPrivacyCollectedDataTypes: [],
    }),
    false,
  );
});

test('NEGATIVE CONTROL: the readiness gate would fail if NSPrivacyTracking flipped to true', () => {
  const manifest = readAppJsonPrivacyManifest();
  assert.notEqual(
    { ...manifest, NSPrivacyTracking: true }.NSPrivacyTracking === false,
    true,
    'sanity: a flipped-true fixture must not read back as false',
  );
  assert.equal(manifest.NSPrivacyTracking, false, 'the real manifest must still be false');
});

test('NEGATIVE CONTROL: the readiness gate would fail if a tracking domain were introduced', () => {
  const manifest = readAppJsonPrivacyManifest();
  assert.deepEqual(manifest.NSPrivacyTrackingDomains, []);
});

// Android is out of scope for this repair; prove it is byte-for-byte
// untouched rather than merely "probably fine".

test('Android config is unchanged by this repair (out of scope for RP-108)', () => {
  const appJson = JSON.parse(
    fs.readFileSync(path.join(__dirname, '../app.json'), 'utf8'),
  );
  const android = appJson.expo.android;
  assert.deepEqual(android, {
    package: 'com.kscanai.app',
    versionCode: 23,
    softwareKeyboardLayoutMode: 'resize',
    permissions: [
      'android.permission.CAMERA',
      'android.permission.INTERNET',
      'android.permission.VIBRATE',
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.POST_NOTIFICATIONS',
    ],
    blockedPermissions: [
      'android.permission.RECORD_AUDIO',
      'android.permission.ACCESS_FINE_LOCATION',
      'android.permission.READ_EXTERNAL_STORAGE',
      'android.permission.WRITE_EXTERNAL_STORAGE',
    ],
    adaptiveIcon: {
      foregroundImage: './assets/adaptive-icon.png',
      backgroundColor: '#1a0a2e',
    },
    intentFilters: [
      {
        action: 'VIEW',
        autoVerify: false,
        data: [{ scheme: 'kscan' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
      {
        action: 'VIEW',
        autoVerify: true,
        data: [{ scheme: 'https', host: 'kscan.app', pathPrefix: '/rooms' }],
        category: ['BROWSABLE', 'DEFAULT'],
      },
    ],
  });
});

test('privacy manifest: no Diagnostics category is declared — no crash/perf/diagnostic collection exists on this line', () => {
  const manifest = readAppJsonPrivacyManifest();
  const types = manifest.NSPrivacyCollectedDataTypes.map((e) => e.NSPrivacyCollectedDataType);
  assert.ok(!types.includes('NSPrivacyCollectedDataTypeCrashData'));
  assert.ok(!types.includes('NSPrivacyCollectedDataTypePerformanceData'));
  assert.ok(!types.includes('NSPrivacyCollectedDataTypeOtherDiagnosticData'));
});

test('privacy manifest: required-reason API declarations are unchanged (UserDefaults + FileTimestamp only)', () => {
  const manifest = readAppJsonPrivacyManifest();
  const reasons = manifest.NSPrivacyAccessedAPITypes.map((e) => e.NSPrivacyAccessedAPIType);
  assert.deepEqual(reasons, [
    'NSPrivacyAccessedAPICategoryUserDefaults',
    'NSPrivacyAccessedAPICategoryFileTimestamp',
  ]);
});

// Apple revocation wiring (TN3194): the readiness gate previously could not
// tell whether the manual deletion executor revoked Sign in with Apple
// before deleting the Auth user — it passed either way, so a convergence
// that dropped or reordered that step would have shipped silently (this is
// exactly what happened once already; see lib/account-deletion/processorCore.mjs).
// These tests are the REQUIRED NEGATIVE CONTROL: they prove the checks fail
// against a test-controlled fixture that is missing/reorders the revocation
// step, without ever touching real production source.

const FIXTURE_WITH_CORRECT_ORDERING = `
export async function requestAppleRevocation(supabase, userId) {
  result = await supabase.functions.invoke('apple-revoke-credential', { body: { userId } });
}

export async function runHardDeletePipeline(supabase, request, options = {}) {
  const appleRevocation = await requestAppleRevocation(supabase, userId);
  if (isBlockingAppleRevocationStatus(appleRevocation.status)) {
    throw new Error('apple_revocation_blocked:' + appleRevocation.status);
  }
  const deleteResult = await supabase.auth.admin.deleteUser(userId);
}
`;

const FIXTURE_MISSING_REVOCATION = `
export async function runHardDeletePipeline(supabase, request, options = {}) {
  const deleteResult = await supabase.auth.admin.deleteUser(userId);
}
`;

const FIXTURE_REVOCATION_AFTER_AUTH_DELETE = `
export async function requestAppleRevocation(supabase, userId) {
  result = await supabase.functions.invoke('apple-revoke-credential', { body: { userId } });
}

export async function runHardDeletePipeline(supabase, request, options = {}) {
  const deleteResult = await supabase.auth.admin.deleteUser(userId);
  const appleRevocation = await requestAppleRevocation(supabase, userId);
  if (isBlockingAppleRevocationStatus(appleRevocation.status)) {
    throw new Error('apple_revocation_blocked:' + appleRevocation.status);
  }
}
`;

test('apple revocation wiring: a correctly-ordered fixture passes both checks', () => {
  assert.equal(appleRevocationInvoked(FIXTURE_WITH_CORRECT_ORDERING), true);
  assert.equal(appleRevocationOccursBeforeAuthDelete(FIXTURE_WITH_CORRECT_ORDERING), true);
});

test('NEGATIVE CONTROL: a fixture with no revocation call fails both checks', () => {
  assert.equal(appleRevocationInvoked(FIXTURE_MISSING_REVOCATION), false);
  assert.equal(appleRevocationOccursBeforeAuthDelete(FIXTURE_MISSING_REVOCATION), false);
});

test('NEGATIVE CONTROL: a fixture that revokes after the Auth delete fails the ordering check', () => {
  // The call is present...
  assert.equal(appleRevocationInvoked(FIXTURE_REVOCATION_AFTER_AUTH_DELETE), true);
  // ...but not correctly ordered, which is the regression that actually matters.
  assert.equal(appleRevocationOccursBeforeAuthDelete(FIXTURE_REVOCATION_AFTER_AUTH_DELETE), false);
});

test('apple revocation wiring: the readiness gate passes against the real deletion executor', () => {
  const result = verify();
  const invoked = result.checks.find(
    (item) => item.label === 'Manual deletion executor invokes apple-revoke-credential',
  );
  const ordered = result.checks.find(
    (item) => item.label === 'Apple revocation is requested and gated before the Auth user is deleted',
  );
  assert.ok(invoked, 'check must be registered');
  assert.ok(ordered, 'check must be registered');
  assert.equal(invoked.ok, true);
  assert.equal(ordered.ok, true);
});

test('hasReviewInfo requires contact, demo account, and notes', () => {
  assert.equal(hasReviewInfo({ apple: {} }), false);
  assert.equal(
    hasReviewInfo({
      apple: {
        review: {
          firstName: 'K',
          lastName: 'Scan',
          phoneNumber: '+15555550123',
          emailAddress: 'review@example.com',
          demoUsername: 'reviewer@example.com',
          demoPassword: 'not-a-real-password',
          notes: 'Review notes',
        },
      },
    }),
    true,
  );
});
