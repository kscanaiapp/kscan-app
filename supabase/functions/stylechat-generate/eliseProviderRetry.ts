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

/**
 * Model fallback eligibility.
 *
 * WHY THIS EXISTS: the approved fallback model was resolved into config
 * (`fallbackModelName`) and asserted by eliseConfig.test.ts, but nothing ever
 * read it — every attempt, including the same-model provider retry, reused the
 * primary. An eligible primary failure therefore went straight to the canned
 * error text while the approved secondary sat unused. This predicate is the
 * missing half of that contract.
 *
 * It is deliberately NOT the same question as `shouldRetryTextProviderError`:
 * that asks "is another attempt against THIS model worth it", which is false
 * for a retired or unavailable model id. Switching models is exactly what
 * rescues MODEL_NOT_AVAILABLE, so it is eligible here and not there.
 *
 * Excluded, because a second model cannot change the outcome and would only
 * burn the remaining request budget:
 *   AUTHENTICATION_FAILURE - same API key, same rejection.
 *   INVALID_REQUEST        - same request body, same rejection.
 * Non-provider classes (session/operation lifecycle) are excluded because they
 * never represent a provider call that could be retried at all.
 */
export function shouldFallbackToSecondaryModel(
  failureClass: EliseProviderFailureClass,
): boolean {
  return (
    failureClass === 'PROVIDER_TIMEOUT' ||
    failureClass === 'NETWORK_FAILURE' ||
    failureClass === 'RATE_LIMIT' ||
    failureClass === 'PROVIDER_BUSY' ||
    failureClass === 'MODEL_NOT_AVAILABLE' ||
    failureClass === 'EMPTY_RESPONSE' ||
    failureClass === 'MALFORMED_RESPONSE' ||
    failureClass === 'UNKNOWN_PROVIDER_ERROR'
  );
}
