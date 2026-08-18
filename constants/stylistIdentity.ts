// Stylist identity constants for the unified Elise customer-facing layer.
//
// Internal technical identifiers (StyleChat, AI Stylist, stylechat-generate,
// style-outfit-generate, etc.) are NOT renamed here. This module only defines
// the user-facing display name, avatar presets, and validation rules so the
// same identity can be rendered consistently across Home, the conversation
// list, and the chat session screen.

export type StylistIdentity = {
  /** Resolved for display: the custom name if one is set, else the canonical
   *  name for avatarId, else the safe default. This is what every consumer
   *  (UI, greeting, model persona) already reads and continues to read
   *  unchanged (Fix #6 resolves this value; it does not change its shape). */
  displayName: string;
  avatarId: string;
};

export type StylistVoiceProfile = 'feminine' | 'masculine' | 'silent';

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
  voiceProfile: 'silent';
};

export type StylistAvatarPresetPortraitPlaceholder = {
  kind: 'portrait';
  availability: 'placeholder';
  id: string;
  accessibilityLabel: string;
  source?: never;
  selectable: false;
  persistable: false;
  voiceProfile: 'silent';
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
  voiceProfile: Exclude<StylistVoiceProfile, 'silent'>;
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

// ── Fix #6 — canonical per-portrait names and the single name resolver ──────
//
// Every shipped portrait has a default display name; a generic/abstract avatar
// (including the system default) resolves to "Elise", the system identity — not
// specific to stylist_portrait_01. A user's custom name (set via
// PersonalizeStylistModal) always overrides the resolved default. THIS is the
// one place that precedence is decided; every consumer (Home, StyleChatHeader,
// greeting composition, the backend model persona) resolves through
// normalizeStylistIdentity's already-resolved `displayName` rather than
// re-implementing the rule.

export const CANONICAL_PORTRAIT_NAMES: ReadonlyMap<string, string> = Object.freeze(
  new Map([
    ['stylist_portrait_01', 'Elise'],
    ['stylist_portrait_02', 'Henry'],
    ['stylist_portrait_03', 'Janet'],
    ['stylist_portrait_04', 'Marie'],
    ['stylist_portrait_05', 'Sarah'],
    ['stylist_portrait_06', 'Vivian'],
    ['stylist_portrait_07', 'Isabella'],
    ['stylist_portrait_08', 'Michael'],
    ['stylist_portrait_09', 'David'],
    ['stylist_portrait_10', 'Kim'],
  ]),
);

/** Canonical default name for a portrait; abstract presets/unknown ids fall back to the safe default. */
export function resolveCanonicalStylistName(avatarId: string | null | undefined): string {
  if (!avatarId) return DEFAULT_STYLIST_IDENTITY.displayName;
  return CANONICAL_PORTRAIT_NAMES.get(avatarId) ?? DEFAULT_STYLIST_IDENTITY.displayName;
}

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
    voiceProfile: 'silent',
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
    voiceProfile: 'silent',
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
    voiceProfile: 'silent',
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
    voiceProfile: 'silent',
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
    voiceProfile: 'silent',
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
    voiceProfile: 'silent',
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
    accessibilityLabel: 'Stylist portrait with long box braids and a black top',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_01.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'feminine',
  },
  {
    id: 'stylist_portrait_02',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait with short hair, trimmed beard, and blue polo',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_02.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'masculine',
  },
  {
    id: 'stylist_portrait_03',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 3',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_03.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'feminine',
  },
  {
    id: 'stylist_portrait_04',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 4',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_04.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'masculine',
  },
  {
    id: 'stylist_portrait_05',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 5',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_05.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'feminine',
  },
  {
    id: 'stylist_portrait_06',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 6',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_06.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'masculine',
  },
  {
    id: 'stylist_portrait_07',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 7',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_07.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'feminine',
  },
  {
    id: 'stylist_portrait_08',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 8',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_08.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'masculine',
  },
  {
    id: 'stylist_portrait_09',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 9',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_09.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'feminine',
  },
  {
    id: 'stylist_portrait_10',
    kind: 'portrait',
    availability: 'ready',
    accessibilityLabel: 'Stylist portrait 10',
    source: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/stylist_portrait_10.jpg') : 1,
    selectable: true,
    persistable: true,
    voiceProfile: 'masculine',
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

// ── Optional animation-ready mouth assets ─────────────────────────────────────
//
// Voice assignment lives directly on the authoritative preset. Mouth-state
// assets remain a separate optional capability because the current approved
// portraits are static JPEGs and must not be distorted to imitate lip sync.

export type StylistSpeechMotionMode = 'mouth_states' | 'none';

export interface StylistSpeechConfiguration {
  mouthRegion?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  speakingMotionMode?: StylistSpeechMotionMode;
  mouthStateSources?: {
    closed: number;
    halfOpen: number;
    open: number;
    round?: number;
  };
  /**
   * Approved non-speaking portrait frames. Fix #4 may consume these from the
   * authoritative native playback state; this registry never advances them.
   */
  expressionFrameSources?: {
    confident: number;
    engaged: number;
    neutral: number;
    thoughtful: number;
    warm: number;
    blink: number;
    brows: number;
    browsRaised: number;
    eyesClosed: number;
    eyesHalf: number;
    eyesOpen: number;
    focused: number;
  };
}

const SPEECH_CONFIG_ENTRIES: readonly [string, StylistSpeechConfiguration][] = Object.freeze([
  // Approved mouth-state assets for priority portrait presets.
  // Round states are not yet available; the renderer falls back open → halfOpen → closed.
  [
    'stylist_portrait_02',
    {
      speakingMotionMode: 'mouth_states',
      // Recalibrated for the refreshed Avatar 02 subject (prior crop: y 0.49).
      mouthRegion: { x: 0.43, y: 0.48, width: 0.17, height: 0.09 },
      mouthStateSources: {
        closed: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_mouth_closed.png') : 1,
        halfOpen: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_mouth_half_open.png') : 1,
        open: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_mouth_open.png') : 1,
        round: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/round-mouth-02.png') : 1,
      },
      expressionFrameSources: {
        confident: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_confident.png') : 1,
        engaged: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_engaged.png') : 1,
        neutral: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_neutral.png') : 1,
        thoughtful: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_thoughtful.png') : 1,
        warm: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_02_warm.png') : 1,
        blink: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/blink-02.png') : 1,
        brows: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/brows-02.png') : 1,
        browsRaised: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/brows-raised-02.png') : 1,
        eyesClosed: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/eyes-closed-02.png') : 1,
        eyesHalf: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/eyes-half-02.png') : 1,
        eyesOpen: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/eyes-open-02.png') : 1,
        focused: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/focused-02.png') : 1,
      },
    },
  ],
  [
    'stylist_portrait_05',
    {
      speakingMotionMode: 'mouth_states',
      mouthRegion: { x: 0.43, y: 0.5, width: 0.16, height: 0.09 },
      mouthStateSources: {
        closed: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_05_mouth_closed.png') : 1,
        halfOpen: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_05_mouth_half_open.png') : 1,
        open: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_05_mouth_open.png') : 1,
      },
    },
  ],
  [
    'stylist_portrait_08',
    {
      speakingMotionMode: 'mouth_states',
      mouthRegion: { x: 0.42, y: 0.45, width: 0.17, height: 0.1 },
      mouthStateSources: {
        closed: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_08_mouth_closed.png') : 1,
        halfOpen: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_08_mouth_half_open.png') : 1,
        open: /* @ts-ignore */ typeof require !== 'undefined' ? require('../assets/stylist-avatars/portraits/animated/avatar_stylist_08_mouth_open.png') : 1,
      },
    },
  ],
]);

/** Speech configuration keyed by existing avatar preset ID. */
export const STYLIST_SPEECH_CONFIG_BY_ID: ReadonlyMap<string, StylistSpeechConfiguration> =
  createReadonlyMap(SPEECH_CONFIG_ENTRIES);

// ── Optional static-portrait framing correction ───────────────────────────────
//
// Some bundled 1:1 portrait sources place the subject off-center within their
// own frame, which a circular avatar mask then clips asymmetrically. This is a
// presentation-only recenter (zoom + horizontal shift at render time) for the
// static portrait; it intentionally does not apply to the mouth-state overlay
// system, whose assets carry their own independently calibrated framing.

export interface StylistAvatarFraming {
  /** Horizontal recenter offset as a fraction of the rendered avatar size. */
  offsetXRatio: number;
}

// The approved Henry base has its own headroom, so the picker uses the shared
// size-by-size cover path without a presentation transform.
const FRAMING_OVERRIDE_ENTRIES: readonly [string, StylistAvatarFraming][] = Object.freeze([]);

export const STYLIST_AVATAR_FRAMING_BY_ID: ReadonlyMap<string, StylistAvatarFraming> =
  createReadonlyMap(FRAMING_OVERRIDE_ENTRIES);

export function getStylistAvatarFraming(
  avatarId: string | null | undefined,
): StylistAvatarFraming | undefined {
  if (!avatarId) return undefined;
  return STYLIST_AVATAR_FRAMING_BY_ID.get(avatarId);
}

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
  if (!avatarId) return false;
  return STYLIST_AVATAR_PRESET_BY_ID.get(avatarId)?.voiceProfile !== 'silent';
}

