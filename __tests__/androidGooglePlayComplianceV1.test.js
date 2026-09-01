'use strict';

// Google Play Console compliance repair (release 31 / 1.0.1 recommendations):
//   GOOGLE-ANDROID-001 deprecated Android 15 edge-to-edge APIs/parameters
//   GOOGLE-ANDROID-002 portrait/resizability restriction on large-screen devices
//   GOOGLE-ANDROID-003 permission posture, incl. the Build 34 Voice Scan
//                      certification microphone exception
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


// ── GOOGLE-ANDROID-003: permission posture (Build 34) ───────────────────────
//
// Voice Scan needs RECORD_AUDIO, but ONLY in the staging-certification AAB.
// Encoding that as "the app may now request the microphone" would be exactly
// the broadening this build is designed to avoid, so the accepted posture is
// stated per artifact:
//
//   default / production release  -> NO microphone permission at all
//   staging-certification release -> RECORD_AUDIO, just-in-time, foreground
//                                    only, no service, no background capture
//
// Everything else stays denied in BOTH, including the permission families
// Play treats as sensitive: foreground-service microphone, Bluetooth,
// contacts, SMS, call log, fine/background location, and broad storage/media.

const CERT_MANIFEST_PATH = path.join(
  REPO_ROOT, 'android', 'app', 'src', 'certification', 'AndroidManifest.xml',
);
const RELEASE_MANIFEST_PATH = path.join(
  REPO_ROOT, 'android', 'app', 'src', 'release', 'AndroidManifest.xml',
);

/** Comments describe what a manifest must NOT contain; only markup declares. */
function withoutComments(xml) {
  return xml.replace(/<!--[\s\S]*?-->/g, '');
}

