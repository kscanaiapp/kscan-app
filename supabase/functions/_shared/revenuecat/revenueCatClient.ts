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
 *
 * API version note: this calls RevenueCat's V2 REST API
 * (`/v2/projects/{project_id}/customers/{customer_id}/actions/grant_entitlement`).
 * The account's Secret API Keys are issued V2-only -- a V2 key returns
 * `403 {"code":7723}` ("incompatible with RevenueCat API V1") against the
 * legacy V1 promotional-entitlement endpoint this file used to call, and no
 * V1-compatible key is obtainable for this account any longer. V2's grant
 * endpoint requires `REVENUECAT_PROJECT_ID` (already provisioned as a
 * secret, previously unused because V1 has no project scoping).
 */

const REVENUECAT_API_BASE = 'https://api.revenuecat.com/v2';

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

function getProjectId(): string | null {
  const value = Deno.env.get('REVENUECAT_PROJECT_ID')?.trim();
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
 * the SAME expires_at that K Scan's row already holds. RevenueCat's V2
 * grant_entitlement action grants the entitlement "unless one already
 * exists" -- so a repeat call with the identical expires_at K Scan already
 * recorded is a no-op against an existing grant, not an additive extension,
 * and (per RevenueCat's own documented behavior) never touches a
 * store-purchased entitlement, which is tracked separately from granted
 * entitlements.
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

  const projectId = getProjectId();
  if (!projectId) {
    return { ok: false, status: 'failed_retryable', reason: 'missing_project_id' };
  }

  const endTimeMs = Date.parse(params.expiresAt);
  if (Number.isNaN(endTimeMs)) {
    return { ok: false, status: 'failed_terminal', reason: 'invalid_expires_at' };
  }

  const entitlementId = getKPlusEntitlementId();
  const url = `${REVENUECAT_API_BASE}/projects/${encodeURIComponent(projectId)}/customers/${encodeURIComponent(params.appUserId)}/actions/grant_entitlement`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secretApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ entitlement_id: entitlementId, expires_at: endTimeMs }),
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
