'use strict';

// AND35-VOICE-QUERY-001: Android 11+ package visibility for on-device Voice Scan.
// The native module uses SpeechRecognizer.createOnDeviceSpeechRecognizer() and
// cannot rely on unrelated dependency manifests exposing RecognitionService.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const manifest = fs.readFileSync(
  path.join(root, 'modules/kscan-voice-native/android/src/main/AndroidManifest.xml'),
  'utf8'
);
const nativeModule = fs.readFileSync(
  path.join(root, 'modules/kscan-voice-native/android/src/main/java/expo/modules/kscanvoicenative/KScanVoiceNativeModule.kt'),
  'utf8'
);
const appManifest = fs.readFileSync(
  path.join(root, 'android/app/src/main/AndroidManifest.xml'),
  'utf8'
);

test('ANDROID-VOICE-QUERY-001: native module declares only speech-service package visibility', () => {
  assert.match(manifest, /<queries>\s*<intent>\s*<action android:name="android\.speech\.RecognitionService"\s*\/>\s*<\/intent>\s*<\/queries>/);
  assert.doesNotMatch(manifest, /QUERY_ALL_PACKAGES|<uses-permission/);
});

test('ANDROID-VOICE-QUERY-002: Voice Scan is on-device only, without broad package visibility or a cloud fallback', () => {
  assert.match(nativeModule, /SpeechRecognizer\.createOnDeviceSpeechRecognizer\(context\)/);
  assert.match(nativeModule, /SpeechRecognizer\.isOnDeviceRecognitionAvailable\(context\)/);
  assert.doesNotMatch(nativeModule, /SpeechRecognizer\.createSpeechRecognizer\(/);
  assert.doesNotMatch(appManifest, /QUERY_ALL_PACKAGES/);
});
