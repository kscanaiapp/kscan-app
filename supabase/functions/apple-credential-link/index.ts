/**
 * apple-credential-link — capture the Apple authorization grant for a signed-in
 * user so account deletion can later revoke it.
 *
 * TN3194 requires the app to "securely transmit the identity token and
 * authorization code to your app server", validate the code at /auth/token, and
 * store the resulting refresh token for future revocation. This function is the
 * server half of that; the client half is services/appleCredentialLink.ts.
 *
 * verify_jwt = true, and the target user is resolved ONLY from the verified
 * bearer token. The request body carries exactly one field, the authorization
 * code — there is no user id in the body to spoof, by construction.
 *
 * Nothing sensitive leaves this function: the response is a status word, never
 * a token, an Apple body, or a configuration value.
 */

import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  isPlausibleAuthorizationCode,
  resolveAppleConfig,
} from '../_shared/appleAuth/config.ts';
import { exchangeAuthorizationCode } from '../_shared/appleAuth/appleRestApi.ts';
import {
  encryptToken,
  importEncryptionKey,
  saveEncryptedCredential,
} from '../_shared/appleAuth/credentialStore.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** Structured, non-secret logging. No code, token, or secret is ever a field. */
function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(`[apple-credential-link] ${event} ${JSON.stringify(fields)}`);
}

async function requireUser(req: Request): Promise<{ id: string }> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw json({ error: 'Authentication required' }, 401);
  }
  const accessToken = authorization.slice('bearer '.length).trim();
  if (!accessToken) throw json({ error: 'Authentication required' }, 401);

  const userClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false, detectSessionInUrl: false },
  });

  const { data: { user }, error } = await userClient.auth.getUser(accessToken);
  if (error || !user?.id || !UUID_REGEX.test(user.id)) {
    throw json({ error: 'Authentication required' }, 401);
  }
  return { id: user.id };
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
    const user = await requireUser(req);

    const body = await req.json().catch(() => ({}));
    const authorizationCode = (body as Record<string, unknown>)?.authorizationCode;
    if (!isPlausibleAuthorizationCode(authorizationCode)) {
      logEvent('rejected', { uid: shortUserId(user.id), reason: 'invalid_code_shape' });
      return json({ status: 'invalid_request' }, 400);
    }

    const resolution = resolveAppleConfig();
    if (!resolution.configured) {
      // Names only — never values. Sign-in must not fail because the server is
      // not yet provisioned, so this is a soft status the client ignores.
      logEvent('not_configured', { missing: resolution.missing });
      return json({ status: 'not_configured' }, 200);
    }

    const exchange = await exchangeAuthorizationCode({
      config: resolution.config,
      authorizationCode,
      fetchImpl: fetch as never,
    });

    if (!exchange.ok) {
      logEvent('exchange_failed', {
        uid: shortUserId(user.id),
        reason: exchange.reason,
        // Apple's own error code is a fixed enum, safe to record; the body is not.
        error: exchange.reason === 'apple_error' ? exchange.error : undefined,
      });
      return json({ status: 'exchange_failed' }, 200);
    }

    const key = await importEncryptionKey(resolution.encryptionKeyBase64);
    const envelope = await encryptToken(key, exchange.refreshToken);

    const saved = await saveEncryptedCredential({
      rest: restClient() as never,
      userId: user.id,
      envelope,
    });

    if (!saved) {
      logEvent('persist_failed', { uid: shortUserId(user.id) });
      return json({ status: 'persist_failed' }, 200);
    }

    // The authorization code is not retained: it is single-use, already spent,
    // and useless for revocation. Only the encrypted refresh token is kept.
    logEvent('linked', { uid: shortUserId(user.id) });
    return json({ status: 'linked' }, 200);
  } catch (error) {
    if (error instanceof Response) return error;
    logEvent('unexpected_error', {
      type: error instanceof Error ? error.name : 'unknown',
    });
    return json({ status: 'error' }, 500);
  }
});
