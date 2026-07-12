// Stylist identity constants for the unified Elise customer-facing layer.
//
// Internal technical identifiers (StyleChat, AI Stylist, stylechat-generate,
// style-outfit-generate, etc.) are NOT renamed here. This module only defines
// the user-facing display name, avatar presets, and validation rules so the
// same identity can be rendered consistently across Home, the conversation
// list, and the chat session screen.

export type StylistIdentity = {
  displayName: string;
  avatarId: string;
};

export type StylistAvatarPreset = {
  id: string;
  accessibilityLabel: string;
  /** Primary background color (React Native color string). */
  backgroundColor: string;
  /** Accent ring/overlay color. */
  accentColor: string;
  /** Symbol rendered inside the avatar (single visible character or emoji). */
  symbol: string;
  /** Symbol color. */
  symbolColor: string;
};

/** Stable default identity. Never mutate at runtime. */
export const DEFAULT_STYLIST_IDENTITY: StylistIdentity = Object.freeze({
  displayName: 'Elise',
  avatarId: 'elise_default',
});

/** Maximum display-name length enforced by UI and persistence. */
export const STYLIST_NAME_MAX_LENGTH = 24;

/** Minimum visible display-name length. */
export const STYLIST_NAME_MIN_LENGTH = 2;

/**
 * Static registry of bundled local avatar presets. These are abstract,
 * non-photographic vector treatments rendered by the StylistAvatar component.
 * No remote URLs, no user uploads, and no dynamic require() paths are used.
 */
export const STYLIST_AVATAR_PRESETS: StylistAvatarPreset[] = [
  {
    id: 'elise_default',
    accessibilityLabel: 'Elise default avatar',
    backgroundColor: '#F5F0E8',
    accentColor: '#C6A15B',
    symbol: '✦',
    symbolColor: '#52103E',
  },
  {
    id: 'editorial_plum',
    accessibilityLabel: 'Editorial plum stylist avatar',
    backgroundColor: '#EEE4EC',
    accentColor: '#52103E',
    symbol: '◆',
    symbolColor: '#52103E',
  },
  {
    id: 'chrome_muse',
    accessibilityLabel: 'Chrome muse stylist avatar',
    backgroundColor: '#E8E1EC',
    accentColor: '#8A8178',
    symbol: '◇',
    symbolColor: '#5E5650',
  },
  {
    id: 'deep_space',
    accessibilityLabel: 'Deep space stylist avatar',
    backgroundColor: '#26041D',
    accentColor: '#22D3EE',
    symbol: '✧',
    symbolColor: '#FFFDF9',
  },
  {
    id: 'cream_gold',
    accessibilityLabel: 'Cream and gold stylist avatar',
    backgroundColor: '#FFFDF9',
    accentColor: '#C6A15B',
    symbol: '✶',
    symbolColor: '#B08D4B',
  },
  {
    id: 'obsidian_orchid',
    accessibilityLabel: 'Obsidian orchid stylist avatar',
    backgroundColor: '#09070D',
    accentColor: '#7A3A68',
    symbol: '✿',
    symbolColor: '#E7D4A8',
  },
];

const PRESET_ID_SET = new Set(STYLIST_AVATAR_PRESETS.map((p) => p.id));

export function isValidAvatarId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && PRESET_ID_SET.has(id);
}

export function resolveAvatarId(id: string | null | undefined): string {
  return isValidAvatarId(id) ? id! : DEFAULT_STYLIST_IDENTITY.avatarId;
}

/**
 * Sanitize and validate a user-entered stylist name.
 * Returns the safe value and a flag; invalid input falls back to the default.
 */
export function sanitizeStylistName(value: unknown): {
  value: string;
  valid: boolean;
  truncated?: boolean;
} {
  if (typeof value !== 'string') {
    return { value: DEFAULT_STYLIST_IDENTITY.displayName, valid: false };
  }

  // Strip control characters (0x00–0x1F and 0x7F).
  let cleaned = value.replace(/[\x00-\x1F\x7F]/g, '').trim();

  if (cleaned.length === 0) {
    return { value: DEFAULT_STYLIST_IDENTITY.displayName, valid: false };
  }

  if (cleaned.length < STYLIST_NAME_MIN_LENGTH) {
    return { value: DEFAULT_STYLIST_IDENTITY.displayName, valid: false };
  }

  if (cleaned.length > STYLIST_NAME_MAX_LENGTH) {
    return { value: cleaned.slice(0, STYLIST_NAME_MAX_LENGTH), valid: false };
  }

  return { value: cleaned, valid: true };
}

/**
 * Build a validated identity object from raw persisted data. This is the only
 * place raw storage rows should be normalized so every consumer receives the
 * same safe fallback.
 */
export function normalizeStylistIdentity(raw: unknown): StylistIdentity {
  const fallback = DEFAULT_STYLIST_IDENTITY;
  if (!raw || typeof raw !== 'object') return fallback;

  const record = raw as Record<string, unknown>;
  const nameResult = sanitizeStylistName(record.display_name ?? record.displayName);
  const avatarId = resolveAvatarId(
    typeof record.avatar_id === 'string'
      ? record.avatar_id
      : typeof record.avatarId === 'string'
        ? record.avatarId
        : undefined,
  );

  const displayName = nameResult.valid ? nameResult.value : fallback.displayName;
  return displayName === fallback.displayName && avatarId === fallback.avatarId
    ? fallback
    : Object.freeze({ displayName, avatarId });
}
