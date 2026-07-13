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

// ── Discriminated avatar preset union ─────────────────────────────────────────
//
// `kind` separates abstract vector treatments from photorealistic portraits.
// `availability` separates shipped presets from placeholder slots so invalid
// states are unrepresentable: a placeholder cannot carry a `source`, and a
// ready portrait must carry a `source`. Only presets with `persistable: true`
// may be written to `user_stylist_preferences.avatar_id`.

export type StylistAvatarPresetAbstract = {
  kind: 'abstract';
  availability: 'ready';
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
  source?: never;
  selectable: true;
  persistable: true;
};

export type StylistAvatarPresetPortraitPlaceholder = {
  kind: 'portrait';
  availability: 'placeholder';
  id: string;
  accessibilityLabel: string;
  source?: never;
  selectable: false;
  persistable: false;
};

export type StylistAvatarPresetPortraitReady = {
  kind: 'portrait';
  availability: 'ready';
  id: string;
  accessibilityLabel: string;
  /** Numeric Metro module reference returned by a static local `require(...)`. */
  source: number;
  selectable: true;
  persistable: true;
};

export type StylistAvatarPreset =
  | StylistAvatarPresetAbstract
  | StylistAvatarPresetPortraitPlaceholder
  | StylistAvatarPresetPortraitReady;

export function getStylistAvatarSection(
  preset: Pick<StylistAvatarPreset, 'kind'>,
): 'abstract' | 'people' {
  return preset.kind === 'portrait' ? 'people' : 'abstract';
}

export function isRenderablePortraitPreset(
  value: unknown,
): value is StylistAvatarPresetPortraitReady {
  if (!value || typeof value !== 'object') return false;
  const preset = value as Record<string, unknown>;
  return (
    preset.kind === 'portrait' &&
    preset.availability === 'ready' &&
    preset.selectable === true &&
    preset.persistable === true &&
    typeof preset.source === 'number' &&
    Number.isFinite(preset.source) &&
    preset.source > 0
  );
}

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
 * Abstract, non-photographic vector treatments rendered by the StylistAvatar
 * component. These are fully selectable and persistable today.
 */
const ABSTRACT_PRESET_DEFINITIONS: StylistAvatarPresetAbstract[] = [
  {
    id: 'elise_default',
    kind: 'abstract',
    availability: 'ready',
    accessibilityLabel: 'Elise default avatar',
    backgroundColor: '#F5F0E8',
    accentColor: '#C6A15B',
    symbol: '✦',
    symbolColor: '#52103E',
    selectable: true,
    persistable: true,
  },
  {
    id: 'editorial_plum',
    kind: 'abstract',
    availability: 'ready',
    accessibilityLabel: 'Editorial plum stylist avatar',
    backgroundColor: '#EEE4EC',
    accentColor: '#52103E',
    symbol: '◆',
    symbolColor: '#52103E',
    selectable: true,
    persistable: true,
  },
  {
    id: 'chrome_muse',
    kind: 'abstract',
    availability: 'ready',
    accessibilityLabel: 'Chrome muse stylist avatar',
    backgroundColor: '#E8E1EC',
    accentColor: '#8A8178',
    symbol: '◇',
    symbolColor: '#5E5650',
    selectable: true,
    persistable: true,
  },
  {
    id: 'deep_space',
    kind: 'abstract',
    availability: 'ready',
    accessibilityLabel: 'Deep space stylist avatar',
    backgroundColor: '#26041D',
    accentColor: '#22D3EE',
    symbol: '✧',
    symbolColor: '#FFFDF9',
    selectable: true,
    persistable: true,
  },
  {
    id: 'cream_gold',
    kind: 'abstract',
    availability: 'ready',
    accessibilityLabel: 'Cream and gold stylist avatar',
    backgroundColor: '#FFFDF9',
    accentColor: '#C6A15B',
    symbol: '✶',
    symbolColor: '#B08D4B',
    selectable: true,
    persistable: true,
  },
  {
    id: 'obsidian_orchid',
    kind: 'abstract',
    availability: 'ready',
    accessibilityLabel: 'Obsidian orchid stylist avatar',
    backgroundColor: '#09070D',
    accentColor: '#7A3A68',
    symbol: '✿',
    symbolColor: '#E7D4A8',
    selectable: true,
    persistable: true,
  },
];

/**
 * Shipped photorealistic portrait presets for the People section. Each preset
 * carries a static local asset reference so Metro can bundle it and the
 * StylistAvatar component can render a native <Image>.
 */
