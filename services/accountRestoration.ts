/**
 * Signed-out account restoration.
 *
 * Two Edge Functions back this surface, both deployed with `verify_jwt: false`
 * because the caller is by definition unable to sign in:
 *   * `restore-account`          — consumes a single-use restoration token.
 *   * `resend-restoration-email` — issues a fresh link, enumeration-safe.
 *
 * TOKEN HYGIENE (security-critical). The raw restoration token is a bearer
 * credential for an account. It may exist ONLY transiently, in this order:
 *
 *     incoming URL -> route memory -> restore-account request body
 *
 * Nothing in this module writes a token to AsyncStorage, SecureStore, a log
 * line, an analytics event, or a thrown error message. Callers must not either.
 * Failures deliberately surface a bounded, generic message rather than echoing
 * the server body, so a token can never leak through an error string.
 */

export type RestoreOutcome = 'restored' | 'pending_unban' | 'invalid' | 'failed';

export type RestoreResult = {
  outcome: RestoreOutcome;
  message: string;
};

/**
 * Bounded user-facing copy. `invalid` deliberately does not distinguish
 * expired / already-used / never-existed: all three mean "this link cannot
 * restore an account", and separating them would let an attacker probe token
 * state.
 */
const RESTORE_COPY: Record<RestoreOutcome, string> = {
  restored: 'Your account has been restored. Please sign in again.',
  pending_unban:
    'Your account data has been restored, but re-enabling sign-in is taking a little longer. Try signing in again in a few minutes.',
  invalid:
    'This restoration link is no longer valid. It may have expired or already been used. You can request a new one below.',
  failed: 'We could not restore your account right now. Please try again in a few minutes.',
};

export const RESEND_GENERIC_MESSAGE =
  'If an eligible deletion request exists for that email, a restoration message has been sent.';

/** The shortest value the backend will even consider (mirrors restore-account). */
const MIN_TOKEN_LENGTH = 32;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * supabase-js reports a non-2xx as a `FunctionsHttpError` carrying the raw
 * `Response` on `.context`. Only the numeric status is read — never the body —
 * so nothing from the request can be echoed back into UI or logs.
 */
function getFunctionHttpStatus(error: unknown): number | null {
  if (!isRecord(error)) return null;
  const context = error.context;
  if (!isRecord(context)) return null;
  return typeof context.status === 'number' && Number.isFinite(context.status)
    ? context.status
    : null;
}

/**
 * Extracts a restoration token from an incoming deep link / universal link.
 * Returns null for anything that is not a plausibly-shaped token, so a
 * malformed link produces the bounded invalid-link UI instead of a request.
 */
export function extractRestorationToken(value: unknown): string | null {
  if (typeof value !== 'string') {
    // expo-router gives `string[]` when a param repeats; take the first only.
    if (Array.isArray(value) && typeof value[0] === 'string') {
      return extractRestorationToken(value[0]);
    }
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length < MIN_TOKEN_LENGTH) return null;
  // Base64url alphabet, matching generateRestorationToken() on the backend.
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return null;
  return trimmed;
}

type InvokeClient = {
  functions: {
    invoke: (
      name: string,
      options: { body: unknown },
    ) => Promise<{ data: unknown; error: unknown }>;
  };
};

/**
 * Consumes a restoration token. The token is passed straight through to the
 * request body and never retained by this function.
 */
export async function restoreAccountWithToken(
  supabase: InvokeClient,
  token: string,
): Promise<RestoreResult> {
  const candidate = extractRestorationToken(token);
  if (!candidate) {
    return { outcome: 'invalid', message: RESTORE_COPY.invalid };
  }

  let data: unknown;
  let error: unknown;
  try {
    ({ data, error } = await supabase.functions.invoke('restore-account', {
      body: { token: candidate },
    }));
  } catch {
    // Network/transport failure. Never include the thrown value: the request
    // body it may quote contains the token.
    return { outcome: 'failed', message: RESTORE_COPY.failed };
  }

  if (error) {
    const status = getFunctionHttpStatus(error);
    // 400 is the backend's single "no matching / expired / used token" answer.
    const outcome: RestoreOutcome = status === 400 ? 'invalid' : 'failed';
    return { outcome, message: RESTORE_COPY[outcome] };
  }

  const status = isRecord(data) && typeof data.status === 'string' ? data.status : null;
  if (status === 'restored') {
    return { outcome: 'restored', message: RESTORE_COPY.restored };
  }
  if (status === 'restored_pending_unban') {
    return { outcome: 'pending_unban', message: RESTORE_COPY.pending_unban };
  }

  // 2xx with an unrecognised shape is not provable success.
  return { outcome: 'failed', message: RESTORE_COPY.failed };
}

/**
 * Requests a fresh restoration link.
 *
 * ENUMERATION SAFETY: the backend answers identically whether or not an
 * eligible deletion request exists, and this function preserves that. It always
 * resolves to the same generic message and never reports "found" / "not found".
 * Even a transport failure returns the generic message, so response *shape*
 * cannot be used as an oracle either; only `ok` differs, and it is used solely
 * to decide whether to offer a retry affordance.
 */
export async function requestRestorationEmail(
  supabase: InvokeClient,
  email: string,
): Promise<{ ok: boolean; message: string }> {
  const normalized = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!normalized || !normalized.includes('@') || normalized.length > 320) {
    return { ok: false, message: 'Enter the email address for your account.' };
  }

  try {
    const { error } = await supabase.functions.invoke('resend-restoration-email', {
      body: { email: normalized },
    });
    if (error) {
      return { ok: false, message: RESTORE_COPY.failed };
    }
  } catch {
    return { ok: false, message: RESTORE_COPY.failed };
  }

  return { ok: true, message: RESEND_GENERIC_MESSAGE };
}
