export type StylistSpeechVoiceProfile = 'feminine' | 'masculine';

/**
 * Speak a persisted assistant message. The function reads the text from a row
 * the caller provably owns, so the client never supplies speech text.
 */
export interface StylistSpeechMessageRequest {
  mode: 'message';
  sessionId: string;
  messageId: string;
  stylistId: string;
}

/**
 * Speak one allowlisted deterministic cue. Carries a cue KEY, never cue text —
 * the approved words live server-side in `speechCues.ts`.
 */
export interface StylistSpeechCueRequest {
  mode: 'cue';
  cue: string;
  stylistId: string;
}

export type StylistSpeechRequest =
  | StylistSpeechMessageRequest
  | StylistSpeechCueRequest;

export interface SpeechAlignment {
  characters: string[];
  characterStartTimesSeconds: number[];
  characterEndTimesSeconds: number[];
}

export interface StylistSpeechResponse {
  /** Set in message mode; null for a deterministic cue. */
  messageId: string | null;
  /** Set in cue mode; null when speaking a persisted message. */
  cue: string | null;
  stylistId: string;
  voiceProfile: StylistSpeechVoiceProfile;
  mimeType: 'audio/mpeg';
  audioBase64: string;
  alignment: SpeechAlignment | null;
}

export interface SpeechSessionRow {
  id: string;
  user_id: string;
}

export interface SpeechMessageRow {
  id: string;
  session_id: string;
  user_id: string;
  sender: string;
  content: string;
  ui_blocks: unknown;
  provider: string | null;
}

export interface StylistPreferenceRow {
  avatar_id: string;
}

export interface StylistSpeechDataAccess {
  getAuthenticatedActor(): Promise<{ id: string } | null>;
  getAccountStatus(actorId: string): Promise<string | null>;
  getSession(sessionId: string, actorId: string): Promise<SpeechSessionRow | null>;
  getMessage(messageId: string, actorId: string): Promise<SpeechMessageRow | null>;
  getStylistPreference(actorId: string): Promise<StylistPreferenceRow | null>;
}

export type SpeechErrorCode =
  | 'INVALID_REQUEST'
  | 'NOT_AUTHENTICATED'
  | 'ACCOUNT_UNAVAILABLE'
  | 'SESSION_NOT_FOUND'
  | 'MESSAGE_NOT_FOUND'
  | 'MESSAGE_INELIGIBLE'
  | 'STYLIST_UNSUPPORTED'
  | 'STYLIST_SILENT'
  | 'STYLIST_MISMATCH'
  | 'DUPLICATE_REQUEST'
  | 'BURST_LIMIT'
  | 'DAILY_LIMIT'
  | 'SERVER_CONFIGURATION'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_RATE_LIMIT'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_VOICE_UNAVAILABLE'
  | 'PROVIDER_MODEL_UNAVAILABLE'
  | 'PROVIDER_QUOTA_EXCEEDED'
  | 'PROVIDER_INVALID_REQUEST'
  | 'PROVIDER_UNAVAILABLE'
  | 'PROVIDER_RESPONSE_INVALID'
  | 'PROVIDER_RESPONSE_TOO_LARGE'
  | 'INTERNAL_ERROR';

export class StylistSpeechError extends Error {
  readonly status: number;
  readonly code: SpeechErrorCode;

  constructor(status: number, code: SpeechErrorCode, message: string) {
    super(message);
    this.name = 'StylistSpeechError';
    this.status = status;
    this.code = code;
  }
}