const PORTRAIT_PRESET_DEFINITIONS: StylistAvatarPresetPortraitReady[] = [
  {
    id: 'stylist_portrait_01',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait with braided updo and cream blazer',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_01.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_02',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait with short hair, glasses, and red polo',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_02.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_03',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 3',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_03.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_04',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 4',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_04.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_05',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 5',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_05.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_06',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 6',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_06.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_07',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 7',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_07.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_08',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 8',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_08.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_09',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 9',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_09.jpg') : 1,
    selectable: true,
    persistable: true,
  },
  {
    id: 'stylist_portrait_10',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 10',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_10.jpg') : 1,
    selectable: true,
    persistable: true,
  },
];

const ABSTRACT_PRESETS: readonly StylistAvatarPresetAbstract[] = Object.freeze(
  ABSTRACT_PRESET_DEFINITIONS.map((preset) => Object.freeze(preset)),
);

const PORTRAIT_PRESETS: readonly StylistAvatarPresetPortraitReady[] = Object.freeze(
  PORTRAIT_PRESET_DEFINITIONS.map((preset) => Object.freeze(preset)),
);

/** Stable Abstract section used by the selector. */
export const STYLIST_ABSTRACT_PRESETS = ABSTRACT_PRESETS;

/** Stable People section. Ready portraits remain here after Phase 2 conversion. */
export const STYLIST_PORTRAIT_PRESETS: readonly StylistAvatarPresetPortraitReady[] = PORTRAIT_PRESETS;

/** Full registry of bundled avatar presets. */
export const STYLIST_AVATAR_PRESETS: readonly StylistAvatarPreset[] = Object.freeze([
  ...STYLIST_ABSTRACT_PRESETS,
  ...STYLIST_PORTRAIT_PRESETS,
]);

function createReadonlySet<T>(values: Iterable<T>): ReadonlySet<T> {
  const backing = new Set(values);
  let facade: ReadonlySet<T>;
  facade = Object.freeze({
    get size() {
      return backing.size;
    },
    has(value: T) {
      return backing.has(value);
    },
    entries() {
      return backing.entries();
    },
    keys() {
      return backing.keys();
    },
    values() {
      return backing.values();
    },
    union<U>(other: ReadonlySetLike<U>) {
      return backing.union(other);
    },
    intersection<U>(other: ReadonlySetLike<U>) {
      return backing.intersection(other);
    },
    difference<U>(other: ReadonlySetLike<U>) {
      return backing.difference(other);
    },
    symmetricDifference<U>(other: ReadonlySetLike<U>) {
      return backing.symmetricDifference(other);
    },
    isSubsetOf(other: ReadonlySetLike<unknown>) {
      return backing.isSubsetOf(other);
    },
    isSupersetOf(other: ReadonlySetLike<unknown>) {
      return backing.isSupersetOf(other);
    },
    isDisjointFrom(other: ReadonlySetLike<unknown>) {
      return backing.isDisjointFrom(other);
    },
    forEach(callback: (value: T, value2: T, set: ReadonlySet<T>) => void, thisArg?: unknown) {
      backing.forEach((value) => callback.call(thisArg, value, value, facade));
    },
    [Symbol.iterator]() {
      return backing[Symbol.iterator]();
    },
  });
  return facade;
}

function createReadonlyMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const backing = new Map(entries);
  let facade: ReadonlyMap<K, V>;
  facade = Object.freeze({
    get size() {
      return backing.size;
    },
    get(key: K) {
      return backing.get(key);
    },
    has(key: K) {
      return backing.has(key);
    },
    entries() {
      return backing.entries();
    },
    keys() {
      return backing.keys();
    },
    values() {
      return backing.values();
    },
    forEach(callback: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown) {
      backing.forEach((value, key) => callback.call(thisArg, value, key, facade));
    },
    [Symbol.iterator]() {
      return backing[Symbol.iterator]();
    },
  });
  return facade;
}

// ── Optional speech configuration ─────────────────────────────────────────────
//
// Speech metadata is keyed by existing preset IDs so the authoritative registry
// is never bypassed. Missing entries mean speech is disabled for that preset.
// This map may be extended after portrait visual inspection and owner-approved
// voice assignment.

export type StylistVoiceProfile = 'female' | 'male';

export type StylistSpeechMotionMode = 'mouth_overlay' | 'none';

export interface StylistSpeechConfiguration {
  speechEnabled?: boolean;
  voiceProfile?: StylistVoiceProfile;
  mouthRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  speakingMotionMode?: StylistSpeechMotionMode;
}