export function getStylistVoiceProfile(
  avatarId: string | null | undefined,
): StylistVoiceProfile {
  if (!avatarId) return 'silent';
  return STYLIST_AVATAR_PRESET_BY_ID.get(avatarId)?.voiceProfile ?? 'silent';
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
 * THE single name resolver (Fix #6). customName wins whenever it sanitizes to a
 * valid value; otherwise the canonical name for avatarId; otherwise the safe
 * default. UI, greeting composition, and the backend model persona must all
 * resolve through this precedence — never re-implement it independently.
 *
 * Callers decide what counts as "a custom name" (see normalizeStylistIdentity,
 * which gates on the persisted display_name_customized flag) — this function
 * itself only sanitizes and applies precedence, it does not read storage.
 */
export function resolveStylistDisplayName(
  customName: string | null | undefined,
  avatarId: string | null | undefined,
): string {
  if (typeof customName === 'string') {
    const nameResult = sanitizeStylistName(customName);
    if (nameResult.valid) return nameResult.value;
  }
  return resolveCanonicalStylistName(avatarId);
}

/**
 * Build a validated identity object from raw persisted data. This is the only
 * place raw storage rows should be normalized so every consumer receives the
 * same safe fallback.
 *
 * `display_name` stays a required historical column (existing consumers,
 * migrations, and defaults are untouched). Whether it represents a genuine
 * user choice is tracked by the separate `display_name_customized` boolean
 * (added for Fix #6, default false) — only when that flag is true is the
 * stored text treated as an explicit override; otherwise the canonical name
 * for avatarId (or the safe default) is resolved instead. This is what keeps
 * a pre-Fix-#6 row's historical 'Elise' from being mistaken for a deliberate
 * customization once a different avatar's canonical name should apply.
 */
export function normalizeStylistIdentity(raw: unknown): StylistIdentity {
  const fallback = DEFAULT_STYLIST_IDENTITY;
  if (!raw || typeof raw !== 'object') return fallback;

  const record = raw as Record<string, unknown>;
  const avatarId = resolveAvatarId(
    typeof record.avatar_id === 'string'
      ? record.avatar_id
      : typeof record.avatarId === 'string'
        ? record.avatarId
        : undefined,
  );

  const isCustomized = record.display_name_customized === true;
  const rawStoredName = record.display_name ?? record.displayName;
  const customName =
    isCustomized && typeof rawStoredName === 'string' ? rawStoredName : null;
  const displayName = resolveStylistDisplayName(customName, avatarId);

  return displayName === fallback.displayName && avatarId === fallback.avatarId
    ? fallback
    : Object.freeze({ displayName, avatarId });
}
