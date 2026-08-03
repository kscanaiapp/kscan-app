// Shared authenticated request guard.
//
// Verifies the bearer token against Supabase Auth (never trusts a client-supplied
// user ID), then loads account state from the real repository schema —
// public.profiles.account_status, which is 'active' | 'pending_deletion' | 'locked'
// (see supabase/migrations/202605130000_profiles_privacy_status.sql). There is no
// separate "suspended"/"blocked"/"disabled" column in this schema; 'locked' is the
// single non-active blocked state, and 'pending_deletion' covers deletion-pending.
//
// Fails closed: any authentication or account-state lookup failure denies the
// request rather than defaulting to allow.

import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2';
import { generateRequestId } from './errors.ts';

export type AccountStatus = 'active' | 'pending_deletion' | 'locked';

export interface AuthContext {
  userId: string;
  // Best-effort Supabase auth session id parsed from the verified JWT's `session_id`
  // claim, for correlation only — never used for authorization decisions.
  sessionId: string | undefined;
  accountState: AccountStatus;
  requestId: string;
}

export type AuthResult =
  | { ok: true; context: AuthContext; supabaseClient: SupabaseClient }
  | { ok: false; category: 'unauthorized'; message: string; requestId: string }
  | { ok: false; category: 'account_unavailable'; message: string; requestId: string }
  | { ok: false; category: 'internal_error'; message: string; requestId: string };

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.get('Authorization');
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// Parses the `session_id` claim out of a JWT payload without verifying the
// signature ourselves — signature/expiry verification already happened via
// userClient.auth.getUser() before this is called. Purely descriptive/telemetry.
function extractSessionIdClaim(token: string): string | undefined {
  try {
    const [, payloadSegment] = token.split('.');
    if (!payloadSegment) return undefined;
    const normalized = payloadSegment.replace(/-/g, '+').replace(/_/g, '/');
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
    const decoded = JSON.parse(atob(padded));
    return typeof decoded.session_id === 'string' ? decoded.session_id : undefined;
  } catch {
    return undefined;
  }
}

const ALLOWED_ACCOUNT_STATES: readonly AccountStatus[] = ['active', 'pending_deletion', 'locked'];

function isAccountStatus(value: unknown): value is AccountStatus {
  return typeof value === 'string' && (ALLOWED_ACCOUNT_STATES as readonly string[]).includes(value);
}

export interface AuthenticateOptions {
  // Account states allowed to proceed. Defaults to only 'active' — every
  // provider-backed call rejects pending_deletion and locked accounts.
  allowedAccountStates?: readonly AccountStatus[];
  // Test-only injection point. Production call sites must never set this —
  // it exists so tests can substitute a fake Supabase client instead of making
  // a real network call, without changing any production code path.
  clientFactory?: (token: string, supabaseUrl: string, supabaseAnonKey: string) => SupabaseClient;
}

function defaultClientFactory(token: string, supabaseUrl: string, supabaseAnonKey: string): SupabaseClient {
  return createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false },
  });
}

export async function authenticateRequest(
  req: Request,
  options: AuthenticateOptions = {},
): Promise<AuthResult> {
  const requestId = generateRequestId();
  const allowedStates = options.allowedAccountStates ?? ['active'];

  const token = extractBearerToken(req);
  if (!token) {
    return { ok: false, category: 'unauthorized', message: 'Missing authorization', requestId };
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL');
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY');
  if (!supabaseUrl || !supabaseAnonKey) {
    // Server misconfiguration — never surfaced as an auth failure to the caller.
    return { ok: false, category: 'internal_error', message: 'Server configuration error', requestId };
  }

  const clientFactory = options.clientFactory ?? defaultClientFactory;
  const supabaseClient = clientFactory(token, supabaseUrl, supabaseAnonKey);

  const { data: userData, error: authError } = await supabaseClient.auth.getUser();
  if (authError || !userData?.user) {
    return { ok: false, category: 'unauthorized', message: 'Not authenticated', requestId };
  }

  const userId = userData.user.id;

  const { data: profileRow, error: profileError } = await supabaseClient
    .from('profiles')
    .select('account_status')
    .eq('id', userId)
    .maybeSingle();

  // Fail closed: cannot verify account state (RPC/network error, or profile row
  // unexpectedly missing for an authenticated user) → deny rather than allow.
  if (profileError || !profileRow || !isAccountStatus(profileRow.account_status)) {
    return {
      ok: false,
      category: 'account_unavailable',
      message: 'Unable to verify account status',
      requestId,
    };
  }

  const accountState = profileRow.account_status;
  if (!allowedStates.includes(accountState)) {
    return {
      ok: false,
      category: 'account_unavailable',
      message: 'This account cannot perform this action right now',
      requestId,
    };
  }

  return {
    ok: true,
    context: {
      userId,
      sessionId: extractSessionIdClaim(token),
      accountState,
      requestId,
    },
    supabaseClient,
  };
}
