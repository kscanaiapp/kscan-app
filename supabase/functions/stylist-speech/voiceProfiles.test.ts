import assert from 'node:assert/strict';
import { StylistSpeechError } from './types.ts';
import {
  APPROVED_SPEAKING_STYLIST_IDS,
  resolveServerVoiceProfile,
  resolveServerVoiceSelection,
} from './voiceProfiles.ts';

// Owner-approved per-stylist mapping. stylistId -> [profile, secretName].
// No literal ElevenLabs voice ID appears anywhere in this registry — the
// actual value lives only in the Supabase secrets store, resolved at request
// time through readRequiredSecret (see elevenLabsClient.test.ts).
const OWNER_APPROVED_MAPPING: Readonly<Record<string, readonly [string, string]>> = Object.freeze({
  elise_default: ['feminine', 'ELEVENLABS_STYLIST_01_VOICE_ID'],
  stylist_portrait_01: ['feminine', 'ELEVENLABS_STYLIST_01_VOICE_ID'],
  stylist_portrait_02: ['masculine', 'ELEVENLABS_STYLIST_02_VOICE_ID'],
  stylist_portrait_03: ['feminine', 'ELEVENLABS_STYLIST_03_VOICE_ID'],
  stylist_portrait_04: ['feminine', 'ELEVENLABS_STYLIST_04_VOICE_ID'],
  stylist_portrait_05: ['feminine', 'ELEVENLABS_STYLIST_05_VOICE_ID'],
  stylist_portrait_06: ['feminine', 'ELEVENLABS_STYLIST_06_VOICE_ID'],
  stylist_portrait_07: ['feminine', 'ELEVENLABS_STYLIST_07_VOICE_ID'],
  stylist_portrait_08: ['masculine', 'ELEVENLABS_STYLIST_08_VOICE_ID'],
  stylist_portrait_09: ['masculine', 'ELEVENLABS_STYLIST_09_VOICE_ID'],
  stylist_portrait_10: ['feminine', 'ELEVENLABS_STYLIST_10_VOICE_ID'],
});

Deno.test('server allowlist maps default Elise and all ten approved portrait IDs explicitly', () => {
  assert.equal(APPROVED_SPEAKING_STYLIST_IDS.length, 11);
  assert.equal(APPROVED_SPEAKING_STYLIST_IDS[0], 'elise_default');
  APPROVED_SPEAKING_STYLIST_IDS.slice(1).forEach((id, index) => {
    assert.equal(id, `stylist_portrait_${String(index + 1).padStart(2, '0')}`);
  });
});

Deno.test('resolveServerVoiceSelection maps every stylist to its exact owner-approved voice secret name', () => {
  for (const [stylistId, [profile, voiceSecretName]] of Object.entries(OWNER_APPROVED_MAPPING)) {
    const selection = resolveServerVoiceSelection(stylistId);
    assert.equal(selection.profile, profile, `${stylistId} profile mismatch`);
    assert.equal(selection.voiceSecretName, voiceSecretName, `${stylistId} voiceSecretName mismatch`);
  }
});

Deno.test('resolveServerVoiceProfile remains a thin wrapper over the voice selection', () => {
  for (const [stylistId, [profile]] of Object.entries(OWNER_APPROVED_MAPPING)) {
    assert.equal(resolveServerVoiceProfile(stylistId), profile);
  }
});

Deno.test('only the two canonical Elise IDs intentionally share a voice secret', () => {
  const bySecret = new Map<string, string[]>();
  for (const [stylistId, [, voiceSecretName]] of Object.entries(OWNER_APPROVED_MAPPING)) {
    bySecret.set(voiceSecretName, [...(bySecret.get(voiceSecretName) ?? []), stylistId]);
  }
  const shared = [...bySecret.entries()].filter(([, stylistIds]) => stylistIds.length > 1);
  assert.deepEqual(shared, [[
    'ELEVENLABS_STYLIST_01_VOICE_ID',
    ['elise_default', 'stylist_portrait_01'],
  ]]);
});

