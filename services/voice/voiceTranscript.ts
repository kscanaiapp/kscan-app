/**
 * Voice transcript normalization and validation.
 *
 * A spoken transcript is treated exactly like typed hostile user input --
 * this module intentionally reuses services/textScan.ts's
 * `validateTextScanQuery` rather than defining a second, divergent policy.
 * Nothing here chooses a backend route based on transcript content; this
 * module's only job is "is this text safe/well-formed enough to show the
 * user for review", the same question TextScan already answers for typed
 * queries.
 */
import { validateTextScanQuery } from '../textScan';

export const VOICE_EMPTY_TRANSCRIPT_MESSAGE =
  "We didn't catch that. Try again or type your search.";

export type VoiceTranscriptValidation =
  | { valid: true }
  | { valid: false; message: string };

/**
 * Collapse recognizer whitespace artifacts (repeated spaces, leading/
 * trailing whitespace) without altering the words themselves. Does not
 * reject anything -- rejection is validateVoiceTranscript's job.
 */
export function normalizeVoiceTranscript(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(/\s+/g, ' ').trim();
}

/**
 * Validate a normalized voice transcript before it is shown for review.
 *
 * Empty/whitespace-only transcripts get a voice-specific "we didn't catch
 * that" message (the recognizer legitimately heard nothing); everything
 * else defers to the exact same validation TextScan already applies to
 * typed queries, so a spoken and a typed query of identical text are judged
 * identically.
 */
export function validateVoiceTranscript(raw: unknown): VoiceTranscriptValidation {
  const normalized = normalizeVoiceTranscript(raw);
  if (normalized.length === 0) {
    return { valid: false, message: VOICE_EMPTY_TRANSCRIPT_MESSAGE };
  }
  return validateTextScanQuery(normalized);
}
