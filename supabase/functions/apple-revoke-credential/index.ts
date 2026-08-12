/**
 * apple-revoke-credential — revoke a user's Sign in with Apple authorization as
 * part of account deletion, then erase the stored credential.
 *
 * This is a server-to-server entry point, not a user-facing one. It is called
 * from the deletion purge path immediately BEFORE the Supabase auth user is
 * deleted, because deleting the auth user cascades this credential away and the
 * token would be unrecoverable afterwards.
 *
 * AUTHORIZATION
 * verify_jwt = false, because the caller is a worker holding the service-role
 * key rather than an end user. The function therefore performs its own check:
 * the bearer must equal SUPABASE_SERVICE_ROLE_KEY. A user JWT — even a valid
 * one — is rejected, so no end user can drive revocation for any account,
 * including their own. Combined with that, the `userId` in the body cannot be
 * an escalation vector: only a caller that already holds full database
 * authority can supply it.
 *
 * IDEMPOTENCE
 * Apple returns 200 both when it invalidates a token and when the token "was
 * previously invalidated" (Token revocation, Sign in with Apple REST API), so a
 * retried or duplicated deletion run is safe. A user with no stored credential
 * returns `no_credential` — a success for deletion purposes, per TN3194's
 * documented path for when the token is not held.
 */

import { resolveAppleConfig } from '../_shared/appleAuth/config.ts';
import {
  isTerminalRevocationFailure,
  revokeRefreshToken,
} from '../_shared/appleAuth/appleRestApi.ts';
import {
  decryptToken,
  deleteCredential,
  importEncryptionKey,
  loadEncryptedCredential,
} from '../_shared/appleAuth/credentialStore.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Outcomes. Every one of these is deterministic and documented, so the deletion
 * pipeline can decide from the status word alone.
 *
 *   revoked        Apple accepted the revocation; credential erased
 *   no_credential  nothing stored for this user (non-Apple, or a legacy Apple
 *                  account that predates credential capture)
 *   unreadable     a row exists but cannot be decrypted; treated as
 *                  no_credential for deletion, surfaced for operations
 *   already_gone   Apple reports the grant is no longer valid; credential erased
 *   failed         transport error or an Apple rejection that may be retryable;
 *                  the credential is deliberately KEPT so a retry can succeed
 *   not_configured Apple secrets are absent from this deployment
 */
export type RevocationStatus =
  | 'revoked'
  | 'no_credential'
  | 'unreadable'
  | 'already_gone'
  | 'failed'
  | 'not_configured';

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function env(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function shortUserId(userId: string) {
  return userId ? `${userId.slice(0, 8)}...` : 'unknown';
}

function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(`[apple-revoke-credential] ${event} ${JSON.stringify(fields)}`);
}

/**
 * Constant-time comparison so a caller cannot recover the service-role key one
 * byte at a time by timing this endpoint.
 */
export function secureEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function requireServiceRole(req: Request): void {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw json({ error: 'Forbidden' }, 403);
  }
  const presented = authorization.slice('bearer '.length).trim();
  if (!presented || !secureEquals(presented, env('SUPABASE_SERVICE_ROLE_KEY'))) {
    throw json({ error: 'Forbidden' }, 403);
  }
}

function restClient() {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  return (path: string, init: RequestInit) =>
    fetch(`${supabaseUrl}/rest/v1/${path}`, {
      ...init,
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
    });
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    requireServiceRole(req);

    const body = await req.json().catch(() => ({}));
    const userId = (body as Record<string, unknown>)?.userId;
    if (typeof userId !== 'string' || !UUID_REGEX.test(userId)) {
      return json({ error: 'Invalid user id' }, 400);
    }

    const rest = restClient() as never;
    const lookup = await loadEncryptedCredential({ rest, userId });

    if ('error' in lookup) {
      logEvent('credential_lookup_failed', { uid: shortUserId(userId) });
      return json({ status: 'failed' satisfies RevocationStatus, retryable: true }, 200);
    }

    if (!lookup.found) {
      // Non-Apple accounts and legacy Apple accounts both land here. Deletion
      // proceeds; TN3194 covers this case explicitly.
      logEvent('no_credential', { uid: shortUserId(userId) });
      return json({ status: 'no_credential' satisfies RevocationStatus, retryable: false }, 200);
    }

    const resolution = resolveAppleConfig();
    if (!resolution.configured) {
      logEvent('not_configured', { missing: resolution.missing });
      return json({ status: 'not_configured' satisfies RevocationStatus, retryable: true }, 200);
    }

    const key = await importEncryptionKey(resolution.encryptionKeyBase64);
    const refreshToken = await decryptToken(key, lookup.envelope);

    if (!refreshToken) {
      // Key rotated or row tampered with. The token is unrecoverable, so
      // holding the deletion open would never help. Erase the dead row and let
      // deletion continue on the manual-revocation path.
      logEvent('credential_unreadable', { uid: shortUserId(userId) });
      await deleteCredential({ rest, userId });
      return json({ status: 'unreadable' satisfies RevocationStatus, retryable: false }, 200);
    }

    const revocation = await revokeRefreshToken({
      config: resolution.config,
      refreshToken,
      fetchImpl: fetch as never,
    });

    if (revocation.ok) {
      const erased = await deleteCredential({ rest, userId });
      logEvent('revoked', { uid: shortUserId(userId), credentialErased: erased });
      return json({ status: 'revoked' satisfies RevocationStatus, retryable: false }, 200);
    }

    if (isTerminalRevocationFailure(revocation)) {
      // invalid_grant: Apple no longer holds this authorization. The end state
      // we wanted is already true, so erase and move on.
      const erased = await deleteCredential({ rest, userId });
      logEvent('already_gone', { uid: shortUserId(userId), credentialErased: erased });
      return json({ status: 'already_gone' satisfies RevocationStatus, retryable: false }, 200);
    }

    // Retryable: keep the credential so a later attempt can still revoke.
    // Apple's error code is a fixed enum and safe to log; its body is not, and
    // never reaches the caller.
    logEvent('revocation_failed', {
      uid: shortUserId(userId),
      reason: revocation.reason,
      error: revocation.reason === 'apple_error' ? revocation.error : undefined,
      status: revocation.status,
    });
    return json({ status: 'failed' satisfies RevocationStatus, retryable: true }, 200);
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('unexpected_error', { type: error instanceof Error ? error.name : 'unknown' });
    return json({ status: 'failed' satisfies RevocationStatus, retryable: true }, 500);
  }
});
