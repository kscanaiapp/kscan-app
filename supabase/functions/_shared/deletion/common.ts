/**
 * Shared helpers for account-deletion Edge Functions.
 * Runtime-neutral enough for Deno (Web Crypto + fetch).
 */

export const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type, x-deletion-worker-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS, GET',
};

export const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

export function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export function envOptional(name: string): string | null {
  const value = Deno.env.get(name)?.trim();
  return value ? value : null;
}

export function isValidUuid(value: string): boolean {
  return UUID_REGEX.test(value);
}

export function shortUserId(userId: string): string {
  return userId && userId.length > 8 ? `${userId.slice(0, 8)}...` : 'unknown';
}

export function logEvent(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }));
}

/** URL-safe token from 32 cryptographically random bytes. */
export function generateRestorationToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function hashRestorationToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function addDaysIso(from: Date, days: number): string {
  return new Date(from.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

export async function rest(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  return fetch(`${supabaseUrl}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: serviceRoleKey,
      Authorization: `Bearer ${serviceRoleKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers ?? {}),
    },
  });
}

export async function rpc(fnName: string, body: Record<string, unknown>) {
  const response = await rest(`rpc/${fnName}`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return response;
}

export type AuthUser = { id: string; email?: string; accessToken: string };

export async function requireUser(req: Request): Promise<AuthUser> {
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    throw json({ error: 'Authentication required' }, 401);
  }

  const accessToken = authorization.slice('bearer '.length).trim();
  if (!accessToken) {
    throw json({ error: 'Authentication required' }, 401);
  }

  const userClient = createClient(env('SUPABASE_URL'), env('SUPABASE_ANON_KEY'), {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  const {
    data: { user },
    error,
  } = await userClient.auth.getUser(accessToken);
  if (error || !user?.id || !isValidUuid(user.id)) {
    throw json({ error: 'Authentication required' }, 401);
  }

  return { id: user.id, email: user.email ?? undefined, accessToken };
}

/**
 * Fail-closed account-active guard for mutation / paid-provider entry points.
 * Allows restoration & deletion-status pathways to skip this guard explicitly.
 */
export async function assertAccountActive(userId: string): Promise<void> {
  if (!isValidUuid(userId)) {
    throw json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
  }

  const response = await rest(
    `profiles?id=eq.${userId}&select=account_status&limit=1`,
    { method: 'GET', headers: { Prefer: 'return=representation' } },
  );

  if (!response.ok) {
    logEvent('account_guard_lookup_failed', {
      uid: shortUserId(userId),
      status: response.status,
    });
    throw json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
  }

  const rows = await response.json();
  const status = Array.isArray(rows) && rows[0] ? rows[0].account_status : null;
  if (status !== 'active') {
    throw json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
  }
}

/**
 * Global session revocation.
 * 1) Prefer admin.signOut with the caller's JWT when available (documented API).
 * 2) Always also call revoke_user_sessions RPC to clear auth.sessions / refresh tokens.
 */
export async function revokeAllSessions(
  userId: string,
  accessToken?: string | null,
): Promise<{ ok: boolean; method: string; detail?: string }> {
  const { createClient } = await import('npm:@supabase/supabase-js@2');
  const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let jwtRevokeOk = false;
  let jwtDetail: string | undefined;
  if (accessToken) {
    try {
      const result = await admin.auth.admin.signOut(accessToken, 'global');
      if (result.error) {
        jwtDetail = result.error.message;
      } else {
        jwtRevokeOk = true;
      }
    } catch (err) {
      jwtDetail = err instanceof Error ? err.message : 'signOut_threw';
    }
  }

  const rpcResult = await admin.rpc('revoke_user_sessions', { p_user_id: userId });
  if (rpcResult.error) {
    logEvent('session_revocation_rpc_failed', {
      uid: shortUserId(userId),
      detail: rpcResult.error.message,
      jwtRevokeOk,
    });
    return {
      ok: jwtRevokeOk,
      method: jwtRevokeOk ? 'admin_signOut_partial' : 'failed',
      detail: rpcResult.error.message,
    };
  }

  logEvent('session_revocation_success', {
    uid: shortUserId(userId),
    jwtRevokeOk,
    sessionsCleared: rpcResult.data ?? null,
  });
  return {
    ok: true,
    method: jwtRevokeOk ? 'admin_signOut_and_rpc' : 'rpc_only',
    detail: jwtDetail,
  };
}

export async function appendTransition(params: {
  requestId: string;
  subjectRef: string;
  fromState: string | null;
  toState: string;
  actorType: string;
  actorRef?: string | null;
  reasonCode?: string | null;
  metadata?: Record<string, unknown> | null;
}) {
  const response = await rpc('append_deletion_state_transition', {
    p_request_id: params.requestId,
    p_subject_ref: params.subjectRef,
    p_from_state: params.fromState,
    p_to_state: params.toState,
    p_actor_type: params.actorType,
    p_actor_ref: params.actorRef ?? null,
    p_reason_code: params.reasonCode ?? null,
    p_sanitized_metadata: params.metadata ?? null,
  });
  if (!response.ok) {
    const detail = await response.text();
    logEvent('lifecycle_transition_append_failed', {
      status: response.status,
      detail: detail.slice(0, 200),
    });
  }
  return response.ok;
}

const RESTORE_BASE_URL =
  Deno.env.get('ACCOUNT_RESTORATION_BASE_URL')?.trim() || 'https://kscan.app/account/restore';

export function buildRestorationUrl(token: string): string {
  return `${RESTORE_BASE_URL}?token=${encodeURIComponent(token)}`;
}

export function buildRestorationIdempotencyKey(params: {
  requestId: string;
  kind: 'request' | 'resend' | 'restored';
  emailCount?: number;
}): string {
  if (params.kind === 'restored') {
    return `deletion-restored:${params.requestId}`;
  }
  if (params.kind === 'resend') {
    const count = Math.max(1, Number(params.emailCount ?? 1));
    return `deletion-restore:${params.requestId}:resend:${count}`;
  }
  return `deletion-restore:${params.requestId}`;
}

function toIsoTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('invalid_timestamp');
  }
  return parsed.toISOString();
}

