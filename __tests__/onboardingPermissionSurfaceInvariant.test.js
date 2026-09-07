// RP-105 / PERM-REG-001 / PERM-KPLUS-001
//
// Static contract for the shipping onboarding source. The app's test harness
// has no React Native renderer, so this tests the real source structure rather
// than a parallel data fixture that could drift from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const permissionsStep = read('components/account-home/PermissionsStepV1.tsx');
const onboarding = read('app/onboarding/index.tsx');
const kPlusGate = read('components/kplus/KPlusGate.tsx');
const kPlusSources = read('types/kplusSource.ts');

function cardBlock(title, nextTitle) {
  const start = permissionsStep.indexOf(`title="${title}"`);
  assert.ok(start >= 0, `expected ${title} card in the shipping permissions step`);
  const next = nextTitle ? permissionsStep.indexOf(`title="${nextTitle}"`, start + 1) : -1;
  return permissionsStep.slice(start, next >= 0 ? next : start + 1800);
}

test('PERM-REG-001: the shipping screen has exactly the permanent four-card order', () => {
  const titles = ['Camera', 'Photos', 'Microphone', 'Notifications'];
  const positions = titles.map((title) => permissionsStep.indexOf(`title="${title}"`));
  assert.ok(positions.every((position) => position >= 0), 'all four permission cards must be present');
  assert.deepEqual([...positions].sort((a, b) => a - b), positions,
    'permission cards must remain Camera → Photos → Microphone → Notifications');
  for (const title of titles) {
    assert.equal(
      (permissionsStep.match(new RegExp(`title="${title}"`, 'g')) ?? []).length,
      1,
      `${title} must have one canonical onboarding card`,
    );
  }
});

test('RP-105: Camera and Photos are truthful point-of-use education, never fake ALLOW controls', () => {
  const camera = cardBlock('Camera', 'Photos');
  const photos = cardBlock('Photos', 'Microphone');
  for (const [name, card] of [['Camera', camera], ['Photos', photos]]) {
    assert.match(card, /badge="ESSENTIAL"/);
    assert.match(card, /actionType="status"/);
    assert.match(card, /statusLabel="ON USE"/);
    assert.doesNotMatch(card, /ALLOW|onActionChange|actionValue/);
    assert.match(card, /requested only when|system picker/i, `${name} must describe its real point-of-use flow`);
  }
  assert.doesNotMatch(permissionsStep, /actionType: 'allow'/);
  assert.doesNotMatch(permissionsStep, />\s*ALLOW\s*</);
});

test('PERM-KPLUS-001: Microphone is permanently OPTIONAL and uses the canonical K+ gate', () => {
  const microphone = cardBlock('Microphone', 'Notifications');
  assert.match(microphone, /badge="OPTIONAL"/);
  assert.match(permissionsStep, /<KPlusGate source="onboarding">/);
  assert.match(kPlusGate, /KPlusEarlyAccessSheet/);
  assert.match(kPlusSources, /'onboarding'/);
  assert.match(microphone, /canUseVoiceScan \? 'status' : 'button'/);
  assert.match(microphone, /UNLOCK WITH K\+/);
  assert.match(microphone, /K\+ ACTIVE/);
  assert.match(microphone, /CHECKING K\+/);
  assert.match(microphone, /CHECK K\+/);
});

test('Microphone stays visible through capability and entitlement states, while failing closed', () => {
  const microphone = cardBlock('Microphone', 'Notifications');
  assert.match(microphone, /!voiceScanAvailable/);
  assert.match(permissionsStep, /state === 'loading'/);
  assert.match(permissionsStep, /state === 'error' \|\| state === 'unavailable'/);
  assert.match(permissionsStep, /microphoneActionDisabled = !voiceScanAvailable \|\| isResolving/);
  assert.match(permissionsStep, /canUseVoiceScan = voiceScanAvailable && isActive/);
  assert.doesNotMatch(microphone, /return null/);
  assert.doesNotMatch(permissionsStep, /if \(!VOICESCAN_ENABLED\) return null/);
});

test('Microphone onboarding cannot request permission or start Voice Scan', () => {
  for (const forbidden of [
    'requestMicrophonePermission',
    'requestVoiceRecordingPermission',
    'PermissionsAndroid',
    'RECORD_AUDIO',
    'startVoiceScan',
    'startSession',
    'useVoiceScan',
    'SpeechRecognizer',
  ]) {
    assert.ok(!permissionsStep.includes(forbidden), `permissions step must not reference ${forbidden}`);
    assert.ok(!onboarding.includes(forbidden), `onboarding route must not reference ${forbidden}`);
  }
});

test('Notifications is permanently OPTIONAL and retains the real actionable toggle', () => {
  const notifications = cardBlock('Notifications');
  assert.match(notifications, /badge="OPTIONAL"/);
  assert.match(notifications, /actionType="toggle"/);
  assert.match(permissionsStep, /requestNotificationPermission\(\)/);
  assert.match(notifications, /openNotificationSettings/);
  assert.doesNotMatch(notifications, /return null|COMING SOON/i);
});

test('no flag, entitlement, or placeholder copy can remove the permanent four-card education surface', () => {
  const executable = permissionsStep
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  for (const forbidden of [
    'ACCOUNT_HOME_UX_V1_ENABLED',
    'FeatureFreeze',
    'process.env',
    '__DEV__',
    'remoteConfig',
    'RevenueCat',
    'PostHog',
    'COMING SOON',
  ]) {
    assert.ok(!executable.includes(forbidden), `permissions surface must not contain ${forbidden}`);
  }
});
