/**
 * Build 33 — iOS App Review surface contract.
 *
 * Build 32 shipped reviewer-visible "Coming Soon" affordances (a VOICE SCAN
 * pill on Home; disabled Microphone and Notifications cards in onboarding).
 * None of those features are implemented. Advertising them on the screens an
 * App Review tester lands on first invites a Guideline 2.1 incomplete-app
 * reading, so Build 33 removes the surfaces rather than dimming them.
 *
 * Two distinctions this file exists to protect, because a naive "voice" or
 * "audio" grep gets both wrong:
 *
 *   VOICE SCAN            unimplemented  -> must be absent from production UI
 *   Elise spoken response shipping       -> must be preserved
 *
 * These are source-contract tests (no renderer), consistent with the rest of
 * the suite.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const appJson = JSON.parse(read('app.json'));
const easJson = JSON.parse(read('eas.json'));
const iosConfig = appJson.expo.ios;
const infoPlist = iosConfig.infoPlist || {};
const plugins = appJson.expo.plugins || [];
const pluginProps = (name) => {
  const entry = plugins.find((p) => Array.isArray(p) && p[0] === name);
  return entry ? entry[1] : undefined;
};

// -- Unfinished feature surfaces ---------------------------------------------

// app/index.tsx renders HomeLuxuryTechV1 unconditionally, so it is the live
// production Home. The other two are unrouted but hardened against flag drift.
const HOME_VARIANTS = ['HomeLuxuryTechV1.tsx', 'HomeV2.tsx', 'HomeLegacy.tsx'];

for (const variant of HOME_VARIANTS) {
  test('no Voice Scan surface remains in ' + variant, () => {
    const source = read('components', 'home', variant);
    assert.doesNotMatch(source, /voice\s*scan/i);
    assert.doesNotMatch(source, /VOICESCAN_ENABLED/);
    assert.doesNotMatch(source, /COMING SOON/);
    assert.doesNotMatch(source, /name="voice-scan"/);
  });
}

test('the production route still renders the hardened Home variant', () => {
  // If this ever stops being HomeLuxuryTechV1, the variant coverage above is
  // no longer testing the screen App Review actually sees.
  const entry = read('app', 'index.tsx');
  assert.match(entry, /HomeLuxuryTechV1/);
});

test('onboarding advertises no unimplemented permissions', () => {
  const step = read('components', 'account-home', 'PermissionsStepV1.tsx');
  const body = step.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(body, /Coming Soon/i);
  assert.doesNotMatch(body, /VoiceScan/i);
  // Camera and Photos are real, point-of-use grants and must survive.
  assert.match(body, /title="Camera"/);
  assert.match(body, /title="Photos"/);
  // The microphone prop is gone, so the step cannot request the permission.
  assert.doesNotMatch(body, /requestMicrophonePermission/);
});

test('onboarding no longer passes microphone plumbing into the permissions step', () => {
  assert.doesNotMatch(read('app', 'onboarding', 'index.tsx'), /requestMicrophonePermission/);
});

test('the TextScan voice placeholder stays off in the production profile', () => {
  const prodEnv = easJson.build.production.env;
  assert.notEqual(prodEnv.EXPO_PUBLIC_TEXTSCAN_VOICE_PLACEHOLDER, 'true');
});

// -- Microphone posture ------------------------------------------------------

test('no iOS microphone purpose string is declared', () => {
  assert.equal(infoPlist.NSMicrophoneUsageDescription, undefined);
  assert.equal(pluginProps('expo-camera').microphonePermission, false);
  assert.equal(pluginProps('expo-audio').microphonePermission, false);
});

test('no production code path can request microphone or recording permission', () => {
  // Linked Expo/native frameworks contain AVAudioRecorder symbols; that is not
  // the same as a reachable product path. This asserts reachability, which is
  // what determines whether iOS shows a cold-launch prompt.
  const FORBIDDEN = [
    'requestMicrophonePermissionsAsync',
    'getMicrophonePermissionsAsync',
    'requestRecordingPermissionsAsync',
    'useMicrophonePermissions',
    'useAudioRecorder',
    'AudioRecorder',
    'prepareToRecordAsync',
    'startRecording',
    'recordAsync',
  ];
  const ROOTS = ['app', 'components', 'services', 'src', 'hooks', 'contexts', 'stores', 'lib'];
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__snapshots__') continue;
        walk(full);
      } else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) {
        const source = fs.readFileSync(full, 'utf8');
        for (const needle of FORBIDDEN) {
          if (source.includes(needle)) {
            offenders.push(path.relative(ROOT, full) + ': ' + needle);
          }
        }
      }
    }
  };
  for (const dir of ROOTS) {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) walk(full);
  }
  const appEntry = path.join(ROOT, 'app.js');
  if (fs.existsSync(appEntry)) {
    const source = fs.readFileSync(appEntry, 'utf8');
    for (const needle of FORBIDDEN) {
      if (source.includes(needle)) offenders.push('app.js: ' + needle);
    }
  }
  assert.deepEqual(offenders, [], 'reachable microphone/recording API: ' + offenders.join(', '));
});

// -- Elise spoken responses (must NOT be removed) ----------------------------

test('Elise spoken-response playback is preserved', () => {
  const playback = read('services', 'avatars', 'stylistAudioPlayback.ts');
  assert.match(playback, /createAudioPlayer/);
  assert.match(playback, /playStylistAudio/);
  // Playback only: activating the record category is what triggers an iOS
  // microphone prompt, so these must stay explicitly false.
  assert.match(playback, /allowsRecording:\s*false/);
  assert.match(playback, /allowsBackgroundRecording:\s*false/);
  assert.match(playback, /shouldPlayInBackground:\s*false/);
});

// -- Location posture --------------------------------------------------------

test('iOS location is foreground-only with the unused Always keys suppressed', () => {
  const location = pluginProps('expo-location');
  assert.equal(typeof location.locationWhenInUsePermission, 'string');
  // expo-location injects a generic "Allow $(PRODUCT_NAME) to access your
  // location" string for any Always key left undefined. Explicit false makes
  // the config plugin delete the key instead.
  assert.equal(location.locationAlwaysPermission, false);
  assert.equal(location.locationAlwaysAndWhenInUsePermission, false);
  assert.equal(location.isIosBackgroundLocationEnabled, false);
  assert.equal(infoPlist.NSLocationWhenInUseUsageDescription !== undefined, true);
  assert.equal(infoPlist.UIBackgroundModes, undefined);
});

test('no product code requests background location', () => {
  const weather = read('services', 'weather', 'weatherStylingContext.ts');
  assert.match(weather, /requestForegroundPermissionsAsync/);
  assert.doesNotMatch(weather, /requestBackgroundPermissionsAsync/);
  assert.doesNotMatch(weather, /startLocationUpdatesAsync/);
});