/**
 * Transactional restoration email via verified Render → Resend path.
 * Supabase never calls Resend directly for deletion mail.
 */
export async function sendRestorationEmail(params: {
  to: string;
  requestId: string;
  requestedAt: string;
  gracePeriodEndsAt: string;
  restorationUrl: string;
  kind: 'request' | 'resend' | 'restored';
  emailCount?: number;
}): Promise<{ queued: boolean; provider: string; error?: string; status?: string }> {
  const renderBase =
    envOptional('KSCAN_EMAIL_RENDER_URL')?.replace(/\/+$/, '') ||
    'https://kscan-app-1.onrender.com';
  const emailSecret = envOptional('KSCAN_EMAIL_INTERNAL_SECRET');

  if (!emailSecret) {
    logEvent('restoration_email_skipped_no_provider', {
      kind: params.kind,
      reason: 'missing_internal_secret',
    });
    return { queued: false, provider: 'none', error: 'KSCAN_EMAIL_INTERNAL_SECRET not configured' };
  }

  let requestedAt: string;
  let gracePeriodEndsAt: string;
  try {
    requestedAt = toIsoTimestamp(params.requestedAt);
    gracePeriodEndsAt = toIsoTimestamp(params.gracePeriodEndsAt);
  } catch {
    return { queued: false, provider: 'render', error: 'invalid_timestamp' };
  }

  const idempotencyKey = buildRestorationIdempotencyKey({
    requestId: params.requestId,
    kind: params.kind,
    emailCount: params.emailCount,
  });

  const body: Record<string, string> = {
    eventType: 'account_deletion_restoration',
    idempotencyKey,
    recipientEmail: params.to.trim().toLowerCase(),
    kind: params.kind,
    requestedAt,
    gracePeriodEndsAt,
  };
  if (params.kind !== 'restored') {
    body.restorationUrl = params.restorationUrl;
  }

  try {
    const response = await fetch(`${renderBase}/internal/email/account-deletion-restoration`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-kscan-email-secret': emailSecret,
      },
      body: JSON.stringify(body),
    });

    const payload = await response.json().catch(() => ({}));
    const status = typeof payload?.status === 'string' ? payload.status : 'unknown';

    if (response.ok && status === 'sent') {
      logEvent('restoration_email_queued', {
        kind: params.kind,
        provider: 'render',
        requestIdPrefix: params.requestId.slice(0, 8),
        idempotencyHash: idempotencyKey.slice(0, 24),
      });
      return { queued: true, provider: 'render', status };
    }

    logEvent('restoration_email_failed', {
      kind: params.kind,
      provider: 'render',
      httpStatus: response.status,
      status,
      code: typeof payload?.code === 'string' ? payload.code.slice(0, 80) : undefined,
    });
    return {
      queued: false,
      provider: 'render',
      status,
      error: typeof payload?.code === 'string' ? payload.code : `http_${response.status}`,
    };
  } catch {
    logEvent('restoration_email_exception', { kind: params.kind, provider: 'render' });
    return { queued: false, provider: 'render', error: 'network_error' };
  }
}

export async function readAppConfigFlag(key: string): Promise<boolean> {
  const response = await rest(`app_config?key=eq.${encodeURIComponent(key)}&select=value`, {
    method: 'GET',
  });
  if (!response.ok) return false;
  const rows = await response.json();
  if (!Array.isArray(rows) || !rows[0]?.value) return false;
  return Boolean(rows[0].value.enabled);
}
