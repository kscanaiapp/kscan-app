/**
 * E-3 speech operation contracts.
 * Actor IDs may exist in memory for ownership checks but must never be logged raw.
 */

export type EliseSpeechOperationStatus =
  | 'reserved'
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled'
  | 'stale'
  | 'deduplicated';

export type EliseSpeechErrorClass =
  | 'QUOTA_EXHAUSTED'
  | 'RATE_LIMIT'
  | 'CONCURRENCY_LIMIT'
  | 'AUTHENTICATION_FAILURE'
  | 'VOICE_NOT_FOUND'
  | 'MODEL_NOT_AVAILABLE'
  | 'INVALID_REQUEST'
  | 'PROVIDER_BUSY'
  | 'PROVIDER_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'MALFORMED_AUDIO'
  | 'EMPTY_AUDIO'
  | 'ALIGNMENT_INVALID'
  | 'OPERATION_CANCELLED'
  | 'OPERATION_STALE'
  | 'UNKNOWN_PROVIDER_ERROR';

export type EliseSpeechCircuitState = 'closed' | 'open' | 'half_open';

export const ELISE_SPEECH_OPERATION_TYPE = 'stylist_speech_generate' as const;

export interface EliseSpeechOperation {
  operationId: string;
  actorId: string;
  sessionId: string | null;
  messageId: string | null;
  avatarId: string;
  voiceId: string;
  requestId: string;
  status: EliseSpeechOperationStatus;
  attemptCount: number;
  stableErrorClass: EliseSpeechErrorClass | null;
  createdAt: string;
  completedAt: string | null;
}

export interface EliseSpeechOperationIdentity {
  actorId: string;
  sessionId: string;
  messageId: string;
  avatarId: string;
  voiceProfile: string;
  operationType: typeof ELISE_SPEECH_OPERATION_TYPE;
}