/** Permissions a manifest actively grants (no tools:node="remove"). */
function grantedPermissions(xml) {
  return [...withoutComments(xml).matchAll(/<uses-permission([^>]*)\/>/g)]
    .filter((match) => !/tools:node="remove"/.test(match[1]))
    .map((match) => (match[1].match(/android:name="([^"]+)"/) || [])[1])
    .filter(Boolean);
}

// Permission families that must never be granted by ANY K Scan manifest.
// Matched as substrings so a variant (e.g. BLUETOOTH_ADVERTISE) is caught
// without having to enumerate every constant Android has ever shipped.
const FORBIDDEN_PERMISSION_PATTERNS = Object.freeze([
  'FOREGROUND_SERVICE_MICROPHONE',
  'CAPTURE_AUDIO_OUTPUT',
  'BLUETOOTH',
  'READ_CONTACTS',
  'WRITE_CONTACTS',
  'GET_ACCOUNTS',
  '_SMS',
  'CALL_LOG',
  'PROCESS_OUTGOING_CALLS',
  'CALL_PHONE',
  'ACCESS_FINE_LOCATION',
  'ACCESS_BACKGROUND_LOCATION',
  'READ_EXTERNAL_STORAGE',
  'WRITE_EXTERNAL_STORAGE',
  'MANAGE_EXTERNAL_STORAGE',
  'READ_MEDIA_',
  'AD_ID',
]);

function assertNoForbiddenPermissions(label, xml) {
  for (const permission of grantedPermissions(xml)) {
    for (const pattern of FORBIDDEN_PERMISSION_PATTERNS) {
      assert.ok(
        !permission.includes(pattern),
        `${label} grants "${permission}", which matches the forbidden family "${pattern}" (GOOGLE-ANDROID-003)`,
      );
    }
  }
}

test('the DEFAULT/production manifests request no microphone permission', () => {
  const main = withoutComments(readFile(MANIFEST_PATH));
  assert.match(
    main,
    /<uses-permission[^>]*android:name="android\.permission\.RECORD_AUDIO"[^>]*tools:node="remove"[^>]*\/>/,
    'src/main must keep RECORD_AUDIO removed -- this is what production ships',
  );
  assert.ok(
    !grantedPermissions(readFile(MANIFEST_PATH)).includes('android.permission.RECORD_AUDIO'),
    'src/main must never GRANT RECORD_AUDIO',
  );
  assert.ok(
    !grantedPermissions(readFile(RELEASE_MANIFEST_PATH)).includes('android.permission.RECORD_AUDIO'),
    'the default release manifest must never grant RECORD_AUDIO',
  );
});

test('CONTROL D (negative): a microphone grant in the default release manifest is caught', () => {
  const mutated = readFile(RELEASE_MANIFEST_PATH).replace(
    '</manifest>',
    '<uses-permission android:name="android.permission.RECORD_AUDIO"/>\n</manifest>',
  );
  assert.throws(() =>
    assert.ok(
      !grantedPermissions(mutated).includes('android.permission.RECORD_AUDIO'),
      'must reject a microphone grant in the default release manifest',
    ),
  );
});

test('app.json continues to declare the microphone BLOCKED, so no CNG surface reintroduces it', () => {
  const androidConfig = JSON.parse(readFile(APP_JSON_PATH)).expo.android;
  assert.ok(
    androidConfig.blockedPermissions.includes('android.permission.RECORD_AUDIO'),
    'RECORD_AUDIO must remain in app.json blockedPermissions',
  );
  assert.ok(
    !androidConfig.permissions.includes('android.permission.RECORD_AUDIO'),
    'RECORD_AUDIO must never be declared in app.json android.permissions',
  );
});

test('the audio plugins keep microphone capture disabled at the config layer', () => {
  // Build 34 lesson (project_build34_ios_voice_mic_permission): Expo's
  // `microphonePermission: false` DELETES the platform permission a plugin
  // would otherwise add. Voice Scan does not use expo-camera or expo-audio
  // capture at all -- it uses the dedicated on-device recognizer module --
  // so these must stay false, and Voice must not "fix" itself by flipping
  // them, which would grant the microphone to every profile.
  const plugins = JSON.parse(readFile(APP_JSON_PATH)).expo.plugins;
  for (const plugin of plugins) {
    if (!Array.isArray(plugin)) continue;
    const [name, options] = plugin;
    if (name !== 'expo-camera' && name !== 'expo-audio') continue;
    assert.equal(options.microphonePermission, false, `${name} must keep microphonePermission false`);
    assert.equal(options.recordAudioAndroid, false, `${name} must keep recordAudioAndroid false`);
  }
});

test('the certification manifest grants the microphone, and nothing else new', () => {
  const certificationXml = readFile(CERT_MANIFEST_PATH);
  const granted = grantedPermissions(certificationXml);
  assert.deepEqual(
    granted,
    ['android.permission.RECORD_AUDIO'],
    'the certification manifest may grant exactly one permission beyond the base manifest',
  );
});

test('no manifest -- default or certification -- grants a forbidden permission family', () => {
  assertNoForbiddenPermissions('src/main/AndroidManifest.xml', readFile(MANIFEST_PATH));
  assertNoForbiddenPermissions('src/release/AndroidManifest.xml', readFile(RELEASE_MANIFEST_PATH));
  assertNoForbiddenPermissions('src/certification/AndroidManifest.xml', readFile(CERT_MANIFEST_PATH));
});

test('CONTROL E (negative): a forbidden permission family is caught in every manifest checked', () => {
  for (const manifestPath of [MANIFEST_PATH, RELEASE_MANIFEST_PATH, CERT_MANIFEST_PATH]) {
    const mutated = readFile(manifestPath).replace(
      '</manifest>',
      '<uses-permission android:name="android.permission.BLUETOOTH_CONNECT"/>\n</manifest>',
    );
    assert.throws(
      () => assertNoForbiddenPermissions('fixture', mutated),
      `the forbidden-family check must bite on ${path.basename(path.dirname(manifestPath))}`,
    );
  }
});

test('no manifest declares a service, so there is no background-microphone surface at all', () => {
  // A foreground-service microphone needs BOTH the permission and a service
  // with foregroundServiceType="microphone". Neither exists; asserting the
  // absence of the service closes the half the permission check does not.
  for (const manifestPath of [MANIFEST_PATH, RELEASE_MANIFEST_PATH, CERT_MANIFEST_PATH]) {
    const xml = withoutComments(readFile(manifestPath));
    assert.doesNotMatch(xml, /<service[\s>]/, `${manifestPath} must declare no <service>`);
    assert.doesNotMatch(xml, /foregroundServiceType/, `${manifestPath} must declare no foregroundServiceType`);
  }
});

test('the Voice native module requests the microphone just-in-time and releases it on background', () => {
  // Source proof for the two behavioural claims the Data Safety declaration
  // and the Play permission review both rest on.
  const kotlin = readFile(
    path.join(REPO_ROOT, 'modules', 'kscan-voice-native', 'android', 'src', 'main',
      'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt'),
  );
  // JIT: permission is requested from an explicit API call, never at startup.
  assert.match(kotlin, /AsyncFunction\("requestPermissions"\)/);
  assert.doesNotMatch(kotlin, /OnCreate[\s\S]{0,400}askForPermissions/,
    'the microphone must never be requested during module creation');
  // Release on background, independent of any single Activity.
  assert.match(kotlin, /ProcessLifecycleOwner/);
  assert.match(kotlin, /override fun onStop\(owner: LifecycleOwner\) \{\s*teardownSession/);
  // The module's own manifest contributes no permission of its own.
  const moduleManifest = readFile(
    path.join(REPO_ROOT, 'modules', 'kscan-voice-native', 'android', 'src', 'main', 'AndroidManifest.xml'),
  );
  assert.doesNotMatch(moduleManifest, /uses-permission/,
    'the Voice module must not contribute a permission of its own -- the app manifest decides');
});

test('Voice Scan uses on-device recognition only: no cloud recognizer, no network fallback', () => {
  // This is the fact the Play Data Safety answer depends on. If it ever
  // stops being true, "audio is not collected" stops being true with it.
  const kotlin = readFile(
    path.join(REPO_ROOT, 'modules', 'kscan-voice-native', 'android', 'src', 'main',
      'java', 'expo', 'modules', 'kscanvoicenative', 'KScanVoiceNativeModule.kt'),
  );
  assert.match(kotlin, /createOnDeviceSpeechRecognizer/);
  assert.match(kotlin, /isOnDeviceRecognitionAvailable/);
  assert.match(kotlin, /EXTRA_PREFER_OFFLINE/);
  // createSpeechRecognizer( may use a cloud-backed engine -- it must not
  // appear except as part of createOnDeviceSpeechRecognizer(.
  const cloudCalls = (kotlin.match(/(?<!OnDevice)SpeechRecognizer\.createSpeechRecognizer\(/g) || []);
  assert.equal(cloudCalls.length, 0, 'no cloud-capable recognizer may be constructed');
});

test('CONTROL F (negative): a cloud recognizer would be caught', () => {
  const mutated = 'val r = SpeechRecognizer.createSpeechRecognizer(context)';
  const cloudCalls = (mutated.match(/(?<!OnDevice)SpeechRecognizer\.createSpeechRecognizer\(/g) || []);
  assert.equal(cloudCalls.length, 1, 'the cloud-recognizer detector must actually match one');
});

test('no raw microphone audio is logged or persisted anywhere in the Voice path', () => {
  const voiceSources = [
    path.join(REPO_ROOT, 'hooks', 'useVoiceScan.ts'),
    path.join(REPO_ROOT, 'services', 'voice', 'voiceTelemetry.ts'),
    path.join(REPO_ROOT, 'services', 'voice', 'voiceNativeModule.ts'),
    path.join(REPO_ROOT, 'services', 'voice', 'voiceTranscript.ts'),
  ];
  for (const file of voiceSources) {
    const source = readFile(file);
    assert.doesNotMatch(source, /AsyncStorage/, `${file} must not persist voice state`);
    assert.doesNotMatch(source, /SecureStore|FileSystem\.write/, `${file} must not write voice data to disk`);
  }
  // The telemetry allowlist cannot carry text: 'transcript' is not a
  // permitted property name, so a transcript passed by mistake is dropped.
  const telemetry = readFile(path.join(REPO_ROOT, 'services', 'voice', 'voiceTelemetry.ts'));
  const properties = telemetry.match(/VOICE_EVENT_PROPERTIES = \[([\s\S]*?)\]/);
  assert.ok(properties, 'the telemetry property allowlist must exist');
  assert.doesNotMatch(properties[1], /transcript|text|query|audio/i,
    'no content-bearing property may be allowlisted for voice telemetry');
});
