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

test('Notifications is permanently OPTIONAL and actionable exactly when push ships', () => {
  // TEST-FLIP (Android Repair 05). The old expectation was a literal
  // `actionType="toggle"` — an unconditional, always-actionable control. On a
  // build with no feature able to send a push, that toggle asked the OS for
  // POST_NOTIFICATIONS and registered an Expo push token for alerts nothing
  // could ever produce. The card itself is unchanged in status (permanent,
  // OPTIONAL, never "Coming Soon", never rendered away); what is now
  // conditional is whether it ACTS.
  const notifications = cardBlock('Notifications');
  assert.match(notifications, /badge="OPTIONAL"/);
  assert.match(
    notifications,
    /actionType=\{remotePushAllowed \? 'toggle' : 'status'\}/,
    'the row must be a live toggle when push ships and a passive status row when it does not',
  );
  assert.match(
    notifications,
    /onActionChange=\{\s*remotePushAllowed \? \(value\) => void handleNotificationsToggle\(value\) : undefined\s*\}/,
    'no change handler may be wired while the capability is off',
  );
  assert.match(permissionsStep, /requestNotificationPermission\(\)/);
  assert.match(permissionsStep, /openNotificationSettings/);
  assert.doesNotMatch(notifications, /return null|COMING SOON/i);
});

test('the Notifications row reads the capability from the one canonical resolver', () => {
  // Composed once per render from the single authority, never recomposed here
  // out of a raw flag and a platform test — the same discipline Repair 01
  // established for Mirror Selfie availability.
  assert.match(
    permissionsStep,
    /import \{ resolveRemotePushActivationAllowed \} from '\.\.\/\.\.\/services\/notifications\/remotePushCapability';/,
  );
  assert.equal(
    (permissionsStep.match(/resolveRemotePushActivationAllowed\(\)/g) ?? []).length,
    1,
    'the decision must be evaluated exactly once per render',
  );
  assert.match(permissionsStep, /const remotePushAllowed = resolveRemotePushActivationAllowed\(\);/);
});

test('a non-requesting Notifications row states the real reason and offers no dead CTA', () => {
  const notifications = cardBlock('Notifications');
  // Truthful, specific copy — never a generic retention line invented to keep
  // the permission ("Stay up to date" and friends).
  assert.match(notifications, /Price alerts are not available in this build\./);
  assert.match(notifications, /statusLabel=\{remotePushAllowed \? undefined : 'NOT AVAILABLE'\}/);
  // The Settings escape hatch belongs to a denied REQUEST. With no request
  // there is no denial, so it must not be reachable either.
  assert.match(
    permissionsStep,
    /\{remotePushAllowed && notificationsStatus === 'denied_needs_settings' \?/,
  );
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
