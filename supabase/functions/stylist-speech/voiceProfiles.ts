import {
  StylistSpeechError,
  type StylistSpeechVoiceProfile,
} from './types.ts';

const PROFILE_ENTRIES = [
  ['stylist_portrait_01', 'feminine'],
  ['stylist_portrait_02', 'masculine'],
  ['stylist_portrait_03', 'feminine'],
  ['stylist_portrait_04', 'masculine'],
  ['stylist_portrait_05', 'feminine'],
  ['stylist_portrait_06', 'masculine'],
  ['stylist_portrait_07', 'feminine'],
  ['stylist_portrait_08', 'masculine'],
  ['stylist_portrait_09', 'feminine'],
  ['stylist_portrait_10', 'masculine'],
] as const satisfies readonly (readonly [string, StylistSpeechVoiceProfile])[];

const PROFILE_BY_STYLIST_ID = new Map<string, StylistSpeechVoiceProfile>(PROFILE_ENTRIES);

const SILENT_STYLIST_IDS = new Set([
  'elise_default',
  'editorial_plum',
  'chrome_muse',
  'deep_space',
  'cream_gold',
  'obsidian_orchid',
]);

export const APPROVED_SPEAKING_STYLIST_IDS = Object.freeze(
  PROFILE_ENTRIES.map(([stylistId]) => stylistId),
);

export function resolveServerVoiceProfile(stylistId: string): StylistSpeechVoiceProfile {
  const profile = PROFILE_BY_STYLIST_ID.get(stylistId);
  if (profile) return profile;
  if (SILENT_STYLIST_IDS.has(stylistId)) {
    throw new StylistSpeechError(422, 'STYLIST_SILENT', 'Speech is not available for this stylist.');
  }
  throw new StylistSpeechError(422, 'STYLIST_UNSUPPORTED', 'Speech is not available for this stylist.');
}

export function isKnownStylistId(stylistId: string): boolean {
  return PROFILE_BY_STYLIST_ID.has(stylistId) || SILENT_STYLIST_IDS.has(stylistId);
}

/** Authoritative voice-registry entry (no provider secrets / voice IDs). */
export interface EliseVoiceRegistryEntry {
  avatarId: string;
  voiceAlias: StylistSpeechVoiceProfile | 'silent';
  provider: 'elevenlabs' | 'none';
  modelAlias: 'configured' | 'none';
  speechEnabled: boolean;
  fallback: 'fail_speech_preserve_text';
}

export function resolveVoiceRegistryEntry(stylistId: string): EliseVoiceRegistryEntry {
  const profile = PROFILE_BY_STYLIST_ID.get(stylistId);
  if (profile) {
    return {
      avatarId: stylistId,
      voiceAlias: profile,
      provider: 'elevenlabs',
      modelAlias: 'configured',
      speechEnabled: true,
      fallback: 'fail_speech_preserve_text',
    };
  }
  if (SILENT_STYLIST_IDS.has(stylistId)) {
    return {
      avatarId: stylistId,
      voiceAlias: 'silent',
      provider: 'none',
      modelAlias: 'none',
      speechEnabled: false,
      fallback: 'fail_speech_preserve_text',
    };
  }
  throw new StylistSpeechError(422, 'STYLIST_UNSUPPORTED', 'Speech is not available for this stylist.');
}
