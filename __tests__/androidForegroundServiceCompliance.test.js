/**
 * Android foreground-service compliance tests (v24).
 *
 * Covers the durable, two-layer removal of every unused foreground service that dependency
 * library manifests (expo-location, expo-audio) merge into K Scan's Android manifest:
 *   1. plugins/withRemoveUnusedForegroundServices.js — the config-plugin manifest transform
 *      that reproduces the removals on Expo prebuild.
 *   2. scripts/check-android-manifest-compliance.js — the merged-release-manifest guard.
 *
 * Pure Node (node:test); no Android build or AAB packaging is performed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const {
  removeUnusedForegroundServices,
  UNUSED_FOREGROUND_SERVICES,
} = require('../plugins/withRemoveUnusedForegroundServices');

const GUARD = path.join(__dirname, '..', 'scripts', 'check-android-manifest-compliance.js');

function makeManifest(extraServices = []) {
  return {
    manifest: {
      $: { 'xmlns:android': 'http://schemas.android.com/apk/res/android' },
      application: [
        { $: { 'android:name': '.MainApplication' }, service: [...extraServices] },
      ],
    },
  };
}

test('config plugin tombstones all three unused foreground services + declares tools ns', () => {
  const androidManifest = makeManifest();
  removeUnusedForegroundServices(androidManifest);

  assert.equal(androidManifest.manifest.$['xmlns:tools'], 'http://schemas.android.com/tools');
  const services = androidManifest.manifest.application[0].service;
  for (const name of UNUSED_FOREGROUND_SERVICES) {
    const tombstone = services.find((s) => s.$['android:name'] === name);
    assert.ok(tombstone, `expected tombstone for ${name}`);
    assert.equal(tombstone.$['tools:node'], 'remove');
  }
  // Sanity: the exact three expected services.
  assert.deepEqual(
    [...UNUSED_FOREGROUND_SERVICES].sort(),
    [
      'expo.modules.audio.service.AudioControlsService',
      'expo.modules.audio.service.AudioRecordingService',
      'expo.modules.location.services.LocationTaskService',
    ].sort(),
  );
});

test('config plugin is idempotent (no duplicate tombstones)', () => {
  const androidManifest = makeManifest();
  removeUnusedForegroundServices(androidManifest);
  removeUnusedForegroundServices(androidManifest);
  removeUnusedForegroundServices(androidManifest);
  const services = androidManifest.manifest.application[0].service;
  for (const name of UNUSED_FOREGROUND_SERVICES) {
    const matches = services.filter((s) => s.$['android:name'] === name);
    assert.equal(matches.length, 1, `must not duplicate ${name}`);
  }
});

test('config plugin preserves unrelated services and converts a present one', () => {
  const androidManifest = makeManifest([
    { $: { 'android:name': 'com.example.KeepMeService', 'android:exported': 'false' } },
    {
      $: {
        'android:name': 'expo.modules.audio.service.AudioControlsService',
        'android:foregroundServiceType': 'mediaPlayback',
      },
    },
  ]);
  removeUnusedForegroundServices(androidManifest);

  const services = androidManifest.manifest.application[0].service;
  const kept = services.find((s) => s.$['android:name'] === 'com.example.KeepMeService');
  assert.ok(kept, 'unrelated service must be preserved');
  assert.equal(kept.$['android:exported'], 'false');

  const converted = services.filter(
    (s) => s.$['android:name'] === 'expo.modules.audio.service.AudioControlsService',
  );
  assert.equal(converted.length, 1);
  assert.equal(converted[0].$['tools:node'], 'remove');
});

// ---- Regression guard (subprocess) ----

function runGuard(xml) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-manifest-'));
  const file = path.join(dir, 'AndroidManifest.xml');
  fs.writeFileSync(file, xml, 'utf8');
  try {
    const stdout = execFileSync('node', [GUARD, file], { encoding: 'utf8' });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status, stdout: `${err.stdout || ''}${err.stderr || ''}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const BAD_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE"/>
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_LOCATION"/>
  <uses-permission android:name="android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK"/>
  <uses-permission android:name="android.permission.ACCESS_BACKGROUND_LOCATION"/>
  <application>
    <service android:name="expo.modules.location.services.LocationTaskService" android:foregroundServiceType="location"/>
    <service android:name="expo.modules.audio.service.AudioControlsService" android:foregroundServiceType="mediaPlayback"/>
    <service android:name="expo.modules.audio.service.AudioRecordingService" android:foregroundServiceType="microphone"/>
  </application>
</manifest>`;

const GOOD_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.CAMERA"/>
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.VIBRATE"/>
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
  <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
  <application>
    <activity android:name=".MainActivity"/>
  </application>
</manifest>`;

const UNKNOWN_FGS_MANIFEST = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.CAMERA"/>
  <uses-permission android:name="android.permission.INTERNET"/>
  <uses-permission android:name="android.permission.VIBRATE"/>
  <uses-permission android:name="android.permission.ACCESS_COARSE_LOCATION"/>
  <uses-permission android:name="android.permission.MODIFY_AUDIO_SETTINGS"/>
  <application>
    <service android:name="com.example.SyncService" android:foregroundServiceType="dataSync"/>
  </application>
</manifest>`;

const LEAKED_PERMISSION_MANIFEST = GOOD_MANIFEST.replace(
  '<application>',
  '<uses-permission android:name="android.permission.RECORD_AUDIO"/>\n  <application>',
);

test('guard FAILS on all three unused foreground services + FGS/background perms', () => {
  const { code, stdout } = runGuard(BAD_MANIFEST);
  assert.equal(code, 1, 'guard must exit 1 on prohibited entries');
  assert.match(stdout, /LocationTaskService/);
  assert.match(stdout, /AudioControlsService/);
  assert.match(stdout, /AudioRecordingService/);
  assert.match(stdout, /FOREGROUND_SERVICE/);
  assert.match(stdout, /ACCESS_BACKGROUND_LOCATION/);
  assert.match(stdout, /DO NOT build or upload an AAB/i);
});

test('guard PASSES on a clean approximate-location, no-FGS manifest', () => {
  const { code, stdout } = runGuard(GOOD_MANIFEST);
  assert.equal(code, 0, 'guard must exit 0 on a compliant manifest');
  assert.match(stdout, /PASS/);
});

test('guard FAILS on any foreground service type, including a previously unknown one', () => {
  const { code, stdout } = runGuard(UNKNOWN_FGS_MANIFEST);
  assert.equal(code, 1, 'every FGS type must hard-fail the zero-FGS release gate');
  assert.match(stdout, /dataSync/);
  assert.match(stdout, /FAIL/);
});

test('guard FAILS on microphone or other release-unapproved permissions', () => {
  const { code, stdout } = runGuard(LEAKED_PERMISSION_MANIFEST);
  assert.equal(code, 1);
  assert.match(stdout, /RECORD_AUDIO/);
});

test('guard FAILS when a required approved permission is missing', () => {
  const { code, stdout } = runGuard(
    GOOD_MANIFEST.replace('<uses-permission android:name="android.permission.CAMERA"/>', ''),
  );
  assert.equal(code, 1);
  assert.match(stdout, /CAMERA/);
  assert.match(stdout, /missing/);
});