const SPEECH_CONFIG_ENTRIES: readonly [string, StylistSpeechConfiguration][] = Object.freeze([
  // Proposed speech configurations for lip-movement proof.
  // Voice profiles are proposed and require owner approval before production.
  [
    'stylist_portrait_02',
    {
      speechEnabled: true,
      voiceProfile: 'male',
      speakingMotionMode: 'mouth_overlay',
      mouthRegion: { x: 0.42, y: 0.65, width: 0.16, height: 0.07 },
    },
  ],
  [
    'stylist_portrait_05',
    {
      speechEnabled: true,
      voiceProfile: 'female',
      speakingMotionMode: 'mouth_overlay',
      mouthRegion: { x: 0.42, y: 0.64, width: 0.16, height: 0.07 },
    },
  ],
  [
    'stylist_portrait_08',
    {
      speechEnabled: true,
      voiceProfile: 'male',
      speakingMotionMode: 'mouth_overlay',
      mouthRegion: { x: 0.42, y: 0.64, width: 0.16, height: 0.07 },
    },
  ],
]);

/** Speech configuration keyed by existing avatar preset ID. */
export const STYLIST_SPEECH_CONFIG_BY_ID: ReadonlyMap<string, StylistSpeechConfiguration> =
  createReadonlyMap(SPEECH_CONFIG_ENTRIES);

/** Presets that are selectable in the personalization UI. */
export const STYLIST_SELECTABLE_PRESETS: readonly StylistAvatarPreset[] = Object.freeze(
  STYLIST_AVATAR_PRESETS.filter((p): p is StylistAvatarPreset & { selectable: true } => p.selectable),
);

/** Preset IDs that are allowed to be stored in `user_stylist_preferences.avatar_id`. */
export const STYLIST_PERSISTABLE_AVATAR_IDS: ReadonlySet<string> = Object.freeze(
  createReadonlySet(STYLIST_AVATAR_PRESETS.filter((p) => p.persistable).map((p) => p.id)),
);

/** O(1) preset lookup by id. */
export const STYLIST_AVATAR_PRESET_BY_ID: ReadonlyMap<string, StylistAvatarPreset> = Object.freeze(
  createReadonlyMap(STYLIST_AVATAR_PRESETS.map((p) => [p.id, p] as const)),
);

/** IDs reserved for future photorealistic portrait presets. */
export const STYLIST_PORTRAIT_PLACEHOLDER_IDS: readonly string[] = Object.freeze(
  STYLIST_AVATAR_PRESETS.filter(
    (p): p is StylistAvatarPresetPortraitPlaceholder =>
      p.kind === 'portrait' && p.availability === 'placeholder',
  ).map((p) => p.id),
);

export type StylistIdentityValidationReason =
  | 'unknown_avatar_id'
  | 'unavailable_avatar_id'
  | 'invalid_identity_input';

export class StylistIdentityValidationError extends Error {
  readonly code = 'STYLIST_IDENTITY_VALIDATION_ERROR' as const;
  readonly reason: StylistIdentityValidationReason;
  constructor(
    reason: StylistIdentityValidationReason,
    message: string,
  ) {
    super(message);
    this.reason = reason;
    this.name = 'StylistIdentityValidationError';
  }
}

export function isValidAvatarId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && STYLIST_AVATAR_PRESET_BY_ID.has(id);
}

export function isPersistableAvatarId(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && STYLIST_PERSISTABLE_AVATAR_IDS.has(id);
}

export function assertPersistableAvatarId(id: string): asserts id is string {
  if (!isValidAvatarId(id)) {
    throw new StylistIdentityValidationError(
      'unknown_avatar_id',
      'That stylist avatar is not recognized.',
    );
  }
  if (!isPersistableAvatarId(id)) {
    throw new StylistIdentityValidationError(
      'unavailable_avatar_id',
      'That stylist avatar is not available for selection yet.',
    );
  }
}

export function resolveAvatarId(id: string | null | undefined): string {
  return isPersistableAvatarId(id) ? id! : DEFAULT_STYLIST_IDENTITY.avatarId;
}

/**
 * Return the speech configuration for an avatar preset, or `undefined` when
 * the preset has no approved speech configuration. Missing metadata always
 * resolves to speech disabled.
 */
export function getStylistSpeechConfig(
  avatarId: string | null | undefined,
): StylistSpeechConfiguration | undefined {
  if (!avatarId) return undefined;
  return STYLIST_SPEECH_CONFIG_BY_ID.get(avatarId);
}

/**
 * Determine whether a preset is configured for speaking motion.
 * Abstract avatars and placeholders always return false.
 */
export function isSpeechEnabledAvatar(avatarId: string | null | undefined): boolean {
  const config = getStylistSpeechConfig(avatarId);
  return config?.speechEnabled === true && config.voiceProfile != null;
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
