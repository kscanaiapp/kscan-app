/**
 * Sign in with Apple REST API — token validation and token revocation.
 *
 * Endpoints and parameters follow Apple's current documentation:
 *   Token validation  https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
 *   Token revocation  https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
 *   Account deletion  TN3194
 *
 * Two details from those pages shape this module and are easy to get wrong:
 *
 * 1. `redirect_uri` is sent "only if the application provided a redirect_uri in
 *    the initial authorization request". Native Sign in with Apple through
 *    AuthenticationServices does not, so we must OMIT it. Sending an empty or
 *    invented value makes Apple answer `invalid_client`.
 *
 * 2. The revoke endpoint returns 200 with no body both when it invalidates the
 *    token AND when the token "was previously invalidated". Revocation is
 *    therefore idempotent, which is what lets a retried or duplicated deletion
 *    run stay safe.
 *
 * Nothing here logs a code, token, or client secret.
 */

import { createAppleClientSecret, type AppleSigningConfig } from './appleClientSecret.ts';

export const APPLE_TOKEN_ENDPOINT = 'https://appleid.apple.com/auth/token';
export const APPLE_REVOKE_ENDPOINT = 'https://appleid.apple.com/auth/revoke';

/** The error codes Apple documents in ErrorResponse. */
export const APPLE_ERROR_CODES = [
  'invalid_request',
  'invalid_client',
  'invalid_grant',
  'unauthorized_client',
  'unsupported_grant_type',
  'invalid_scope',
] as const;

export type AppleErrorCode = (typeof APPLE_ERROR_CODES)[number];

export type AppleFetch = (
  input: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<{ status: number; text: () => Promise<string> }>;

export type AppleExchangeResult =
  | { ok: true; refreshToken: string; accessToken: string | null }
  | { ok: false; reason: 'apple_error'; error: AppleErrorCode | 'unknown'; status: number }
  | { ok: false; reason: 'no_refresh_token'; status: number }
  | { ok: false; reason: 'transport'; status: 0 };

export type AppleRevokeResult =
  | { ok: true }
  | { ok: false; reason: 'apple_error'; error: AppleErrorCode | 'unknown'; status: number }
  | { ok: false; reason: 'transport'; status: 0 };

/**
 * Read Apple's error code out of a response body without letting the raw body
 * escape. Apple bodies are small JSON objects, but a proxy or captive network
 * can return arbitrary HTML, and that must never reach a caller or a log.
 */
export function parseAppleErrorCode(body: string): AppleErrorCode | 'unknown' {
  try {
    const parsed = JSON.parse(body);
    const code = parsed?.error;
    return (APPLE_ERROR_CODES as readonly string[]).includes(code)
      ? (code as AppleErrorCode)
      : 'unknown';
  } catch {
    return 'unknown';
  }
}

function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postForm(
  fetchImpl: AppleFetch,
  url: string,
  fields: Record<string, string>,
): Promise<{ status: number; body: string } | null> {
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: formBody(fields),
    });
    return { status: response.status, body: await response.text() };
  } catch {
    // Network/DNS/TLS failure. Distinguished from an Apple rejection because
    // the two get different handling during deletion.
    return null;
  }
}

/**
 * Exchange a one-time authorization code for the long-lived refresh token that
 * revocation later requires.
 *
 * Apple's authorization codes are single-use and short-lived; a replayed or
 * stale code comes back as `invalid_grant`.
 */
export async function exchangeAuthorizationCode(params: {
  config: AppleSigningConfig;
  authorizationCode: string;
  fetchImpl: AppleFetch;
  nowSeconds?: number;
}): Promise<AppleExchangeResult> {
  const clientSecret = await createAppleClientSecret(params.config, params.nowSeconds);

  const result = await postForm(params.fetchImpl, APPLE_TOKEN_ENDPOINT, {
    client_id: params.config.clientId,
    client_secret: clientSecret,
    code: params.authorizationCode,
    grant_type: 'authorization_code',
    // No redirect_uri: the native authorization request never supplied one.
  });

  if (!result) return { ok: false, reason: 'transport', status: 0 };

  if (result.status !== 200) {
    return {
      ok: false,
      reason: 'apple_error',
      error: parseAppleErrorCode(result.body),
      status: result.status,
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.body);
  } catch {
    return { ok: false, reason: 'no_refresh_token', status: result.status };
  }

  const refreshToken = typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '';
  if (!refreshToken) {
    // A 200 with no refresh_token is unusable for revocation, so it is a
    // failure here even though Apple considered the request successful.
    return { ok: false, reason: 'no_refresh_token', status: result.status };
  }

  return {
    ok: true,
    refreshToken,
    accessToken: typeof parsed.access_token === 'string' ? parsed.access_token : null,
  };
}

/**
 * Revoke a user's Apple authorization.
 *
 * `token_type_hint` is `refresh_token` because that is what we store; Apple
 * documents that revoking it invalidates the user's authorization for the
 * client.
 */
export async function revokeRefreshToken(params: {
  config: AppleSigningConfig;
  refreshToken: string;
  fetchImpl: AppleFetch;
  nowSeconds?: number;
}): Promise<AppleRevokeResult> {
  const clientSecret = await createAppleClientSecret(params.config, params.nowSeconds);

  const result = await postForm(params.fetchImpl, APPLE_REVOKE_ENDPOINT, {
    client_id: params.config.clientId,
    client_secret: clientSecret,
    token: params.refreshToken,
    token_type_hint: 'refresh_token',
  });

  if (!result) return { ok: false, reason: 'transport', status: 0 };
  if (result.status === 200) return { ok: true };

  return {
    ok: false,
    reason: 'apple_error',
    error: parseAppleErrorCode(result.body),
    status: result.status,
  };
}

/**
 * Whether a failed revocation should be treated as terminal.
 *
 * `invalid_grant` means Apple no longer recognises the token — the
 * authorization it represented is already gone, so retrying can never succeed
 * and holding the deletion open would serve nobody. Everything else
 * (transport, 5xx, invalid_client from a misconfigured key) is potentially
 * transient or operator-fixable and must stay visible.
 */
export function isTerminalRevocationFailure(result: AppleRevokeResult): boolean {
  return !result.ok && result.reason === 'apple_error' && result.error === 'invalid_grant';
}
