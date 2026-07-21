/**
 * E-2 provider retry classification for text generation.
 * Retries remain within one operation and one message-quota reservation.
 */

import type { EliseProviderFailureClass } from './eliseGenerationTypes.ts';

export function classifyTextProviderError(error: unknown): EliseProviderFailureClass {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'PROVIDER_TIMEOUT';
  }
  const message = error instanceof Error ? error.message : String(error ?? '');
  const lower = message.toLowerCase();
  if (/timeout|aborted|deadline/i.test(lower)) return 'PROVIDER_TIMEOUT';
  if (/network|fetch failed|econnreset|enotfound/i.test(lower)) return 'NETWORK_FAILURE';
  if (/429|rate.?limit|too many/i.test(lower)) return 'RATE_LIMIT';
  if (/503|unavailable|busy|overloaded/i.test(lower)) return 'PROVIDER_BUSY';
  if (/401|403|api.?key|unauthor|forbidden/i.test(lower)) return 'AUTHENTICATION_FAILURE';
  if (/400|invalid request|invalid_argument/i.test(lower)) return 'INVALID_REQUEST';
  if (/404|model.?not|not found/i.test(lower)) return 'MODEL_NOT_AVAILABLE';
  if (/empty/i.test(lower)) return 'EMPTY_RESPONSE';
  if (/malformed|parse|json/i.test(lower)) return 'MALFORMED_RESPONSE';
  if (/Gemini returned 5/i.test(message)) return 'PROVIDER_BUSY';
  if (/Gemini returned 429/i.test(message)) return 'RATE_LIMIT';
  if (/Gemini returned 401|Gemini returned 403/i.test(message)) return 'AUTHENTICATION_FAILURE';
  if (/Gemini returned 400/i.test(message)) return 'INVALID_REQUEST';
  return 'UNKNOWN_PROVIDER_ERROR';
}

export function shouldRetryTextProviderError(input: {
  failureClass: EliseProviderFailureClass;
  retryCount: number;
  retryEnabled: boolean;
  retryAfterSeconds?: number | null;
  remainingBudgetMs: number;
}): boolean {
  if (!input.retryEnabled || input.retryCount >= 1 || input.remainingBudgetMs <= 250) {
    return false;
  }
  if (
    input.failureClass === 'AUTHENTICATION_FAILURE' ||
    input.failureClass === 'INVALID_REQUEST' ||
    input.failureClass === 'MODEL_NOT_AVAILABLE' ||
    input.failureClass === 'MALFORMED_RESPONSE' ||
    input.failureClass === 'EMPTY_RESPONSE'
  ) {
    return false;
  }
  if (input.failureClass === 'RATE_LIMIT') {
    return input.retryAfterSeconds != null &&
      input.retryAfterSeconds * 1000 < input.remainingBudgetMs;
  }
  return (
    input.failureClass === 'PROVIDER_TIMEOUT' ||
    input.failureClass === 'NETWORK_FAILURE' ||
    input.failureClass === 'PROVIDER_BUSY'
  );
}

export function isRetryableFailureClass(
  failureClass: EliseProviderFailureClass,
): boolean {
  return (
    failureClass === 'PROVIDER_TIMEOUT' ||
    failureClass === 'NETWORK_FAILURE' ||
    failureClass === 'PROVIDER_BUSY' ||
    failureClass === 'RATE_LIMIT' ||
    failureClass === 'UNKNOWN_PROVIDER_ERROR'
  );
}
