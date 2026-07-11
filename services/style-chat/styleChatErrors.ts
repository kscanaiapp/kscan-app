import { STYLE_CHAT_COPY } from '../../constants/styleChat';

export function extractStyleChatErrorMessage(error: unknown): string {
  if (!error) return '';

  if (error instanceof Error) return error.message;

  if (typeof error === 'string') return error;

  if (typeof error === 'object') {
    const candidate =
      (error as { error?: { message?: unknown } }).error?.message ??
      (error as { message?: unknown }).message ??
      (error as { details?: unknown }).details ??
      (error as { hint?: unknown }).hint;

    if (typeof candidate === 'string') return candidate;
  }

  return '';
}

export function getFriendlyStyleChatError(error: unknown): string {
  const message = extractStyleChatErrorMessage(error);
  if (message === STYLE_CHAT_COPY.systemLimitNotice || message === STYLE_CHAT_COPY.burstLimitNotice) {
    return message;
  }

  const normalized = message.toLowerCase();

  if (
    normalized.includes('network request failed') ||
    normalized.includes('failed to fetch') ||
    normalized.includes('networkerror') ||
    normalized.includes('offline') ||
    normalized.includes('internet')
  ) {
    return 'Connection lost. Check your internet and try again.';
  }

  if (
    normalized.includes('timeout') ||
    normalized.includes('timed out') ||
    normalized.includes('abort')
  ) {
    return 'Elise took too long to respond. Try again in a moment.';
  }

  if (
    normalized.includes('rate limit') ||
    normalized.includes('daily limit') ||
    normalized.includes('quota') ||
    normalized.includes('burst')
  ) {
    return "You've reached the current Elise limit. Try again later.";
  }

  if (
    normalized.includes('sign in') ||
    normalized.includes('not authenticated') ||
    normalized.includes('authentication')
  ) {
    return 'Sign in to use Elise.';
  }

  return 'Elise had trouble responding. Try again.';
}
