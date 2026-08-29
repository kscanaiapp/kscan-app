const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN = [
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'com.google.android.gms.permission.AD_ID',
];

const EXPECTED = [
  'android.permission.CAMERA',
  'android.permission.INTERNET',
  'android.permission.VIBRATE',
  'android.permission.ACCESS_COARSE_LOCATION',
  // Voice Scan V1 (Build 34): real, flag-gated on-device speech recognition
  // (VOICESCAN_ENABLED, default off, + K+). See modules/kscan-voice-native
  // and hooks/useVoiceScan.ts -- nothing requests this outside that path.
  'android.permission.RECORD_AUDIO',
];

test('config plugin registers expanded Android permission blocklist', () => {
  const plugin = fs.readFileSync(
    path.join(ROOT, 'plugins/withAndroidPermissionBlocklist.js'),
    'utf8',
  );
  assert.match(plugin, /withBlockedPermissions/);
  for (const permission of FORBIDDEN) {
    assert.match(plugin, new RegExp(permission.replace(/\./g, '\\.')));
  }
});

test('app.json wires plugin and mirrors blocked permissions', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  assert.ok(appJson.expo.plugins.includes('./plugins/withAndroidPermissionBlocklist'));
  for (const permission of EXPECTED) {
    assert.ok(appJson.expo.android.permissions.includes(permission));
  }
  for (const permission of FORBIDDEN) {
    assert.ok(appJson.expo.android.blockedPermissions.includes(permission));
    assert.ok(!appJson.expo.android.permissions.includes(permission));
  }
});

test('committed native manifests remove forbidden permissions', () => {
  const main = fs.readFileSync(
    path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'),
    'utf8',
  );
  const release = fs.readFileSync(
    path.join(ROOT, 'android/app/src/release/AndroidManifest.xml'),
    'utf8',
  );
  for (const permission of FORBIDDEN) {
    assert.match(main, new RegExp(`${permission.replace(/\./g, '\\.')}"\\s+tools:node="remove"`));
    assert.match(release, new RegExp(`${permission.replace(/\./g, '\\.')}"\\s+tools:node="remove"`));
  }
  for (const permission of EXPECTED) {
    assert.match(main, new RegExp(permission.replace(/\./g, '\\.')));
  }
});

test('image picker and audio plugins keep microphone disabled (Voice Scan uses its own native module, not these plugins)', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const camera = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-camera');
  const audio = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-audio');
  assert.equal(camera?.[1]?.microphonePermission, false);
  assert.equal(audio?.[1]?.microphonePermission, false);
  assert.equal(audio?.[1]?.recordAudioAndroid, false);
});

test('RECORD_AUDIO is declared normally (not stripped) in both the main and release manifests', () => {
  const main = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  const release = fs.readFileSync(path.join(ROOT, 'android/app/src/release/AndroidManifest.xml'), 'utf8');
  assert.match(main, /<uses-permission android:name="android\.permission\.RECORD_AUDIO"\/>/);
  assert.doesNotMatch(
    main,
    /android\.permission\.RECORD_AUDIO"\s+tools:node="remove"/,
    'RECORD_AUDIO must not be stripped from the main manifest',
  );
  assert.doesNotMatch(
    release,
    /android\.permission\.RECORD_AUDIO"\s+tools:node="remove"/,
    'RECORD_AUDIO must not be re-stripped from the release manifest',
  );
});

test('the narrow RecognitionService package-visibility query exists, not QUERY_ALL_PACKAGES', () => {
  const main = fs.readFileSync(path.join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  assert.match(main, /<action android:name="android\.speech\.RecognitionService"\/>/);
  assert.doesNotMatch(main, /QUERY_ALL_PACKAGES/);
});
