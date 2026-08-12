/**
 * App Review completeness: the VOICE RESPONSES control must not be offered
 * when it cannot do anything.
 *
 * hooks/useStyleChat computes `canSpeakNewMessages` with a
 * `voiceProfile !== 'silent'` term, and constants/stylistIdentity gives every
 * abstract stylist look — including the default `elise_default` — the 'silent'
 * profile. Only the ten portrait presets carry a voice.
 *
 * So on a default account the toggle in PersonalizeStylistModal could be
 * switched on, would persist, would report "On", and nothing would ever be
 * spoken. That is the state an App Review tester lands in, and an advertised
 * control that silently does nothing is a Guideline 2.1 completeness problem.
 *
 * `isSpeechEnabledAvatar` already existed for exactly this gate and was never
 * called anywhere. These tests keep it wired.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

test('the default stylist identity has no voice profile', () => {
  const identity = readSource('constants/stylistIdentity.ts');

  // If this ever stops being true the gate below becomes dead weight rather
  // than a bug fix, and this file should be revisited instead of deleted.
  assert.match(
    identity,
    /DEFAULT_STYLIST_IDENTITY[\s\S]{0,200}?avatarId:\s*'elise_default'/,
    'the default avatar is expected to be elise_default',
  );
  assert.match(
    identity,
    /id:\s*'elise_default'[\s\S]{0,400}?voiceProfile:\s*'silent'/,
    'elise_default is expected to be a silent profile',
  );
});

test('speech is dropped for a silent profile, which is why the gate is needed', () => {
  const styleChat = readSource('hooks/useStyleChat.ts');
  assert.match(
    styleChat,
    /canSpeakNewMessages[\s\S]{0,300}?voiceProfile !== 'silent'/,
    'useStyleChat must keep refusing to speak for a silent profile',
  );
});

test('the voice toggle is disabled when the saved stylist look has no voice', () => {
  const modal = readSource('components/stylist/PersonalizeStylistModal.tsx');

  assert.match(
    modal,
    /import \{[\s\S]*?isSpeechEnabledAvatar[\s\S]*?\} from '\.\.\/\.\.\/constants\/stylistIdentity'/,
    'the modal must import the speech-capability helper',
  );
  assert.match(
    modal,
    /const avatarSupportsVoice = isSpeechEnabledAvatar\(identity\.avatarId\);/,
    'the gate must read the SAVED identity — the draft avatar is not in effect yet',
  );
  assert.match(
    modal,
    /const voiceSwitchDisabled =[\s\S]{0,120}?!avatarSupportsVoice/,
    'the switch must be disabled when the look has no voice',
  );
  assert.match(
    modal,
    /const voiceSwitchOn = voicePreference\.enabled && avatarSupportsVoice;/,
    'the switch must never display On while speech is impossible',
  );
  assert.match(
    modal,
    /disabled: voiceSwitchDisabled/,
    'the disabled state must reach assistive technology too',
  );
});

test('the disabled state explains itself instead of failing silently', () => {
  const modal = readSource('components/stylist/PersonalizeStylistModal.tsx');
  assert.match(
    modal,
    /This stylist look has no voice\. Choose a portrait stylist to turn on spoken replies\./,
    'the helper text must tell the user how to get spoken replies',
  );
});

test('the stored preference survives so returning to a portrait look restores voice', () => {
  const modal = readSource('components/stylist/PersonalizeStylistModal.tsx');
  // The gate is presentational only. Nothing in the modal may clear the
  // persisted preference on a silent look, or a user who tries an abstract
  // avatar would lose a setting they never turned off.
  assert.ok(
    !/setEnabled\(false\)/.test(modal),
    'the modal must not silently switch the stored preference off',
  );
});

test('voice playback needs no microphone permission', () => {
  const playback = readSource('services/avatars/stylistAudioPlayback.ts');

  // Spoken replies are playback-only. expo-audio's audio mode is what would
  // pull a microphone permission into the archive, and it is pinned off here.
  assert.match(playback, /allowsRecording:\s*false/);
  assert.match(playback, /allowsBackgroundRecording:\s*false/);
  assert.ok(
    !/allowsRecording:\s*true|allowsBackgroundRecording:\s*true/.test(playback),
    'enabling recording would add NSMicrophoneUsageDescription to the archive',
  );
  assert.ok(
    !/requestRecordingPermissionsAsync|AudioRecorder|useAudioRecorder/.test(playback),
    'no recording API may be reachable from the playback path',
  );
});
