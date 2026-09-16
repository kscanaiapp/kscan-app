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

/**
 * The ONLY quota namespaces this service recognises.
 *
 * B33-SEC-003. The durable bucket is keyed `(user_id, usage_date, mode)` by
 * `scan_identify_usage_daily_user_id_usage_date_mode_key`, and the request used
 * to reach that key as `body.mode.toLowerCase()` — an arbitrary caller string.
 * Every distinct spelling therefore minted its OWN 30/day bucket while still
 * executing as a paid image scan, because execution only ever asked
 * `mode === 'text'`. Measured on staging against one authenticated user:
 * 'image', 'img', 'image2', 'image-2', 'imagex', 'scan', 'a' and 'image '
 * (trailing space) each reached 30, i.e. 240 paid scans against a 30/day limit.
 * Only 'IMAGE' collapsed, because lowercasing was the single normalisation.
 *
 * A bounded vocabulary is what closes that: an unknown spelling must land in an
 * EXISTING bucket, never create one.
 *
 * 'commerce_only' is deliberately NOT reachable from this function. It is a
 * separate bucket owned by the MODE B route, which derives it from its own
 * `requestMode` field — never from caller-supplied `mode` — so a caller cannot
 * choose which namespace to spend from.
 */
export type CanonicalScanMode = 'image' | 'text';

export const CANONICAL_SCAN_MODES: readonly CanonicalScanMode[] = ['image', 'text'];

/** The MODE B bucket. Never derived from caller input; see above. */
export const COMMERCE_ONLY_QUOTA_MODE = 'commerce_only';

/** Every durable namespace that may exist, and nothing else. */
export type QuotaBucket = CanonicalScanMode | typeof COMMERCE_ONLY_QUOTA_MODE;

export const QUOTA_BUCKETS: readonly QuotaBucket[] = ['image', 'text', COMMERCE_ONLY_QUOTA_MODE];

/**
 * MODE B daily allowance.
 *
 * A commerce-only call is a DEFERRED lookup for a scan that already happened,
 * so it must not spend from the image bucket — that would double-charge one
 * scan and make a commerce retry cost an image scan. It gets its own namespace
 * and its own bound.
 *
 * 60 is deliberately above the 30/day image allowance: one scan can legitimately
 * produce more than one commerce call (a retry, and Build 32 multi-item issues
 * one per candidate). It replaces an in-memory limiter of 40 per 10 minutes per
 * IP+UA fingerprint, which bounded nothing durable — see the call site.
 */
export const SCAN_IDENTIFY_COMMERCE_ONLY_DAILY_LIMIT_DEFAULT = 60;

/**
 * Guard at the authority point: a bucket is one of the three or it is 'image'.
 *
 * Distinct from canonicalizeScanMode(), which maps UNTRUSTED caller input and
 * can therefore never yield 'commerce_only'. This maps a bucket the server
 * itself selected, so it admits the MODE B namespace while still refusing to
 * mint a new one from anything unexpected.
 */
export function canonicalizeQuotaBucket(raw: unknown): QuotaBucket {
  if (typeof raw === 'string') {
    const trimmed = raw.trim().toLowerCase();
    if (trimmed === 'text' || trimmed === 'image' || trimmed === COMMERCE_ONLY_QUOTA_MODE) {
      return trimmed as QuotaBucket;
    }
  }
  return 'image';
}

/**
 * Collapse any caller-supplied mode onto the canonical vocabulary.
 *
 * Normalisation rather than rejection, on purpose: execution already treats
 * every non-'text' request as an image scan, so mapping unknown spellings to
 * 'image' makes the bucket agree with the work actually performed and cannot
 * regress a Build 33 client that sends something unexpected. Rejecting would
 * change a shipped contract to fix an accounting bug.
 *
 * Fails toward the SMALLER allowance: anything unrecognised — including null,
 * undefined, numbers, objects and whitespace — is the 30/day image bucket, not
 * the 50/day text one.
 */
export function canonicalizeScanMode(raw: unknown): CanonicalScanMode {
  if (typeof raw !== 'string') return 'image';
  return raw.trim().toLowerCase() === 'text' ? 'text' : 'image';
}

export function getScanIdentifyDailyLimit(mode: string, readEnv: ReadEnv = defaultReadEnv): number {
  // Canonicalised here too, so a caller that forgets cannot widen its own
  // allowance by spelling the mode differently.
  const bucket = canonicalizeQuotaBucket(mode);
  const raw = readEnv(
    bucket === 'text'
      ? 'SCAN_IDENTIFY_TEXT_DAILY_LIMIT'
      : bucket === COMMERCE_ONLY_QUOTA_MODE
      ? 'SCAN_IDENTIFY_COMMERCE_ONLY_DAILY_LIMIT'
      : 'SCAN_IDENTIFY_IMAGE_DAILY_LIMIT',
  );
  const parsed = raw !== undefined ? parseInt(raw, 10) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  if (bucket === 'text') return SCAN_IDENTIFY_TEXT_DAILY_LIMIT_DEFAULT;
  if (bucket === COMMERCE_ONLY_QUOTA_MODE) return SCAN_IDENTIFY_COMMERCE_ONLY_DAILY_LIMIT_DEFAULT;
  return SCAN_IDENTIFY_IMAGE_DAILY_LIMIT_DEFAULT;
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

  // B33-SEC-003: the value that reaches the durable unique key is canonical,
  // never the caller's spelling. This is the authority point — index.ts also
  // canonicalises at the request boundary so execution and accounting agree,
  // but a bucket must not depend on a caller remembering to do that.
  const canonicalMode = canonicalizeQuotaBucket(mode);
  const dailyLimit = getScanIdentifyDailyLimit(canonicalMode, readEnv);

  try {
    const { data, error } = await (catalogClient as any).rpc(
      'check_and_increment_scan_identify_daily_usage',
      {
        p_user_id: userId,
        p_mode: canonicalMode,
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
    console.warn(
      '[scan-identify] quota_check_error user=%s mode=%s error=%s',
      logUserId,
      canonicalizeQuotaBucket(mode),
      msg,
    );
    return { outcome: 'unverified', reason: 'quota_rpc_error' };
  }
}
