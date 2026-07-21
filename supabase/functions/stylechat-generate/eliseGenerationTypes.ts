export const ELISE_GROUNDING_VERSION = 'elise_grounding_v1' as const;
export const ELISE_OUTPUT_VERSION = 'elise_output_v1' as const;
export const GENERATION_OPERATION_TYPE = 'stylechat_generate_reply' as const;

export type EliseGenerationOperationStatus =
  | 'reserved'
  | 'generating'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'cancelled'
  | 'stale'
  | 'failed';

export type EliseProviderFailureClass =
  | 'PROVIDER_TIMEOUT'
  | 'NETWORK_FAILURE'
  | 'RATE_LIMIT'
  | 'PROVIDER_BUSY'
  | 'AUTHENTICATION_FAILURE'
  | 'INVALID_REQUEST'
  | 'MODEL_NOT_AVAILABLE'
  | 'MALFORMED_RESPONSE'
  | 'EMPTY_RESPONSE'
  | 'UNKNOWN_PROVIDER_ERROR'
  | 'SESSION_INVALID'
  | 'SOURCE_MESSAGE_INVALID'
  | 'OPERATION_STALE'
  | 'DUPLICATE_IN_FLIGHT'
  | 'DUPLICATE_COMPLETED';

export interface EliseGenerationOperation {
  operationId: string;
  actorId: string;
  sessionId: string;
  sourceMessageId: string | null;
  requestId: string;
  status: EliseGenerationOperationStatus;
  attemptCount: number;
  assistantMessageId: string | null;
  providerRequestStartedAt: string | null;
  completedAt: string | null;
  stableErrorClass: string | null;
}

export interface EliseOperationReservation {
  operationId: string;
  status: EliseGenerationOperationStatus;
  attemptCount: number;
  assistantMessageId: string | null;
  isDuplicate: boolean;
  mayGenerate: boolean;
  stableErrorClass: string | null;
}

export type EliseValidatedAction = {
  type: string;
  label?: string;
  [key: string]: unknown;
};

export interface EliseGenerationOutput {
  text: string;
  explanation: string | null;
  actions: EliseValidatedAction[];
  metadata: {
    outputVersion: typeof ELISE_OUTPUT_VERSION;
    usedFallback: boolean;
    validationOutcome: 'accepted' | 'fallback' | 'actions_dropped' | 'truncated';
  };
}
