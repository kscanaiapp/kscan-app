/**
 * Minimal RevenueCat server-side adapter for the K+ complimentary boundary.
 *
 * Scope is deliberately narrow: mirror a K Scan-issued time-limited K+ grant
 * into RevenueCat as a promotional entitlement, using the Supabase auth user
 * UUID as the stable RevenueCat App User ID. No native purchase SDK, no
 * paywall, no billing -- this only ever calls RevenueCat's server-side
 * REST API with the secret key, never exposed to any client.
 *
 * Failure policy: RevenueCat is a secondary mirror, never an availability
 * dependency. Every function here returns a status instead of throwing for
 * ordinary HTTP/network failures, so a caller can record
 * external_sync_status and move on without rolling back a valid local grant.
 */

const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v1';

export type RevenueCatSyncOutcome =
  | { ok: true; status: 'synced'; externalCustomerId: string }
  | { ok: false; status: 'not_required'; reason: string }
  | { ok: false; status: 'failed_retryable'; reason: string; httpStatus?: number }
  | { ok: false; status: 'failed_terminal'; reason: string; httpStatus?: number };

export function isRevenueCatSyncEnabled(): boolean {
  return (Deno.env.get('REVENUECAT_SYNC_ENABLED') ?? '').trim().toLowerCase() === 'true';
}

function getSecretApiKey(): string | null {
  const value = Deno.env.get('REVENUECAT_SECRET_API_KEY')?.trim();
  return value ? value : null;
}

function getKPlusEntitlementId(): string {
  return Deno.env.get('REVENUECAT_KPLUS_ENTITLEMENT_ID')?.trim() || 'k_plus';
}

/**
 * Grants (or re-grants, idempotently) a time-limited promotional
 * entitlement in RevenueCat for the given app user id, expiring at the exact
 * timestamp K Scan already computed. Never called with a client-supplied
 * identity -- callers must pass the same Supabase auth user UUID used as the
 * K Scan entitlement's user_id.
 *
 * Idempotency/duplication note (spec section 15): this call always passes
 * the SAME expires_at that K Scan's row already holds. RevenueCat's
 * promotional-entitlement endpoint treats a duration+end_time as a full
 * overwrite of that promotional grant, not an additive extension, so
 * calling this repeatedly with the same expires_at cannot extend the period,
 * create a second promotional period, or (per RevenueCat's own documented
 * behavior) touch a store-purchased entitlement, which is tracked
 * separately from promotional grants.
 */
export async function syncPromotionalEntitlement(params: {
  appUserId: string;
  expiresAt: string;
}): Promise<RevenueCatSyncOutcome> {
  if (!isRevenueCatSyncEnabled()) {
    return { ok: false, status: 'not_required', reason: 'sync_disabled' };
  }

  const secretApiKey = getSecretApiKey();
  if (!secretApiKey) {
    return { ok: false, status: 'failed_retryable', reason: 'missing_secret_api_key' };
  }

  const endTimeMs = Date.parse(params.expiresAt);
  if (Number.isNaN(endTimeMs)) {
    return { ok: false, status: 'failed_terminal', reason: 'invalid_expires_at' };
  }

  const entitlementId = getKPlusEntitlementId();
  const url = `${REVENUECAT_API_BASE}/subscribers/${encodeURIComponent(params.appUserId)}/entitlements/${encodeURIComponent(entitlementId)}/promotional`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ duration: 'custom', end_time_ms: endTimeMs }),
      signal: AbortSignal.timeout(8000),
    });
  } catch (err) {
    return {
      ok: false,
      status: 'failed_retryable',
      reason: err instanceof Error ? `network_error:${err.name}` : 'network_error',
    };
  }

  if (response.ok) {
    return { ok: true, status: 'synced', externalCustomerId: params.appUserId };
  }

  // 4xx other than 429 (rate limit) means the request itself is malformed or
  // the API key/entitlement id is wrong -- retrying without a code change
  // will not help, but this is still a foundation-build sync mirror, not the
  // source of truth, so it is recorded and surfaced rather than thrown.
  const retryable = response.status === 429 || response.status >= 500;
  return {
    ok: false,
    status: retryable ? 'failed_retryable' : 'failed_terminal',
    reason: `revenuecat_http_${response.status}`,
    httpStatus: response.status,
  };
}
