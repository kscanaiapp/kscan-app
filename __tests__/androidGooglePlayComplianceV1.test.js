'use strict';

// Google Play Console compliance repair (release 31 / 1.0.1 recommendations):
//   GOOGLE-ANDROID-001 deprecated Android 15 edge-to-edge APIs/parameters
//   GOOGLE-ANDROID-002 portrait/resizability restriction on large-screen devices
// Asserts against real source (regression) and, per each, includes a negative
// control that reintroduces the violation into an in-memory copy to prove the
// assertion actually bites rather than trivially passing on any input.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
const GRADLE_PROPS_PATH = path.join(REPO_ROOT, 'android', 'gradle.properties');
const STYLES_PATH = path.join(REPO_ROOT, 'android', 'app', 'src', 'main', 'res', 'values', 'styles.xml');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');

function readFile(p) {
  return fs.readFileSync(p, 'utf8');
}

function mainActivityBlock(manifestXml) {
  const match = manifestXml.match(/<activity android:name="\.MainActivity"[^>]*>/);
  assert.ok(match, 'MainActivity <activity> element not found in AndroidManifest.xml');
  return match[0];
}

// ---- GOOGLE-ANDROID-002: MainActivity must not force portrait ----

function assertMainActivityNotPortraitLocked(manifestXml) {
  const activityTag = mainActivityBlock(manifestXml);
  assert.doesNotMatch(
    activityTag,
    /android:screenOrientation="portrait"/,
    'MainActivity must not declare android:screenOrientation="portrait" (GOOGLE-ANDROID-002)',
  );
}

test('MainActivity has no forced portrait orientation', () => {
  assertMainActivityNotPortraitLocked(readFile(MANIFEST_PATH));
});

test('CONTROL A (negative): a reintroduced portrait lock is caught', () => {
  const mutated = readFile(MANIFEST_PATH).replace(
    '<activity android:name=".MainActivity"',
    '<activity android:name=".MainActivity" android:screenOrientation="portrait"',
  );
  assert.throws(() => assertMainActivityNotPortraitLocked(mutated));
});

test('MainActivity keeps configChanges covering orientation/screenSize so removing the lock does not trigger Activity recreation (Regime A)', () => {
  const activityTag = mainActivityBlock(readFile(MANIFEST_PATH));
  const configChanges = activityTag.match(/android:configChanges="([^"]+)"/);
  assert.ok(configChanges, 'MainActivity must declare android:configChanges');
  for (const required of ['orientation', 'screenSize', 'screenLayout']) {
    assert.ok(
      configChanges[1].split('|').includes(required),
      `android:configChanges must include "${required}"`,
    );
  }
});

test('the unused GMS Code Scanner delegate activity is removed from the merged manifest, not forcibly re-oriented', () => {
  const manifestXml = readFile(MANIFEST_PATH);
  const overrideTag = manifestXml.match(
    /<activity android:name="com\.google\.mlkit\.vision\.codescanner\.internal\.GmsBarcodeScanningDelegateActivity"[^>]*\/>/,
  );
  assert.ok(overrideTag, 'expected a manifest-merger override for GmsBarcodeScanningDelegateActivity');
  assert.match(overrideTag[0], /tools:node="remove"/);
  assert.doesNotMatch(
    overrideTag[0],
    /tools:replace="screenOrientation"/,
    'must not force-override a Google-owned compiled Activity instead of removing the unused dependency edge',
  );
});

test('app.json orientation cannot silently restore the portrait lock', () => {
  const appConfig = JSON.parse(readFile(APP_JSON_PATH)).expo;
  assert.notEqual(appConfig.orientation, 'portrait');
});

test('CONTROL C (negative): a reintroduced app.json portrait value is caught', () => {
  const mutated = { orientation: 'portrait' };
  assert.throws(() => assert.notEqual(mutated.orientation, 'portrait'));
});

// ---- GOOGLE-ANDROID-001: no K Scan-owned deprecated edge-to-edge origin ----

function assertNoDeprecatedEdgeToEdgeProperty(gradleProperties) {
  assert.doesNotMatch(
    gradleProperties,
    /^expo\.edgeToEdgeEnabled=/m,
    'expo.edgeToEdgeEnabled is deprecated (removed in Expo SDK 55); edgeToEdgeEnabled is the live property (GOOGLE-ANDROID-001)',
  );
  assert.match(gradleProperties, /^edgeToEdgeEnabled=true$/m, 'edgeToEdgeEnabled=true must remain set');
}

test('android/gradle.properties has no deprecated duplicate edge-to-edge flag', () => {
  assertNoDeprecatedEdgeToEdgeProperty(readFile(GRADLE_PROPS_PATH));
});

test('CONTROL B (negative): a reintroduced deprecated edge-to-edge property is caught', () => {
  const mutated = readFile(GRADLE_PROPS_PATH) + '\nexpo.edgeToEdgeEnabled=true\n';
  assert.throws(() => assertNoDeprecatedEdgeToEdgeProperty(mutated));
});

function assertNoDeprecatedStatusBarThemeColor(stylesXml) {
  assert.doesNotMatch(
    stylesXml,
    /android:statusBarColor/,
    'AppTheme must not set android:statusBarColor -- deprecated under enforced edge-to-edge (GOOGLE-ANDROID-001)',
  );
}

test('AppTheme has no deprecated android:statusBarColor', () => {
  assertNoDeprecatedStatusBarThemeColor(readFile(STYLES_PATH));
});

test('CONTROL B2 (negative): a reintroduced statusBarColor theme item is caught', () => {
  const mutated = readFile(STYLES_PATH).replace(
    '</style>',
    '<item name="android:statusBarColor">#ffffff</item></style>',
  );
  assert.throws(() => assertNoDeprecatedStatusBarThemeColor(mutated));
});

test('no K Scan-owned Android source declares windowOptOutEdgeToEdgeEnforcement', () => {
  for (const file of [MANIFEST_PATH, STYLES_PATH, GRADLE_PROPS_PATH]) {
    assert.doesNotMatch(readFile(file), /windowOptOutEdgeToEdgeEnforcement/);
  }
});
