/**
 * Build 33 — iOS App Review surface contract.
 *
 * Build 32 shipped reviewer-visible "Coming Soon" affordances (a VOICE SCAN
 * pill on Home; disabled Microphone and Notifications cards in onboarding).
 * None of those features were implemented. Advertising them on the screens an
 * App Review tester lands on first invites a Guideline 2.1 incomplete-app
 * reading, so Build 33 removed the surfaces rather than dimming them.
 *
 * FLIPPED for the live Home variant by the VoiceScan K+ pill (Build 34):
 * Voice Scan is now a real, working, K+-gated feature (see
 * __tests__/voiceScanUiWiring.test.js and
 * components/home/HomeVoiceScanPill.tsx), not the unimplemented Build 32
 * placeholder. The Guideline 2.1 concern was "advertising a capability the
 * app cannot execute" -- it was never "a feature may not require an
 * entitlement". A pill that is absent when the build cannot execute Voice
 * Scan at all (VOICESCAN_ENABLED off), and that behaves like every other
 * genuine K+ entry point (KPlusGate, the shared K+ Early Access sheet, no
 * "Coming Soon" placeholder) when the build can, does not re-trigger the
 * original finding. HomeV2 and HomeLegacy are unrouted and untouched by that
 * feature, so they keep the original absence contract as a drift guard.
 *
 * Two distinctions this file exists to protect, because a naive "voice" or
 * "audio" grep gets both wrong:
 *
 *   VOICE SCAN            real, K+-gated -> must never be a "Coming Soon" stub
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
// production Home. The other two are unrouted; they never gained the Voice
// Scan K+ pill, so they keep the original Build 33 absence contract as a
// drift guard against a flag change ever reintroducing the old placeholder.
const UNROUTED_HOME_VARIANTS = ['HomeV2.tsx', 'HomeLegacy.tsx'];

for (const variant of UNROUTED_HOME_VARIANTS) {
  test('no Voice Scan surface remains in unrouted variant ' + variant, () => {
    const source = read('components', 'home', variant);
    assert.doesNotMatch(source, /voice\s*scan/i);
    assert.doesNotMatch(source, /VOICESCAN_ENABLED/);
    assert.doesNotMatch(source, /COMING SOON/);
    assert.doesNotMatch(source, /name="voice-scan"/);
  });
}

test('the live Home variant never falls back to the retired "Coming Soon" placeholder', () => {
  const source = read('components', 'home', 'HomeLuxuryTechV1.tsx');
  assert.doesNotMatch(source, /COMING SOON/);
});

test('the live Home variant gates its Voice Scan pill on the VoiceScan build-capability flag, not just K+', () => {
  const pill = read('components', 'home', 'HomeVoiceScanPill.tsx');
  const guard = pill.slice(
    pill.indexOf('export function HomeVoiceScanPill'),
    pill.indexOf('return (', pill.indexOf('export function HomeVoiceScanPill')),
  );
  assert.match(guard, /if \(!VOICESCAN_ENABLED\) return null;/);
  assert.match(guard, /isVoicePlatformProvisioned\(getPlatform\(\)\)/);
});

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

test('the iOS microphone purpose string exists only for Voice Scan, and neither camera nor audio plugin injects its own', () => {
  // FLIPPED by the Voice Scan recovery. This test previously asserted
  // `NSMicrophoneUsageDescription === undefined` and both plugin props
  // `false` -- correct only while Voice Scan was absent from this lineage.
  // Build 34 Voice Scan V1 is the first real, reachable microphone use in
  // this app (see __tests__/voiceScanUiWiring.test.js and
  // components/text-scan/VoiceScanButton.tsx), so the strings must now EXIST
  // and must describe Voice Scan specifically, not claim recording/upload.
  //
  // The plugin props used to be `false`, to stop expo-camera/expo-audio
  // injecting a competing generic copy. That was the right goal and the wrong
  // mechanism: Expo's createPermissionsPlugin treats `false` as DELETE, so the
  // plugins removed NSMicrophoneUsageDescription from the BUILT plist even
  // when it was declared. This file reads app.json, so it could not see that --
  // it would assert the declaration existed while asserting the setting that
  // erased it. Pinning both props to the same custom string keeps the original
  // intent (no generic copy) without the deletion, and is independent of the
  // order Expo applies the two plugins in.
  //
  // The GENERATED plist is asserted directly, via Expo config introspection,
  // in __tests__/voiceScanMicrophonePermission.test.js -- app.json alone
  // cannot prove this.
  assert.equal(typeof infoPlist.NSMicrophoneUsageDescription, 'string');
  assert.match(infoPlist.NSMicrophoneUsageDescription, /Voice Scan/);
  assert.doesNotMatch(infoPlist.NSMicrophoneUsageDescription, /upload|store|record and save/i);
  assert.equal(typeof infoPlist.NSSpeechRecognitionUsageDescription, 'string');
  assert.match(infoPlist.NSSpeechRecognitionUsageDescription, /on-device/i);
  // Must not make an affirmative upload claim -- "not uploaded" is the
  // correct, desired reassurance, so this checks for the affirmative verb
  // form rather than banning the word "upload" outright.
  assert.doesNotMatch(infoPlist.NSSpeechRecognitionUsageDescription, /\b(is|are|will be)\s+uploaded\b/i);
  for (const plugin of ['expo-camera', 'expo-audio']) {
    assert.equal(
      pluginProps(plugin).microphonePermission,
      infoPlist.NSMicrophoneUsageDescription,
      `${plugin} must carry the same custom microphone string, not false (which deletes it) `
        + 'and not a generic default',
    );
  }
});

test('background audio is never enabled by the Voice Scan microphone posture', () => {
  // Voice Scan is foreground push-to-talk. UIBackgroundModes "audio" would let
  // the app keep the mic alive after backgrounding -- a different, far broader
  // privacy claim than the one the usage strings make.
  const modes = infoPlist.UIBackgroundModes ?? [];
  assert.ok(!modes.includes('audio'), 'UIBackgroundModes must not include "audio"');
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
