/**
 * Issue #47 — narrow privacy-rights rate-limit helper.
 *
 * Called by Edge Functions AFTER JWT auth and BEFORE protected writes.
 * Uses the service-role REST RPC; identity is the already-validated user id.
 * Does not redesign CORS, auth, or the shared security boundary.
 */

export type PrivacyRateLimitAction =
  | 'account_deletion'
  | 'privacy_correction'
  | 'privacy_export';

export type PrivacyRateLimitResult = {
  allowed: boolean;
  remaining: number;
  reset_at: string | null;
  retry_after_seconds: number;
  request_count: number;
  limit_value: number;
};

const DEFAULT_LIMIT = 5;
const DEFAULT_WINDOW_SECONDS = 60;

function env(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

export async function reservePrivacyRequestRateLimit(
  userId: string,
  action: PrivacyRateLimitAction,
  options?: { limit?: number; windowSeconds?: number },
): Promise<PrivacyRateLimitResult> {
  const supabaseUrl = env('SUPABASE_URL');
  const serviceRoleKey = env('SUPABASE_SERVICE_ROLE_KEY');
  const limit = options?.limit ?? DEFAULT_LIMIT;
  const windowSeconds = options?.windowSeconds ?? DEFAULT_WINDOW_SECONDS;

  const response = await fetch(
    `${supabaseUrl}/rest/v1/rpc/reserve_privacy_request_rate_limit`,
    {
      method: 'POST',
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_user_id: userId,
        p_action: action,
        p_limit: limit,
        p_window_seconds: windowSeconds,
      }),
    },
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`privacy_rate_limit_rpc_failed status=${response.status} detail=${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const row = Array.isArray(payload) ? payload[0] : payload;
  if (!row || typeof row.allowed !== 'boolean') {
    throw new Error('privacy_rate_limit_rpc_malformed');
  }

  return {
    allowed: Boolean(row.allowed),
    remaining: Number(row.remaining ?? 0),
    reset_at: row.reset_at ?? null,
    retry_after_seconds: Math.max(0, Number(row.retry_after_seconds ?? 0)),
    request_count: Number(row.request_count ?? 0),
    limit_value: Number(row.limit_value ?? limit),
  };
}

export function rateLimitedResponse(
  corsHeaders: Record<string, string>,
  retryAfterSeconds: number,
): Response {
  const retry = Math.max(1, Math.floor(retryAfterSeconds || DEFAULT_WINDOW_SECONDS));
  return new Response(
    JSON.stringify({
      error: 'Too many requests. Please try again shortly.',
      code: 'RATE_LIMITED',
      retry_after_seconds: retry,
    }),
    {
      status: 429,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        'Retry-After': String(retry),
      },
    },
  );
}
