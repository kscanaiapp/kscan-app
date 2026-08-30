/**
 * Daily scan quota authorisation for scan-identify.
 *
 * WHY THIS IS ITS OWN MODULE: this is the authorisation point for paid work.
 * Everything downstream of it -- the Gemini call and every commerce provider it
 * feeds -- costs money. While it lived inside index.ts it could not be executed
 * by a test at all, because index.ts calls `Deno.serve` at import time. The only
 * coverage possible was reading the source as text, and a text assertion cannot
 * tell the difference between "fails closed" and "returns a shape that happens
 * to contain the right words". That is precisely how the fail-open below
 * survived: it was visible, commented, and untested.
 */

export const SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT = 30;
export const SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT = 50;

export type ReadEnv = (name: string) => string | undefined;

const defaultReadEnv: ReadEnv = (name) => {
  const value = Deno.env.get(name)?.trim();
  return value ? value : undefined;
};

export function getScanIdentifyDailyLimit(mode: string, readEnv: ReadEnv = defaultReadEnv): number {
  const raw = readEnv(
    mode === 'text' ? 'SCAN_IDENTIFY_TEXT_DAILY_LIMIT' : 'SCAN_IDENTIFY_IMAGE_DAILY_LIMIT',
  );
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : (mode === 'text' ? SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT : SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT);
}

/**
 * The outcome of consulting the daily quota.
 *
 * Deliberately three states, and deliberately NOT a boolean. The previous shape
 * was `{ allowed: boolean; count: number; limit: number }`, and BOTH failure
 * paths -- no service-role client, and any RPC error -- returned
 * `{ allowed: true, count: 0, limit: 0 }`. A quota outage therefore authorised
 * unmetered paid Gemini and paid commerce for every authenticated caller.
 *
 * A boolean has no way to express "we do not know", so the only two values
 * available were both wrong: claim the user is over limit (a lie about them, and
 * unactionable), or let the request through (a lie about our own state, and
 * billable). This type removes the choice: there is no field a caller can read
 * as a default-true.
 *
 * `unverified` is NOT `exceeded`. The user has hit no limit; our infrastructure
 * is unavailable. They are distinct conditions and must stay distinct in both
 * the user-facing message and the telemetry.
 */
export type ScanQuotaDecision =
  | { outcome: 'allowed'; count: number; limit: number }
  | { outcome: 'exceeded'; count: number; limit: number }
  | { outcome: 'unverified'; reason: 'missing_service_role_client' | 'quota_rpc_error' };

/**
 * Consult the per-user daily quota and increment it.
 *
 * Returns `unverified` -- never `allowed` -- when the quota system cannot be
 * consulted. The caller must treat that as "paid work is not authorised".
 */
export async function checkAuthenticatedScanQuota(
  catalogClient: unknown,
  userId: string,
  mode: string,
  logUserId: string,
  readEnv: ReadEnv = defaultReadEnv,
): Promise<ScanQuotaDecision> {
  if (!catalogClient) {
    console.warn(
      '[scan-identify] quota_check_error user=%s mode=%s reason=missing_service_role_client',
      logUserId,
      mode,
    );
    return { outcome: 'unverified', reason: 'missing_service_role_client' };
  }

  const dailyLimit = getScanIdentifyDailyLimit(mode, readEnv);

  try {
    const { data, error } = await (catalogClient as any).rpc(
      'check_and_increment_scan_identify_daily_usage',
      {
        p_user_id: userId,
        p_mode: mode,
        p_daily_limit: dailyLimit,
      },
    );

    if (error) throw error;

    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.allowed !== 'boolean') {
      throw new Error('malformed_rpc_response');
    }

    const count = typeof row.count === 'number' ? row.count : 0;
    const limit = typeof row.limit === 'number' ? row.limit : dailyLimit;

    return row.allowed
      ? { outcome: 'allowed', count, limit }
      : { outcome: 'exceeded', count, limit };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[scan-identify] quota_check_error user=%s mode=%s error=%s', logUserId, mode, msg);
    return { outcome: 'unverified', reason: 'quota_rpc_error' };
  }
}
