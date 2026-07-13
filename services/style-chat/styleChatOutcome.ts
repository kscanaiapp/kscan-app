import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import type { EdgeChatResult } from './providers/edgeStyleChatProvider';
import type { StyleChatMessage } from './types';

export type RetryableStyleChatFailure = {
  kind: 'retryable_error';
  message: string;
  errorCode: string;
  persistAssistant: false;
};

export function classifyStyleChatOperationalFailure(
  result: Pick<EdgeChatResult, 'status' | 'message' | 'errorCode'>,
): RetryableStyleChatFailure | null {
  if (result.status !== 'error') return null;
  return {
    kind: 'retryable_error',
    message: result.message.content.trim() || STYLE_CHAT_COPY.errorGeneric,
    errorCode: result.errorCode || 'STYLECHAT_OPERATIONAL_FAILURE',
    persistAssistant: false,
  };
}

export function isSyntheticStyleChatFailure(
  message: Pick<StyleChatMessage, 'sender' | 'provider' | 'model'>,
): boolean {
  return (
    message.sender === 'assistant' &&
    (message.provider === 'fallback' || message.model === 'fallback')
  );
}
