import * as Speech from 'expo-speech';
import type { Voice, VoiceQuality } from 'expo-speech';
import type { StylistVoiceProfile } from '../constants/stylistIdentity';

/**
 * Approved voice IDs are configured via environment variables.
 *
 * The feature is fail-closed: if an owner has not explicitly configured a
 * premium voice, the app must not speak using an arbitrary device-default
 * voice in production.
 */
const APPROVED_FEMALE_VOICE_ID =
  process.env.EXPO_PUBLIC_APPROVED_FEMALE_VOICE_ID?.trim() || null;
const APPROVED_MALE_VOICE_ID =
  process.env.EXPO_PUBLIC_APPROVED_MALE_VOICE_ID?.trim() || null;

/**
 * Dev-only escape hatch for Expo Speech feasibility testing and manual voice
 * evaluation. Ignored in release builds.
 */
const DEVICE_FALLBACK_ALLOWED =
  __DEV__ && process.env.EXPO_PUBLIC_AVATAR_SPEECH_DEVICE_FALLBACK === 'true';

export interface ResolvedVoice {
  identifier: string;
  language: string;
  quality?: number;
  name?: string;
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

function scoreQuality(quality: VoiceQuality | undefined): number {
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
  return 'localService' in voice ? Boolean(voice.localService) : true;
}

function approvedIdForProfile(profile: StylistVoiceProfile): string | null {
  return profile === 'female' ? APPROVED_FEMALE_VOICE_ID : APPROVED_MALE_VOICE_ID;
}

/**
 * Resolve a voice for the requested profile.
 *
 * 1. Owner-approved voice ID must be configured (production).
 * 2. Discover installed voices and retain English voices.
 * 3. Prefer exact en-US, then approved en-* fallback.
 * 4. Prefer enhanced/local voices; use provider hints only as tie-breakers.
 * 5. If no approved voice is configured in dev, optionally use the best
 *    available device voice for feasibility testing.
 * 6. Otherwise fail closed.
 */
export async function resolveAvatarSpeechVoice(
  profile: StylistVoiceProfile,
): Promise<VoiceResolutionResult> {
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

  const candidates = voices
    .filter(isEnglishVoice)
    .map((voice) => ({
      voice,
      score:
        scoreLocale(voice.language) * 100 +
        scoreQuality(voice.quality) * 10 +
        (isLocalVoice(voice) ? 5 : 0) +
        (/\b(google|samsung)\b/i.test(voice.name) ? 1 : 0),
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return { voice: null, reason: 'no_english_voice' };
  }

  if (approvedId) {
    const matched = candidates.find((c) => c.voice.identifier === approvedId);
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

export function getApprovedVoiceStatus(): Record<StylistVoiceProfile, 'configured' | 'missing'> {
  return {
    female: APPROVED_FEMALE_VOICE_ID ? 'configured' : 'missing',
    male: APPROVED_MALE_VOICE_ID ? 'configured' : 'missing',
  };
}
