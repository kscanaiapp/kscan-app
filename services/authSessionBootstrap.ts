type AuthErrorLike = {
  code?: unknown;
  message?: unknown;
  name?: unknown;
  status?: unknown;
};

const STALE_REFRESH_TOKEN_CODES = new Set([
  'refresh_token_not_found',
  'refresh_token_already_used',
  'refresh_token_reuse_detected',
]);

/**
 * Supabase removes a non-retryable stale refresh token from local storage
 * before returning the bootstrap error. This classifier keeps that expected
 * recovery path quiet while allowing every other auth failure to be reported.
 */
export function isHandledStaleRefreshTokenError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const candidate = error as AuthErrorLike;
  const code = typeof candidate.code === 'string' ? candidate.code.toLowerCase() : '';
  if (STALE_REFRESH_TOKEN_CODES.has(code)) return true;

  const name = typeof candidate.name === 'string' ? candidate.name : '';
  const message = typeof candidate.message === 'string'
    ? candidate.message.trim().toLowerCase()
    : '';
  const status = typeof candidate.status === 'number' ? candidate.status : null;

  return (
    name === 'AuthApiError' &&
    (status === 400 || status === 401) &&
    /^invalid refresh token(?:: (?:refresh token not found|refresh token already used))?$/.test(message)
  );
}
