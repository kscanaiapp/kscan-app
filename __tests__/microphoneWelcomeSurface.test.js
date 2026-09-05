/**
 * Microphone welcome-tree activation (Build 34), passive status only.
 *
 * The governed microphone-permission authority is Voice Scan's JIT path
 * (VoiceScanButton -> useVoiceScan.startSession -> requestVoiceRecordingPermission
 * -> services/voice/voiceNativeModule -> modules/kscan-voice-native), enforced
 * by __tests__/androidGooglePlayComplianceV1.test.js and
 * __tests__/iosAppReviewSurface.test.js. This file adds a SECOND, narrower
 * layer specific to the new Microphone card: proof that the card itself is
 * structurally incapable of reaching a permission API, not just that no
 * caller happens to exist today.
 *
 * No React renderer is available in this repo's test suite (no
 * react-test-renderer / @testing-library/react-native) -- every test here is
 * a source-contract test, consistent with the rest of the suite (see e.g.
 * iosAppReviewSurface.test.js's own header). "No renderer" tests prove
 * reachability/structure statically: for a card whose entire action area is
 * gated behind `actionType === 'status'`, and where that branch is proven to
 * contain no Pressable/Switch/onPress/onValueChange, there is no code path
 * a render could take that reaches a handler that isn't there.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), 'utf8');

const stepSource = read('components', 'account-home', 'PermissionsStepV1.tsx');
const onboardingSource = read('app', 'onboarding', 'index.tsx');
const hookSource = read('hooks', 'usePermissionPreferences.ts');
const voiceScanButtonSource = read('components', 'text-scan', 'VoiceScanButton.tsx');
const useVoiceScanSource = read('hooks', 'useVoiceScan.ts');
const voiceNativeModuleSource = read('services', 'voice', 'voiceNativeModule.ts');
const appJson = JSON.parse(read('app.json'));
const infoPlist = appJson.expo.ios.infoPlist;

function microphoneCardBlock() {
  const start = stepSource.indexOf('title="Microphone"');
  assert.ok(start > -1, 'expected a Microphone PermissionCard');
  const end = stepSource.indexOf('/>', start) + 2;
  return stepSource.slice(start - 40, end);
}

function statusBranchOfPermissionCard() {
  const renderFnStart = stepSource.indexOf('function PermissionCard(');
  assert.ok(renderFnStart > -1, 'expected a PermissionCard render function');
  const marker = "actionType === 'status'";
  const start = stepSource.indexOf(marker, renderFnStart);
  assert.ok(start > -1, "expected the PermissionCard render to branch on actionType === 'status'");
  const end = stepSource.indexOf(") : actionType === 'allow'", start);
  assert.ok(end > start, 'expected the status branch to be followed by the allow branch');
  return stepSource.slice(start, end);
}

// ─── §5: welcome surface presentation ────────────────────────────────────────

test('Microphone card is visible, titled correctly, and OPTIONAL', () => {
  const card = microphoneCardBlock();
  assert.match(card, /title="Microphone"/);
  assert.match(card, /badge="OPTIONAL"/);
});

test('"Coming Soon" is absent from the Microphone card', () => {
  assert.doesNotMatch(microphoneCardBlock(), /Coming Soon/i);
});

test('the Microphone card is not disabled or greyed out', () => {
  const card = microphoneCardBlock();
  assert.doesNotMatch(card, /disabled=\{?true\}?/);
  assert.doesNotMatch(card, /disabled=\{/);
});

test('the card describes on-use, just-in-time behavior without claiming background listening or upload', () => {
  const card = microphoneCardBlock();
  assert.match(card, /Voice Scan/);
  assert.match(card, /requested only when you tap Voice Scan/i);
  assert.doesNotMatch(card, /background listening|always listening|continuous(ly)? record|upload/i);
});

test('the card has no environment or feature-flag gate', () => {
  const card = microphoneCardBlock()
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\/.*$/gm, '');
  for (const token of [
    'VOICESCAN_ENABLED',
    'ACCOUNT_HOME_UX_V1_ENABLED',
    'FeatureFreeze',
    'process.env',
    '__DEV__',
    'remoteConfig',
    'app_config',
    'RevenueCat',
    'PostHog',
    'kplus',
    'K_PLUS',
  ]) {
    assert.ok(!card.includes(token), `Microphone card must not reference "${token}"`);
  }
});

// ─── §6/§18: passive action area, structurally inert ─────────────────────────

test('the card uses actionType="status", not allow/toggle', () => {
  assert.match(microphoneCardBlock(), /actionType="status"/);
  assert.doesNotMatch(microphoneCardBlock(), /actionType="toggle"/);
  assert.doesNotMatch(microphoneCardBlock(), /actionType="allow"/);
});

test('the card passes no actionValue/onActionChange -- there is no state to flip', () => {
  const card = microphoneCardBlock();
  assert.doesNotMatch(card, /actionValue=/);
  assert.doesNotMatch(card, /onActionChange=/);
});

test('the status render branch contains no Pressable, Switch, onPress, or onValueChange', () => {
  // Strip comments first -- prose explaining the ABSENCE of these APIs
  // legitimately names them; only executable code is evidence of their use.
  const branch = statusBranchOfPermissionCard().replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(branch, /Pressable/);
  assert.doesNotMatch(branch, /Switch/);
  assert.doesNotMatch(branch, /onPress/);
  assert.doesNotMatch(branch, /onValueChange/);
  // Positive control: it IS a plain, non-touchable View + Text.
  assert.match(branch, /<View style=\{styles\.statusPill\}/);
  assert.match(branch, /<Text style=\{styles\.statusPillText\}>/);
});

test('CONTROL (negative): the allow/toggle branches DO contain Pressable/Switch, proving the scan above is meaningful', () => {
  const renderFnStart = stepSource.indexOf('function PermissionCard(');
  const wholeAction = stepSource.slice(
    stepSource.indexOf("actionType === 'status'", renderFnStart),
    stepSource.indexOf('const styles = StyleSheet.create('),
  );
  assert.match(wholeAction, /Pressable/);
  assert.match(wholeAction, /Switch/);
});

test('the file imports no permission-request API of any kind', () => {
  for (const forbidden of [
    'requestMicrophonePermission',
    'requestVoiceRecordingPermission',
    'requestVoicePermissions',
    'PermissionsAndroid',
    'getRecordingPermissionsAsync',
    'requestRecordingPermissionsAsync',
    'useAudioRecorder',
    'AudioRecorder',
  ]) {
    assert.ok(!stepSource.includes(forbidden), `PermissionsStepV1.tsx must not reference "${forbidden}"`);
  }
});

// ─── §3/§4: onboarding carries no microphone permission plumbing ────────────

test('onboarding does not import, destructure, or pass requestMicrophonePermission', () => {
  assert.doesNotMatch(onboardingSource, /requestMicrophonePermission/);
});

test('PermissionsStepV1Props does not declare a microphone permission callback', () => {
  const propsBlock = stepSource.slice(
    stepSource.indexOf('interface PermissionsStepV1Props'),
    stepSource.indexOf('interface PermissionsStepV1Props') +
      stepSource.slice(stepSource.indexOf('interface PermissionsStepV1Props')).indexOf('}'),
  );
  assert.doesNotMatch(propsBlock, /microphone/i);
});

// ─── §7: the dormant onboarding-era helper is retained, not removed ─────────
//
// __tests__/androidGooglePlayComplianceV1.test.js's "the ONLY reachable
// microphone-request path is the JIT one in the Voice session" test requires
// hooks/usePermissionPreferences.ts to keep exporting requestMicrophonePermission
// (with its exact original guard) as a caller-less tripwire. Deleting it would
// break that governed, hostile-audited test -- so it is retained here,
// unchanged, and re-proven caller-less independent of that other file.

test('the dormant requestMicrophonePermission helper is retained with its original guard', () => {
  assert.match(hookSource, /const requestMicrophonePermission = useCallback/);
  assert.match(hookSource, /if \(Platform\.OS !== 'android' \|\| !VOICESCAN_ENABLED\)/);
});

test('the dormant helper has zero callers across the app/component/hook/service surface', () => {
  const searchRoots = ['app', 'components', 'hooks', 'services'];
  const callers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx)$/.test(entry.name)) continue;
      const relative = path.relative(ROOT, full).replace(/\\/g, '/');
      if (relative === 'hooks/usePermissionPreferences.ts') continue; // the definition itself
      if (/requestMicrophonePermission/.test(fs.readFileSync(full, 'utf8'))) callers.push(relative);
    }
  };
  for (const root of searchRoots) walk(path.join(ROOT, root));
  assert.deepEqual(callers, [], `requestMicrophonePermission must stay caller-less; found: ${callers.join(', ')}`);
});

test('PermissionKey and PermissionPreferences still carry a microphone slot (state contract preserved)', () => {
  assert.match(hookSource, /'microphone'/);
  assert.match(hookSource, /microphone:\s*boolean;/);
});

// ─── VoiceScan JIT path is unchanged ─────────────────────────────────────────

test('VoiceScanButton still triggers useVoiceScan().startSession() from an explicit tap', () => {
  assert.match(voiceScanButtonSource, /useVoiceScan\(/);
  assert.match(voiceScanButtonSource, /voice\.startSession\(\)/);
  const handlePress = voiceScanButtonSource.slice(
    voiceScanButtonSource.indexOf('const handlePress'),
    voiceScanButtonSource.indexOf('const sheetVisible'),
  );
  assert.match(handlePress, /startSession\(\)/);
});

test('useVoiceScan.startSession() still calls requestVoiceRecordingPermission()', () => {
  const startSession = useVoiceScanSource.slice(
    useVoiceScanSource.indexOf('const startSession'),
    useVoiceScanSource.indexOf('const stopSession'),
  );
  assert.match(startSession, /await requestVoiceRecordingPermission\(\)/);
});

test('requestVoiceRecordingPermission() still delegates to the dedicated native module', () => {
  assert.match(voiceNativeModuleSource, /export async function requestVoiceRecordingPermission/);
  assert.match(voiceNativeModuleSource, /return requestVoicePermissions\(\);/);
  assert.match(voiceNativeModuleSource, /from '\.\.\/\.\.\/modules\/kscan-voice-native'/);
});

// ─── §8/§20: native usage-string content contract ────────────────────────────

test('NSMicrophoneUsageDescription is present and remains Voice-Scan-specific', () => {
  assert.equal(typeof infoPlist.NSMicrophoneUsageDescription, 'string');
  assert.match(infoPlist.NSMicrophoneUsageDescription, /Voice Scan/);
  // A future generic rewording ("lets you use voice features", "for audio
  // input") must fail this -- the string must name the specific feature.
  assert.doesNotMatch(infoPlist.NSMicrophoneUsageDescription, /upload|store|record and save/i);
});

test('NSSpeechRecognitionUsageDescription is present and remains on-device-specific', () => {
  assert.equal(typeof infoPlist.NSSpeechRecognitionUsageDescription, 'string');
  assert.match(infoPlist.NSSpeechRecognitionUsageDescription, /on-device/i);
  assert.doesNotMatch(infoPlist.NSSpeechRecognitionUsageDescription, /\b(is|are|will be)\s+uploaded\b/i);
});

test('background audio capability remains absent', () => {
  const modes = infoPlist.UIBackgroundModes ?? [];
  assert.ok(!modes.includes('audio'));
});

// ─── §7/§8 Android: native posture unchanged ─────────────────────────────────

test('RECORD_AUDIO is not promoted into generic app.json android.permissions', () => {
  assert.ok(!appJson.expo.android.permissions.includes('android.permission.RECORD_AUDIO'));
});

test('RECORD_AUDIO remains blocked by default (fail-closed release posture unchanged)', () => {
  assert.ok(appJson.expo.android.blockedPermissions.includes('android.permission.RECORD_AUDIO'));
});

test('the base AndroidManifest still removes RECORD_AUDIO by default', () => {
  const manifest = read('android', 'app', 'src', 'main', 'AndroidManifest.xml');
  assert.match(
    manifest,
    /<uses-permission android:name="android\.permission\.RECORD_AUDIO" tools:node="remove"\/>/,
  );
});

test('the Voice-capable certification manifest override still exists, untouched', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'android/app/src/certification/AndroidManifest.xml')));
});

test('the Gradle Voice invariant (JS flag <=> native capability) is unweakened', () => {
  const gradle = read('android', 'app', 'build.gradle');
  assert.match(gradle, /voiceScanEnabled != voiceNativeCapabilityMaterialized/);
  assert.match(gradle, /throw new GradleException/);
});

// ─── §19: card/capability coherence decision ────────────────────────────────
//
// Recorded decision: VoiceScan is gated OFF in ordinary production builds
// today (eas.json sets EXPO_PUBLIC_VOICESCAN_ENABLED=true only for
// staging-certification). The Microphone card is nonetheless kept
// unconditionally visible because it is PURELY DESCRIPTIVE/STATUS -- it has
// no action that can fail, silently or otherwise (see the inertness tests
// above). This is a materially different risk than an ALLOW/toggle
// affordance for an unreachable capability (the INT-KPLUS-005 dead-entry
// class), which this card structurally cannot become.

test('recorded coherence decision: card visibility does not key off VOICESCAN_ENABLED', () => {
  assert.doesNotMatch(microphoneCardBlock(), /VOICESCAN_ENABLED/);
});

// ─── §12: other permission surfaces untouched ────────────────────────────────

test('Camera card is unchanged', () => {
  const card = stepSource.slice(stepSource.indexOf('title="Camera"'), stepSource.indexOf('title="Photos"'));
  assert.match(card, /badge="ESSENTIAL"/);
  assert.match(card, /actionType="allow"/);
});

test('Photos card is unchanged', () => {
  const card = stepSource.slice(stepSource.indexOf('title="Photos"'), stepSource.indexOf('title="Microphone"'));
  assert.match(card, /badge="ESSENTIAL"/);
  assert.match(card, /actionType="allow"/);
});

test('Notifications card and its live wiring are unchanged', () => {
  assert.match(stepSource, /title="Notifications"/);
  assert.match(stepSource, /requestNotificationPermission\(\)/);
  assert.match(stepSource, /openNotificationSettings/);
});

test('AI consent remains intact', () => {
  assert.match(read('constants', 'legal.ts'), /AI_PROCESSING_VERSION/);
  assert.match(onboardingSource, /onboarding-ai-consent-checkbox/);
  assert.match(onboardingSource, /onboarding-ai-processing-statement/);
});
