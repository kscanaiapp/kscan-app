'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

/**
 * Voice Scan needs NSMicrophoneUsageDescription in the GENERATED Info.plist.
 *
 * Why this test introspects the real Expo config instead of reading app.json:
 * the string was already declared under `expo.ios.infoPlist`, and was still
 * absent from the built plist. Two config plugins -- expo-camera and
 * expo-audio -- passed `microphonePermission: false`, and Expo's
 * createPermissionsPlugin treats `false` as DELETE, not "leave alone". The
 * plugin ran after the static declaration and removed the key.
 *
 * So a source-text assertion over app.json passes while the shipped app has no
 * microphone usage description. There is no `ios/` directory in this repo --
 * the plist is generated at prebuild -- which means introspection is the only
 * place the truth is visible before an actual build.
 *
 * What the missing key costs: iOS terminates a process that touches an audio
 * capture API with no usage description. KScanVoiceNativeModule.swift calls
 * AVAudioSession.requestRecordPermission, so Voice Scan would kill the app on
 * first use on a device, and App Review would reject the binary.
 *
 * Setting BOTH plugins is deliberate and not redundant. NSMicrophoneUsageDescription
 * is a single app-wide key; whichever of the two plugins Expo applies last would
 * otherwise be free to delete it again. Agreeing makes the result independent of
 * plugin order.
 */

const REPO_ROOT = path.resolve(__dirname, '..');
const APP_JSON_PATH = path.join(REPO_ROOT, 'app.json');
const MIC_KEY = 'NSMicrophoneUsageDescription';
const SPEECH_KEY = 'NSSpeechRecognitionUsageDescription';

function introspectInfoPlist() {
  // Invoke the local Expo CLI through node rather than `npx`: on Windows
  // spawnSync cannot execute npx.cmd without a shell, and resolving the bin
  // directly also pins the test to this repo's Expo version.
  const cli = path.join(REPO_ROOT, 'node_modules', 'expo', 'bin', 'cli');
  const raw = execFileSync(
    process.execPath,
    [cli, 'config', '--type', 'introspect', '--json'],
    { cwd: REPO_ROOT, stdio: 'pipe', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  // The CLI may print a banner before the JSON document.
  const start = raw.indexOf('{');
  assert.notEqual(start, -1, 'expo config produced no JSON document');
  return JSON.parse(raw.slice(start)).ios.infoPlist;
}

function withMutatedAppJson(mutate, run) {
  const original = fs.readFileSync(APP_JSON_PATH, 'utf8');
  try {
    const config = JSON.parse(original);
    mutate(config);
    fs.writeFileSync(APP_JSON_PATH, JSON.stringify(config, null, 2));
    return run();
  } finally {
    fs.writeFileSync(APP_JSON_PATH, original);
  }
}

function pluginOptions(config, name) {
  const entry = config.expo.plugins.find((p) => Array.isArray(p) && p[0] === name);
  assert.ok(entry, `${name} plugin entry not found`);
  return entry[1];
}

test('Voice Scan: the generated Info.plist declares a microphone usage description', { timeout: 180000 }, () => {
  const infoPlist = introspectInfoPlist();
  assert.ok(
    typeof infoPlist[MIC_KEY] === 'string' && infoPlist[MIC_KEY].length > 0,
    `${MIC_KEY} is missing from the generated Info.plist; iOS would terminate the app on first Voice Scan use`,
  );
  assert.ok(
    typeof infoPlist[SPEECH_KEY] === 'string' && infoPlist[SPEECH_KEY].length > 0,
    `${SPEECH_KEY} is missing from the generated Info.plist`,
  );
  // The speech string must keep claiming on-device processing, because
  // KScanVoiceNativeModule.swift sets requiresOnDeviceRecognition = true.
  assert.match(infoPlist[SPEECH_KEY], /on[- ]device/i);
});

test('Voice Scan: no config plugin may delete the microphone usage description', { timeout: 180000 }, () => {
  const config = JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8'));
  for (const name of ['expo-camera', 'expo-audio']) {
    assert.notEqual(
      pluginOptions(config, name).microphonePermission,
      false,
      `${name} passes microphonePermission: false, which DELETES ${MIC_KEY} from the built plist`,
    );
  }
});

test('Voice Scan: Voice must not request Android background-audio permissions', { timeout: 180000 }, () => {
  const config = JSON.parse(fs.readFileSync(APP_JSON_PATH, 'utf8'));
  // Voice Scan is push-to-talk and foreground-only. recordAudioAndroid stays
  // false on the managed config: the Android line declares RECORD_AUDIO in its
  // own checked-in manifest, and letting a plugin add it here would diverge the
  // two lines' permission sets.
  for (const name of ['expo-camera', 'expo-audio']) {
    assert.equal(pluginOptions(config, name).recordAudioAndroid, false);
  }
  const infoPlist = introspectInfoPlist();
  assert.equal(
    infoPlist.UIBackgroundModes,
    undefined,
    'Voice Scan is foreground-only; no background audio mode may be declared',
  );
});

test('NEGATIVE CONTROL: restoring microphonePermission:false removes the key again', { timeout: 240000 }, () => {
  // Proves this suite is bound to the generated plist rather than to app.json
  // text: reinstating the defect on BOTH plugins must make the key vanish.
  const missing = withMutatedAppJson(
    (config) => {
      for (const name of ['expo-camera', 'expo-audio']) {
        pluginOptions(config, name).microphonePermission = false;
      }
    },
    () => introspectInfoPlist()[MIC_KEY],
  );
  assert.equal(
    missing,
    undefined,
    'the negative control did not reproduce the defect, so this suite would not catch a regression',
  );

  // And the repaired config still produces it.
  assert.ok(typeof introspectInfoPlist()[MIC_KEY] === 'string');
});
