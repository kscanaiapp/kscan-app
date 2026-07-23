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

/**
 * Operator alert signal (Finding P1-4). Emitted to stderr with a stable,
 * greppable `severity: 'alert'` marker and an `ALERT` event prefix so a log
 * drain / Logflare / Supabase log alert can trigger on it without any
 * additional external integration. Use for conditions an operator must act on:
 * dead-lettered (attempts-exhausted) requests, requests stuck in 'purging'
 * past their lease, post-purge residual detection, and partial storage
 * removal. Never include PII -- callers pass short/hashed identifiers only.
 */
export function alertEvent(event: string, fields: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      severity: 'alert',
      event: event.startsWith('ALERT') ? event : `ALERT_${event}`,
      ts: new Date().toISOString(),
      ...fields,
    }),
  );
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

// Deletion-request statuses that mean "this account is being deleted, or was
// left mid-deletion" -- if this is the account's CURRENT EFFECTIVE (latest)
// deletion state, a missing-profile user must not be treated as active.
// Non-blocking terminal states (restored, cancelled, rejected, purged) are
// excluded, so a historical blocking row that was later resolved does not
// permanently lock a user out. Mirrors the SQL guard in
// 20260723070000_profiles_backfill_and_active_account_hardening.sql.
const BLOCKING_DELETION_STATES = [
  'pending',
  'processing',
  'completed',
  'deactivated',
  'purging',
  'legal_hold',
  'failed',
];

/**
 * Confirms an Auth user is genuinely active (exists, not soft-deleted, not
 * currently banned) via the admin API, AND whose CURRENT EFFECTIVE (latest)
 * deletion request -- if any -- is not a blocking state. Used only to decide
 * whether a MISSING profile row belongs to a legitimate active user
 * (legacy/import gap) or to an account that is being / was left mid deletion.
 * Never used to override an explicit non-active profile status. Keeps "missing
 * profile" from becoming a deletion bypass, without locking out users whose
 * historical deletion was later restored/cancelled.
 */
async function isAuthUserActive(userId: string): Promise<boolean> {
  try {
    const { createClient } = await import('npm:@supabase/supabase-js@2');
    const admin = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await admin.auth.admin.getUserById(userId);
    if (error || !data?.user) return false;
    const user = data.user as { banned_until?: string | null; deleted_at?: string | null };
    if (user.deleted_at) return false;
    if (user.banned_until && new Date(user.banned_until) > new Date()) return false;

    // Effective deletion state = the LATEST deletion_requests row for the user.
    // Block only if that row's status is blocking; a later restored/cancelled
    // row supersedes an earlier blocking one. Ordering MUST match the SQL
    // is_active_account() exactly (requested_at desc nulls last, then id desc
    // as a stable tiebreak for equal timestamps) so the DB and Edge never
    // disagree on which row is effective.
    const delResp = await rest(
      `deletion_requests?user_id=eq.${userId}&select=status&order=requested_at.desc.nullslast,id.desc&limit=1`,
      { method: 'GET' },
    );
    if (!delResp.ok) {
      // Fail closed if we cannot determine the effective deletion state.
      return false;
    }
    const rows = await delResp.json();
    const latestStatus = Array.isArray(rows) && rows[0] ? String(rows[0].status) : 'none';
    if (BLOCKING_DELETION_STATES.includes(latestStatus)) return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort self-heal: create the missing profile row so subsequent guard
 * checks and RLS (is_active_account) see it. Never throws -- a failure here
 * must not block a legitimate active user (the caller already verified the
 * Auth record). Idempotent via on-conflict merge.
 */
async function provisionMissingProfile(userId: string): Promise<void> {
  try {
    await rest('profiles?on_conflict=id', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ id: userId }),
    });
  } catch (_err) {
    // swallow -- provisioning is opportunistic, not required for this request
    logEvent('account_guard_profile_provision_failed', { uid: shortUserId(userId) });
  }
}

/**
 * Fail-closed account-active guard for mutation / paid-provider entry points.
 * Allows restoration & deletion-status pathways to skip this guard explicitly.
 *
 * Missing-profile handling (Finding P1-10): a null/absent profile row must NOT
 * blanket-403 legitimate users. Some valid, active Auth users (created before
 * the handle_new_user provisioning trigger existed, or via an import path that
 * bypassed it) have no profile row. Those users are allowed ONLY after the
 * Auth record is positively verified active (exists, not banned, not deleted),
 * and their profile is self-healed. A profile that EXISTS with a non-active
 * status (pending_deletion, locked, etc.) is still fail-closed, and a
 * banned/deleted/absent Auth user with no profile is still blocked.
 */
export async function assertAccountActive(userId: string): Promise<void> {
  if (!isValidUuid(userId)) {
    throw json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
  }

  const response = await rest(
    `profiles?id=eq.${userId}&select=account_status,account_locked_at&limit=1`,
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
  const profile = Array.isArray(rows) && rows[0] ? rows[0] : null;

  if (profile) {
    // Profile exists: enforce its status strictly (fail-closed on anything
    // that is not an unlocked active account).
    if (profile.account_status !== 'active' || profile.account_locked_at) {
      throw json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
    }
    return;
  }

  // No profile row: verify the Auth record before allowing.
  const authActive = await isAuthUserActive(userId);
  if (!authActive) {
    logEvent('account_guard_missing_profile_blocked', { uid: shortUserId(userId) });
    throw json({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }, 403);
  }
  logEvent('account_guard_missing_profile_allowed', { uid: shortUserId(userId) });
  await provisionMissingProfile(userId);
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
