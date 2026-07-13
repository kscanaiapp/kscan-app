import type { AvatarEntry } from './types';

/**
 * Avatar registry.
 *
 * This registry was created because the codebase previously had no centralized
 * avatar/stylist configuration. Speech fields are optional and default to
 * disabled, so existing consumers are unaffected.
 *
 * CURRENT STATE:
 * - No production portrait assets exist in the repo.
 * - No owner-approved voices are configured.
 * - The only registered entry is a disabled placeholder.
 *
 * To enable speech for a portrait, add an entry with:
 *   - a front-facing, evenly-lit portrait asset;
 *   - an owner-approved voiceProfile ('feminine' | 'masculine');
 *   - a validated NormalizedMouthRegion (for 'mouth_overlay');
 *   - greetingSpeechEnabled / responseSpeechEnabled flags.
 */

export const PLACEHOLDER_AVATAR_ID = 'elise-placeholder';
export const DEFAULT_STYLIST_NAME = 'Elise';

export const AVATAR_REGISTRY: Record<string, AvatarEntry> = {
  [PLACEHOLDER_AVATAR_ID]: {
    id: PLACEHOLDER_AVATAR_ID,
    kind: 'placeholder',
    enabled: false,
    name: DEFAULT_STYLIST_NAME,
    assetSource: null,
    speech: {
      speechEnabled: false,
      voiceProfile: undefined,
      mouthRegion: undefined,
      speakingMotionMode: 'none',
    },
    greetingSpeechEnabled: false,
    responseSpeechEnabled: false,
  },
};

export function getAvatarEntry(id: string | null | undefined): AvatarEntry | null {
  if (!id) return null;
  const entry = AVATAR_REGISTRY[id];
  return entry ?? null;
}

export function getEnabledAvatars(): AvatarEntry[] {
  return Object.values(AVATAR_REGISTRY).filter((a) => a.enabled);
}

export function getDefaultAvatar(): AvatarEntry {
  return AVATAR_REGISTRY[PLACEHOLDER_AVATAR_ID];
}
