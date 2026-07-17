const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const FORBIDDEN = [
  'android.permission.RECORD_AUDIO',
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

test('image picker and audio plugins keep microphone disabled', () => {
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
  const camera = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-camera');
  const audio = appJson.expo.plugins.find((entry) => Array.isArray(entry) && entry[0] === 'expo-audio');
  assert.equal(camera?.[1]?.microphonePermission, false);
  assert.equal(audio?.[1]?.microphonePermission, false);
  assert.equal(audio?.[1]?.recordAudioAndroid, false);
});
