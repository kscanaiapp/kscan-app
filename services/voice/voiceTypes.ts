/**
 * Voice Scan V1 shared contract types.
 *
 * Voice Scan is an input adapter, not a new intelligence stack: speech
 * becomes an untrusted text transcript, the user reviews it, and it is then
 * submitted through the existing TextScan path. Nothing in this module (or
 * anywhere under services/voice/) may reference Commerce providers, Elise,
 * retailers, Supabase tables, ranking, or Edge Function routing -- those
 * concerns start only after a transcript reaches services/textScan.ts via
 * the normal TextScan submit call.
 */

/** Where a voice transcript was captured. V1 has exactly one surface. */
export type VoiceSourceSurface = 'text-scan';

/**
 * The recognizer that actually produced a transcript. 'unavailable' marks a
 * transcript-less terminal state (no engine could run) and must never carry
 * a non-empty transcript.
 */
export type VoiceEngine = 'ios-speech' | 'android-speech' | 'web' | 'unavailable';

/**
 * A single voice capture attempt. `onDevice` is a hard privacy assertion: it
 * is only ever true when the platform recognizer ran in an on-device-only
 * mode. There is no cloud/network fallback in V1 -- when on-device
 * recognition can't be guaranteed, the caller must not run recognition at
 * all, so `onDevice: false` is only ever seen with `engine: 'unavailable'`.
 */
export interface VoiceTranscript {
  /** Raw transcript text exactly as returned by the recognizer, untrimmed. */
  transcript: string;
  /** BCP-47 locale used for recognition, when known. */
  locale: string | null;
  /** True only for an on-device-only recognition result. */
  onDevice: boolean;
  /** Which recognizer produced this transcript. */
  engine: VoiceEngine;
  /** Where this transcript will be submitted. */
  sourceSurface: VoiceSourceSurface;
  /** ISO-8601 capture timestamp. */
  capturedAt: string;
}

/**
 * Voice UI/session state machine. `reviewing` is mandatory before submit --
 * no state transitions directly from `listening` or `finalizing` into a
 * submitted/Commerce state. See docs/state machine notes in useVoiceScan.
 */
export type VoiceRecognitionState =
  | 'idle'
  | 'requesting_permission'
  | 'listening'
  | 'finalizing'
  | 'reviewing'
  | 'error'
  | 'unavailable'
  | 'cancelled';

/** Reasons Voice Scan may be unavailable for the current attempt. */
export type VoiceUnavailableReason =
  | 'permission_denied'
  | 'permission_denied_permanently'
  | 'on_device_recognition_unavailable'
  | 'recognizer_error'
  | 'not_kplus'
  | 'flag_disabled';

/** Maximum duration a single Commerce Voice listening session may run. */
export const VOICE_MAX_LISTEN_DURATION_MS = 15_000;
