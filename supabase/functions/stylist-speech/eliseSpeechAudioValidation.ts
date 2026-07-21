import { StylistSpeechError, type SpeechAlignment } from './types.ts';
import type { EliseSpeechErrorClass } from './eliseSpeechTypes.ts';

export const MAX_SPEECH_AUDIO_BASE64_CHARS = 2_500_000;
export const MIN_SPEECH_AUDIO_DECODED_BYTES = 1;

export type AudioValidationOutcome =
  | 'valid'
  | 'empty'
  | 'malformed'
  | 'oversized'
  | 'alignment_invalid'
  | 'alignment_omitted';

export interface ValidatedSpeechAudio {
  audioBase64: string;
  alignment: SpeechAlignment | null;
  outcome: AudioValidationOutcome;
  stableErrorClass: EliseSpeechErrorClass | null;
}

function isValidBase64Audio(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length === 0) return false;
  if (value.length > MAX_SPEECH_AUDIO_BASE64_CHARS) return false;
  if (value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  try {
    return atob(value).length >= MIN_SPEECH_AUDIO_DECODED_BYTES;
  } catch {
    return false;
  }
}

/**
 * Validate alignment timestamps. Returns null when alignment is absent/optional.
 * Throws StylistSpeechError(ALIGNMENT path) when present but invalid and strict.
 */
export function validateSpeechAlignment(
  value: unknown,
  options: { strict?: boolean; audioDurationHintSeconds?: number | null } = {},
): SpeechAlignment | null {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    if (options.strict) {
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
    }
    return null;
  }
  const record = value as Record<string, unknown>;
  const characters = record.characters;
  const starts = record.characterStartTimesSeconds ?? record.character_start_times_seconds;
  const ends = record.characterEndTimesSeconds ?? record.character_end_times_seconds;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length === 0 ||
    characters.length !== starts.length ||
    starts.length !== ends.length
  ) {
    if (options.strict) {
      throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
    }
    return null;
  }

  let previousStart = -1;
  let previousEnd = -1;
  for (let index = 0; index < characters.length; index += 1) {
    if (typeof characters[index] !== 'string') {
      if (options.strict) {
        throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
      }
      return null;
    }
    const start = starts[index];
    const end = ends[index];
    if (
      typeof start !== 'number' || !Number.isFinite(start) || start < 0 ||
      typeof end !== 'number' || !Number.isFinite(end) || end < 0 ||
      start > end || start < previousStart || end < previousEnd
    ) {
      if (options.strict) {
        throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
      }
      return null;
    }
    if (
      options.audioDurationHintSeconds != null &&
      Number.isFinite(options.audioDurationHintSeconds) &&
      end > options.audioDurationHintSeconds + 0.5
    ) {
      if (options.strict) {
        throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
      }
      return null;
    }
    previousStart = start;
    previousEnd = end;
  }

  return {
    characters: [...characters] as string[],
    characterStartTimesSeconds: [...starts] as number[],
    characterEndTimesSeconds: [...ends] as number[],
  };
}

/**
 * Validate provider audio before it can reach playback.
 * Optional alignment may degrade to audio-only (alignment = null) when not strict.
 */
export function validateSpeechAudioPayload(input: {
  audioBase64: unknown;
  alignment?: unknown;
  strictAlignment?: boolean;
}): ValidatedSpeechAudio {
  if (typeof input.audioBase64 !== 'string' || input.audioBase64.length === 0) {
    return {
      audioBase64: '',
      alignment: null,
      outcome: 'empty',
      stableErrorClass: 'EMPTY_AUDIO',
    };
  }
  if (input.audioBase64.length > MAX_SPEECH_AUDIO_BASE64_CHARS) {
    return {
      audioBase64: '',
      alignment: null,
      outcome: 'oversized',
      stableErrorClass: 'MALFORMED_AUDIO',
    };
  }
  if (!isValidBase64Audio(input.audioBase64)) {
    return {
      audioBase64: '',
      alignment: null,
      outcome: 'malformed',
      stableErrorClass: 'MALFORMED_AUDIO',
    };
  }

  try {
    const alignment = validateSpeechAlignment(input.alignment, {
      strict: input.strictAlignment === true,
    });
    return {
      audioBase64: input.audioBase64,
      alignment,
      outcome: alignment == null && input.alignment != null ? 'alignment_omitted' : 'valid',
      stableErrorClass: null,
    };
  } catch {
    return {
      audioBase64: '',
      alignment: null,
      outcome: 'alignment_invalid',
      stableErrorClass: 'ALIGNMENT_INVALID',
    };
  }
}

export function assertValidSpeechAudio(input: {
  audioBase64: unknown;
  alignment?: unknown;
  strictAlignment?: boolean;
}): { audioBase64: string; alignment: SpeechAlignment | null; outcome: AudioValidationOutcome } {
  const validated = validateSpeechAudioPayload(input);
  if (validated.stableErrorClass === 'EMPTY_AUDIO') {
    throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
  }
  if (validated.stableErrorClass === 'MALFORMED_AUDIO') {
    throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
  }
  if (validated.stableErrorClass === 'ALIGNMENT_INVALID') {
    throw new StylistSpeechError(502, 'PROVIDER_RESPONSE_INVALID', 'Speech response was invalid.');
  }
  return {
    audioBase64: validated.audioBase64,
    alignment: validated.alignment,
    outcome: validated.outcome,
  };
}
