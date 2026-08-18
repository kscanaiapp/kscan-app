import {
  StylistSpeechError,
  type StylistSpeechVoiceProfile,
} from './types.ts';

export interface StylistVoiceSelection {
  profile: StylistSpeechVoiceProfile;
  voiceSecretName: string;
}

// Per-stylist voice mapping. The registry holds only the secret NAME that
// stores each stylist's ElevenLabs voice ID, never the ID itself — the actual
// value is resolved at request time through the existing readRequiredSecret
// validation boundary (see elevenLabsClient.ts) and is never returned to the
// mobile client. The broad feminine/masculine profile remains in the public
// response for backward compatibility and grouped diagnostics.
//
// The profile column is no longer a mechanical alternation: it now states how
// each portrait actually presents, so a feminine-presenting stylist can never
// be grouped under a masculine profile in diagnostics.
const VOICE_ENTRIES = [
  ['stylist_portrait_01', 'feminine', 'ELEVENLABS_STYLIST_01_VOICE_ID'], // Elise
  ['stylist_portrait_02', 'masculine', 'ELEVENLABS_STYLIST_02_VOICE_ID'], // Henry
  ['stylist_portrait_03', 'feminine', 'ELEVENLABS_STYLIST_03_VOICE_ID'], // Janet
  ['stylist_portrait_04', 'feminine', 'ELEVENLABS_STYLIST_04_VOICE_ID'], // Marie
  ['stylist_portrait_05', 'feminine', 'ELEVENLABS_STYLIST_05_VOICE_ID'], // Sarah
  ['stylist_portrait_06', 'feminine', 'ELEVENLABS_STYLIST_06_VOICE_ID'], // Vivian
  ['stylist_portrait_07', 'feminine', 'ELEVENLABS_STYLIST_07_VOICE_ID'], // Isabella
  ['stylist_portrait_08', 'masculine', 'ELEVENLABS_STYLIST_08_VOICE_ID'], // Mark
  ['stylist_portrait_09', 'masculine', 'ELEVENLABS_STYLIST_09_VOICE_ID'], // David
  ['stylist_portrait_10', 'feminine', 'ELEVENLABS_STYLIST_10_VOICE_ID'], // Kim
] as const satisfies readonly (readonly [string, StylistSpeechVoiceProfile, string])[];

const VOICE_BY_STYLIST_ID = new Map<string, StylistVoiceSelection>(
  VOICE_ENTRIES.map(([stylistId, profile, voiceSecretName]) => [stylistId, { profile, voiceSecretName }]),
);

const SILENT_STYLIST_IDS = new Set([
  'elise_default',
  'editorial_plum',
  'chrome_muse',
  'deep_space',
  'cream_gold',
  'obsidian_orchid',
]);

export const APPROVED_SPEAKING_STYLIST_IDS = Object.freeze(
  VOICE_ENTRIES.map(([stylistId]) => stylistId),
);

export function resolveServerVoiceSelection(stylistId: string): StylistVoiceSelection {
  const selection = VOICE_BY_STYLIST_ID.get(stylistId);
  if (selection) return selection;
  if (SILENT_STYLIST_IDS.has(stylistId)) {
    throw new StylistSpeechError(422, 'STYLIST_SILENT', 'Speech is not available for this stylist.');
  }
  throw new StylistSpeechError(422, 'STYLIST_UNSUPPORTED', 'Speech is not available for this stylist.');
}

/** Backward-compatible profile lookup for callers that only need the grouping. */
export function resolveServerVoiceProfile(stylistId: string): StylistSpeechVoiceProfile {
  return resolveServerVoiceSelection(stylistId).profile;
}

export function isKnownStylistId(stylistId: string): boolean {
  return VOICE_BY_STYLIST_ID.has(stylistId) || SILENT_STYLIST_IDS.has(stylistId);
}
