import type {
  AlignmentDisposition,
  AvatarSpeechAlignment,
  CharacterAlignment,
  PhonemeAlignment,
} from '../types';

export interface NormalizedCharacterEntry { char: string; startSeconds: number; endSeconds: number; }
export interface NormalizedPhonemeEntry { phoneme: string; startSeconds: number; endSeconds: number; }

/**
 * `inputCount` / `dropped` back the ALIGNMENT_INPUT_EVENTS,
 * ALIGNMENT_RETAINED_EVENTS and ALIGNMENT_DISCARDED_EVENTS metrics. They are
 * counts only — no characters, phonemes or timings ever leave the engine
 * through instrumentation.
 */
export type AlignmentNormalizationResult =
  | { source: 'none'; disposition: 'missing'; entries: readonly []; inputCount: number; dropped: number }
  | { source: 'character'; disposition: AlignmentDisposition; entries: readonly NormalizedCharacterEntry[]; inputCount: number; dropped: number }
  | { source: 'phoneme'; disposition: AlignmentDisposition; entries: readonly NormalizedPhonemeEntry[]; inputCount: number; dropped: number };

const MISSING = { source: 'none', disposition: 'missing', entries: [], inputCount: 0, dropped: 0 } as const;

export function normalizeAlignment(input: unknown): AlignmentNormalizationResult {
  if (input === null || input === undefined || typeof input !== 'object') return MISSING;
  const record = input as Record<string, unknown>;
  if ('characters' in record || 'characterStartTimesSeconds' in record || 'characterEndTimesSeconds' in record) {
    return normalizeCharacterAlignment(input as CharacterAlignment);
  }
  if ('phonemes' in record) return normalizePhonemeAlignment(input as PhonemeAlignment);
  return MISSING;
}

/**
 * Timing validity is judged against the previous RETAINED entry, not the
 * previous raw entry. A single corrupt row therefore costs one interval instead
 * of silently truncating the rest of the utterance, while overlapping or
 * backwards rows are still refused rather than repaired — the engine does not
 * invent timing the provider did not supply.
 */
function normalizeCharacterAlignment(input: CharacterAlignment): AlignmentNormalizationResult {
  const record = input as unknown as Record<string, unknown>;
  const chars = record.characters;
  const starts = record.characterStartTimesSeconds;
  const ends = record.characterEndTimesSeconds;
  if (
    !Array.isArray(chars) || !Array.isArray(starts) || !Array.isArray(ends) ||
    chars.length !== starts.length || chars.length !== ends.length
  ) {
    return { source: 'character', disposition: 'unusable', entries: [], inputCount: 0, dropped: 0 };
  }
  if (chars.length === 0) return { source: 'character', disposition: 'empty', entries: [], inputCount: 0, dropped: 0 };

  const entries: NormalizedCharacterEntry[] = [];
  let dropped = 0;
  let lastEnd = -1;
  for (let i = 0; i < chars.length; i += 1) {
    const char = chars[i];
    const start = starts[i];
    const end = ends[i];
    const valid =
      typeof char === 'string' && char.length === 1 &&
      typeof start === 'number' && Number.isFinite(start) && start >= 0 &&
      typeof end === 'number' && Number.isFinite(end) && end >= start &&
      start >= lastEnd;
    if (!valid) { dropped += 1; continue; }
    entries.push({ char, startSeconds: start, endSeconds: end });
    lastEnd = end;
  }
  if (entries.length === 0) {
    return { source: 'character', disposition: 'unusable', entries: [], inputCount: chars.length, dropped };
  }
  return {
    source: 'character',
    disposition: dropped > 0 ? 'partially-sanitized' : 'usable',
    entries,
    inputCount: chars.length,
    dropped,
  };
}

function normalizePhonemeAlignment(input: PhonemeAlignment): AlignmentNormalizationResult {
  const raw = (input as unknown as Record<string, unknown>).phonemes;
  if (!Array.isArray(raw)) return { source: 'phoneme', disposition: 'unusable', entries: [], inputCount: 0, dropped: 0 };
  if (raw.length === 0) return { source: 'phoneme', disposition: 'empty', entries: [], inputCount: 0, dropped: 0 };

  const entries: NormalizedPhonemeEntry[] = [];
  let dropped = 0;
  let lastEnd = -1;
  for (const item of raw) {
    if (!item || typeof item !== 'object') { dropped += 1; continue; }
    const p = item as Record<string, unknown>;
    const phoneme = p.phoneme;
    const start = p.startSeconds;
    const end = p.endSeconds;
    const valid =
      typeof phoneme === 'string' && phoneme.length > 0 && phoneme.length <= 8 &&
      typeof start === 'number' && Number.isFinite(start) && start >= 0 &&
      typeof end === 'number' && Number.isFinite(end) && end >= start &&
      start >= lastEnd;
    if (!valid) { dropped += 1; continue; }
    entries.push({ phoneme, startSeconds: start, endSeconds: end });
    lastEnd = end;
  }
  if (entries.length === 0) {
    return { source: 'phoneme', disposition: 'unusable', entries: [], inputCount: raw.length, dropped };
  }
  return {
    source: 'phoneme',
    disposition: dropped > 0 ? 'partially-sanitized' : 'usable',
    entries,
    inputCount: raw.length,
    dropped,
  };
}

export function isAvatarSpeechAlignment(value: unknown): value is AvatarSpeechAlignment {
  const result = normalizeAlignment(value);
  return result.disposition === 'usable' ||
    result.disposition === 'partially-sanitized' ||
    result.disposition === 'empty';
}
