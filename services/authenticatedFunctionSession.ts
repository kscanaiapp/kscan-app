/**
 * Shared preflight for authenticated Edge Function invokes.
 *
 * WHY THIS EXISTS. `supabase.functions.invoke` only attaches
 * `Authorization: Bearer <access_token>` when a usable session is already in
 * storage. Callers that fire before auth bootstrap finishes, or with an expired
 * access token while `autoRefreshToken` is false, reach protected functions
 * without an acceptable user JWT and receive HTTP 401.
 *
 * Pattern matches services/scanIdentification.ts and services/textScanEdge.ts:
 * resolve a usable session first, attempt one controlled refresh near expiry,
 * and refuse to invoke when signed out or refresh fails.
 */

import { supabase } from './supabaseClient';

/** Refresh when the access token is already expired or within this margin. */
export const FUNCTION_SESSION_REFRESH_MARGIN_SECONDS = 90;

export type AuthenticatedFunctionSessionFailure = 'signed_out' | 'session_expired';

export type AuthenticatedFunctionSessionResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: AuthenticatedFunctionSessionFailure };

type SessionLike = {
  access_token?: string | null;
  refresh_token?: string | null;
  expires_at?: number | null;
};

type RefreshFn = (args: {
  refresh_token: string;
}) => Promise<{ data: { session: SessionLike | null }; error: unknown }>;

function isExpiredOrNearExpiry(
  session: SessionLike,
  nowSeconds: number,
  marginSeconds: number,
): boolean {
  if (typeof session.expires_at !== 'number') return false;
  return session.expires_at <= nowSeconds + marginSeconds;
}

/**
 * Returns a usable access token for a protected function invoke, or a typed
 * failure that must not trigger a network call.
 */
export async function resolveAuthenticatedFunctionSession(options?: {
  nowSeconds?: number;
  getSession?: () => Promise<{ data: { session: SessionLike | null }; error: unknown }>;
  refreshSession?: RefreshFn;
  marginSeconds?: number;
}): Promise<AuthenticatedFunctionSessionResult> {
  const nowSeconds = options?.nowSeconds ?? Math.floor(Date.now() / 1000);
  const marginSeconds = options?.marginSeconds ?? FUNCTION_SESSION_REFRESH_MARGIN_SECONDS;
  const getSession =
    options?.getSession ?? (() => supabase.auth.getSession() as Promise<{
      data: { session: SessionLike | null };
      error: unknown;
    }>);
  const refreshSession =
    options?.refreshSession ?? ((args: { refresh_token: string }) =>
      supabase.auth.refreshSession(args) as Promise<{
        data: { session: SessionLike | null };
        error: unknown;
      }>);

  let session: SessionLike | null = null;
  try {
    const { data, error } = await getSession();
    if (error || !data.session?.access_token) {
      return { ok: false, reason: 'signed_out' };
    }
    session = data.session;
  } catch {
    return { ok: false, reason: 'signed_out' };
  }

  if (!isExpiredOrNearExpiry(session, nowSeconds, marginSeconds)) {
    return { ok: true, accessToken: session.access_token as string };
  }

  if (!session.refresh_token) {
    return { ok: false, reason: 'session_expired' };
  }

  try {
    const { data, error } = await refreshSession({ refresh_token: session.refresh_token });
    if (error || !data.session?.access_token) {
      return { ok: false, reason: 'session_expired' };
    }
    return { ok: true, accessToken: data.session.access_token };
  } catch {
    return { ok: false, reason: 'session_expired' };
  }
}
