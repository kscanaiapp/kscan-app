const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const { hasReviewInfo, verify } = require('../scripts/verify-apple-readiness');

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