Deno.test('masculine stylists resolve independently — sharing a profile does not mean sharing a voice secret', () => {
  // stylist_portrait_02 (Henry), 08 (Mark), 09 (David) all share the
  // "masculine" profile but must each resolve to their own configured secret.
  const henry = resolveServerVoiceSelection('stylist_portrait_02');
  const mark = resolveServerVoiceSelection('stylist_portrait_08');
  const david = resolveServerVoiceSelection('stylist_portrait_09');

  assert.equal(henry.voiceSecretName, 'ELEVENLABS_STYLIST_02_VOICE_ID');
  assert.equal(mark.voiceSecretName, 'ELEVENLABS_STYLIST_08_VOICE_ID');
  assert.equal(david.voiceSecretName, 'ELEVENLABS_STYLIST_09_VOICE_ID');

  assert.notEqual(henry.voiceSecretName, mark.voiceSecretName);
  assert.notEqual(henry.voiceSecretName, david.voiceSecretName);
  assert.notEqual(mark.voiceSecretName, david.voiceSecretName);
});

Deno.test('feminine stylists resolve independently — sharing a profile does not mean sharing a voice secret', () => {
  // stylist_portrait_01 (Elise), 04 (Marie), 06 (Vivian), 10 (Kim) all share
  // the "feminine" profile but must each resolve to their own configured secret.
  const elise = resolveServerVoiceSelection('stylist_portrait_01');
  const marie = resolveServerVoiceSelection('stylist_portrait_04');
  const vivian = resolveServerVoiceSelection('stylist_portrait_06');
  const kim = resolveServerVoiceSelection('stylist_portrait_10');

  const secretNames = [elise.voiceSecretName, marie.voiceSecretName, vivian.voiceSecretName, kim.voiceSecretName];
  assert.equal(new Set(secretNames).size, secretNames.length);
  assert.equal(elise.voiceSecretName, 'ELEVENLABS_STYLIST_01_VOICE_ID');
  assert.equal(marie.voiceSecretName, 'ELEVENLABS_STYLIST_04_VOICE_ID');
  assert.equal(vivian.voiceSecretName, 'ELEVENLABS_STYLIST_06_VOICE_ID');
  assert.equal(kim.voiceSecretName, 'ELEVENLABS_STYLIST_10_VOICE_ID');
});

Deno.test('default Elise resolves while intentionally silent and unsupported IDs remain rejected', () => {
  assert.deepEqual(resolveServerVoiceSelection('elise_default'), {
    profile: 'feminine',
    voiceSecretName: 'ELEVENLABS_STYLIST_01_VOICE_ID',
  });
  assert.throws(
    () => resolveServerVoiceSelection('editorial_plum'),
    (error) => error instanceof StylistSpeechError && error.code === 'STYLIST_SILENT',
  );
  assert.throws(
    () => resolveServerVoiceSelection('stylist_portrait_11'),
    (error) => error instanceof StylistSpeechError && error.code === 'STYLIST_UNSUPPORTED',
  );
  assert.throws(
    () => resolveServerVoiceProfile('chrome_muse'),
    (error) => error instanceof StylistSpeechError && error.code === 'STYLIST_SILENT',
  );
});

Deno.test('no entry in the registry is an ElevenLabs voice ID literal — every entry is a secret name', () => {
  // A defensive shape check: secret names are SCREAMING_SNAKE_CASE and start
  // with ELEVENLABS_, which is structurally impossible for an opaque
  // ElevenLabs voice ID (mixed-case alphanumeric, no underscores).
  for (const stylistId of APPROVED_SPEAKING_STYLIST_IDS) {
    const { voiceSecretName } = resolveServerVoiceSelection(stylistId);
    assert.match(voiceSecretName, /^ELEVENLABS_STYLIST_\d{2}_VOICE_ID$/);
  }
});
