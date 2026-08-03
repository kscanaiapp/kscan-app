/**
 * Product Match Foundation V1 — configuration and deadlines.
 *
 * Every knob here is read through an injectable `envGet` so the deterministic
 * test suite can exercise real branches without touching process state, which
 * is the same pattern `qualityTuneConfig.ts` established for the scanner.
 *
 * FAIL-CLOSED BY DEFAULT. `PRODUCT_MATCH_DEFAULT_ENABLED` is `false` and there
 * is no code path that flips it implicitly: an operator must set
 * `PRODUCT_MATCH_ENABLED=true` on a backend that has already been redeployed
 * with this function present. That ordering is not stylistic — Closet Build 1
 * proved the reverse order (flag before backend) produces a hard failure with
 * no legacy fallback, because a flag can reach production faster than a deploy.
 */

export const PRODUCT_MATCH_VERSION = 'product-match-v1';

/** Contract version echoed in every response envelope. */
export const PRODUCT_MATCH_CONTRACT_VERSION = 1;

/**
 * Dormant until explicitly activated. See the file header for why this is not
 * merely a default but an ordering constraint.
 */
export const PRODUCT_MATCH_DEFAULT_ENABLED = false;

export type EnvGet = (key: string) => string | undefined;

export const defaultEnvGet: EnvGet = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

function readBool(envGet: EnvGet, key: string, fallback: boolean): boolean {
  const raw = envGet(key)?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return fallback;
}

function readInt(envGet: EnvGet, key: string, fallback: number, min: number, max: number): number {
  const raw = envGet(key)?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

export function isProductMatchEnabled(envGet: EnvGet = defaultEnvGet): boolean {
  return readBool(envGet, 'PRODUCT_MATCH_ENABLED', PRODUCT_MATCH_DEFAULT_ENABLED);
}

/**
 * Whether the service may ASSERT `EXACT` in a response.
 *
 * Separate from the tier rule on purpose, and separate from
 * `PRODUCT_MATCH_ENABLED` too. `evidence.ts` answers "is this evidence
 * decisive"; this flag answers "are we willing to say so to a user yet". Those
 * come apart: the rule can be correct and validated in tests long before any
 * wired source has been proven to produce trustworthy identifiers end to end.
 *
 * With the flag off, a match whose evidence satisfies the EXACT gate is
 * reported as `LIKELY_EXACT`. The evidence array is unchanged, so the
 * downgrade is visible to anyone reading the response and reversible without a
 * logic change.
 */
export const PRODUCT_MATCH_EXACT_CLAIMS_DEFAULT_ENABLED = false;

export function areExactClaimsEnabled(envGet: EnvGet = defaultEnvGet): boolean {
  return readBool(
    envGet,
    'PRODUCT_MATCH_EXACT_CLAIMS_ENABLED',
    PRODUCT_MATCH_EXACT_CLAIMS_DEFAULT_ENABLED,
  );
}

/**
 * Orchestration ceilings — HANG GUARDS, NOT PERFORMANCE BUDGETS.
 *
 * Read this before changing a number here.
 *
 * These values exist to stop a wedged socket from holding a request open
 * forever. They are deliberately generous, and they are deliberately NOT
 * derived from a latency target. Checkpoint 1 shipped 3 s / 8 s defaults
 * reasoned backwards from the observed `scan_commerce_events` distribution;
 * that was the wrong move and has been reverted, because cutting providers off
 * at a tuned threshold *hides* the latency question instead of answering it. A
 * provider truncated at 3 s produces no evidence about why it took 3 s.
 *
 * The diagnostic order is: instrument every stage, attribute the time, and only
 * then decide what a provider is allowed to cost. Until that has happened:
 *
 *   - no number here is a promotion requirement
 *   - a regression from the current ~9.2 s end-to-end scan is NOT automatically
 *     rejected; it must be ATTRIBUTED (which stage, did quality improve, was
 *     the call useful, can it be parallelized / cached / deferred / removed)
 *   - `stageTimings` on every response is the actual deliverable, not the
 *     ceilings
 *
 * Every ceiling is env-overridable so an operator can tighten one for a
 * specific experiment without a redeploy.
 */
export type ProductMatchDeadlines = {
  /**
   * Hang guard for any single provider call. Generous on purpose: a provider
   * that legitimately takes 6 s should be MEASURED taking 6 s, not truncated
   * into an unattributable timeout.
   */
  perProviderMs: number;
  /**
   * Absolute ceiling on the orchestration. Never exceeded, even if zero
   * providers answered. This is the only value that genuinely protects the
   * caller, and it is set well above any plausible healthy request.
   */
  totalMs: number;
  /**
   * OBSERVATIONAL ONLY. Marks responses whose first useful match arrived later
   * than this, so slow-first-result cases can be found in telemetry. It
   * truncates nothing, cancels nothing, and changes no tier — it is a label on
   * a measurement, not a budget.
   */
  firstUsefulObservationMs: number;
};

export const PRODUCT_MATCH_DEFAULT_DEADLINES: ProductMatchDeadlines = {
  perProviderMs: 15000,
  totalMs: 20000,
  firstUsefulObservationMs: 5000,
};

/**
 * The end-to-end scan latency this work is measured AGAINST, in milliseconds.
 *
 * Not a target and not a limit — an anchor. Every latency claim about
 * product-match has to be stated as a delta from the current user-visible scan,
 * and a delta is meaningless without a fixed reference point. Sourced from the
 * current production scan behaviour (~9.2 s end to end); `scan_commerce_events`
 * puts commerce retrieval itself at p50 1.3–2.0 s / p95 ~3.0 s inside that,
 * with identification carrying the remainder.
 *
 * Moving to 12 s is not automatically a failure. Moving to 12 s without being
 * able to say WHICH STAGE added the 2.8 s is the failure.
 */
export const PRODUCT_MATCH_BASELINE_SCAN_MS = 9200;

export function readDeadlines(envGet: EnvGet = defaultEnvGet): ProductMatchDeadlines {
  const perProviderMs = readInt(
    envGet,
    'PRODUCT_MATCH_PROVIDER_DEADLINE_MS',
    PRODUCT_MATCH_DEFAULT_DEADLINES.perProviderMs,
    250,
    60000,
  );
  const totalMs = readInt(
    envGet,
    'PRODUCT_MATCH_TOTAL_DEADLINE_MS',
    PRODUCT_MATCH_DEFAULT_DEADLINES.totalMs,
    500,
    60000,
  );
  const firstUsefulObservationMs = readInt(
    envGet,
    'PRODUCT_MATCH_FIRST_USEFUL_OBSERVATION_MS',
    PRODUCT_MATCH_DEFAULT_DEADLINES.firstUsefulObservationMs,
    250,
    60000,
  );

  // A per-provider ceiling above the total ceiling is not a configuration the
  // orchestrator can honour, so it is clamped rather than obeyed. Silently
  // running past `totalMs` would defeat the only guarantee this type makes.
  // The observation threshold is NOT clamped to the total — it is a label, and
  // an operator may legitimately set it far below either ceiling to find slow
  // first results.
  return {
    perProviderMs: Math.min(perProviderMs, totalMs),
    totalMs,
    firstUsefulObservationMs,
  };
}

/**
 * Maximum listings returned to a caller. Deliberately small: this phase is
 * about which matches are defensible, not about breadth.
 */
export const PRODUCT_MATCH_MAX_LISTINGS = 24;

/** Maximum families returned to a caller. */
export const PRODUCT_MATCH_MAX_FAMILIES = 12;
