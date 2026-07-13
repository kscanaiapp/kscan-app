import * as Speech from 'expo-speech';
import type { Voice, VoiceQuality } from 'expo-speech';
import type { AvatarSpeechProfile, ResolvedVoice } from './types';

/**
 * Approved voice IDs are set via environment variables.
 *
 * The feature is intentionally fail-closed: if an owner has not explicitly
 * configured a premium voice, the app must not speak using an arbitrary
 * device-default voice.
 */
const APPROVED_FEMALE_VOICE_ID = process.env.EXPO_PUBLIC_APPROVED_FEMALE_VOICE_ID?.trim() || null;
const APPROVED_MALE_VOICE_ID = process.env.EXPO_PUBLIC_APPROVED_MALE_VOICE_ID?.trim() || null;

/**
 * Dev-only escape hatch for device-TTS feasibility testing.
 *
 * The production feature must use owner-approved voices. This flag is ignored
 * in release builds so the feature fails closed if approved voices are missing.
 */
const DEVICE_FALLBACK_ALLOWED = __DEV__ &&
  process.env.EXPO_PUBLIC_AVATAR_SPEECH_DEVICE_FALLBACK === 'true';

function scoreQuality(quality: VoiceQuality | undefined): number {
  // Prefer enhanced voices when the platform exposes quality metadata.
  if (quality === 'Enhanced') return 2;
  if (quality === 'Default') return 1;
  return 0;
}

function scoreLocale(language: string): number {
  const normalized = language.toLowerCase().replace(/_/g, '-');
  if (normalized === 'en-us') return 3;
  if (normalized.startsWith('en')) return 2;
  return 0;
}

function isEnglishVoice(voice: Voice): boolean {
  return voice.language.toLowerCase().startsWith('en');
}

function isLocalVoice(voice: Voice & { localService?: boolean }): boolean {
  // Web exposes localService; native voices are considered installed.
  return 'localService' in voice ? Boolean(voice.localService) : true;
}

function approvedIdForProfile(profile: AvatarSpeechProfile): string | null {
  return profile === 'feminine' ? APPROVED_FEMALE_VOICE_ID : APPROVED_MALE_VOICE_ID;
}

export interface VoiceResolutionResult {
  voice: ResolvedVoice | null;
  reason:
    | 'approved'
    | 'owner_review_required'
    | 'no_english_voice'
    | 'approved_unavailable'
    | 'device_fallback';
}

/**
 * Resolve a voice for the requested profile.
 *
 * Resolution order:
 * 1. Discover installed voices.
 * 2. Retain voices with a compatible English language tag.
 * 3. Prefer exact en-US where available.
 * 4. Otherwise allow approved en-* fallback.
 * 5. Prefer enhanced quality metadata when exposed.
 * 6. Prefer installed/local voices over voices requiring a download.
 * 7. Use curated provider-name hints only as a tie-breaker.
 * 8. Fall back to platform English default.
 * 9. If no usable English speech engine exists, disable speech gracefully.
 *
 * Additionally, because owner approval is mandatory, an approved voice ID must
 * be configured and found among the device voices. If it is not, the resolver
 * returns owner_review_required and speech remains disabled.
 */
export async function resolveVoice(profile: AvatarSpeechProfile): Promise<VoiceResolutionResult> {
  const approvedId = approvedIdForProfile(profile);

  if (!approvedId && !DEVICE_FALLBACK_ALLOWED) {
    return { voice: null, reason: 'owner_review_required' };
  }

  let voices: Voice[] = [];
  try {
    voices = await Speech.getAvailableVoicesAsync();
  } catch {
    voices = [];
  }

  if (voices.length === 0) {
    return { voice: null, reason: 'no_english_voice' };
  }

  const candidates = voices
    .filter(isEnglishVoice)
    .map((voice) => ({
      voice,
      score:
        scoreLocale(voice.language) * 100 +
        scoreQuality(voice.quality) * 10 +
        (isLocalVoice(voice as Voice & { localService?: boolean }) ? 5 : 0) +
        // Tie-breaker: curated provider hints (Google / Samsung). Not sufficient alone.
        (/\b(google|samsung)\b/i.test(voice.name) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { voice: null, reason: 'no_english_voice' };
  }

  const matched = approvedId ? candidates.find((c) => c.voice.identifier === approvedId) : null;
  if (matched) {
    return {
      voice: {
        identifier: matched.voice.identifier,
        language: matched.voice.language,
        quality: scoreQuality(matched.voice.quality),
        name: matched.voice.name,
      },
      reason: 'approved',
    };
  }

  if (approvedId) {
    // An approved ID was configured but is not installed. Fail closed rather than
    // substitute an unapproved system voice.
    return { voice: null, reason: 'approved_unavailable' };
  }

  if (DEVICE_FALLBACK_ALLOWED) {
    const best = candidates[0];
    return {
      voice: {
        identifier: best.voice.identifier,
        language: best.voice.language,
        quality: scoreQuality(best.voice.quality),
        name: best.voice.name,
      },
      reason: 'device_fallback',
    };
  }

  return { voice: null, reason: 'owner_review_required' };
}

export function getApprovedVoiceStatus(): Record<AvatarSpeechProfile, 'configured' | 'missing'> {
  return {
    feminine: APPROVED_FEMALE_VOICE_ID ? 'configured' : 'missing',
    masculine: APPROVED_MALE_VOICE_ID ? 'configured' : 'missing',
  };
}
