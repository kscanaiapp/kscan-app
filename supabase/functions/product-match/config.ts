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
 * Orchestration deadlines.
 *
 * These are ceilings, not budgets to spend. A provider that answers in 400 ms
 * does not wait for the deadline; the deadline exists so that ONE slow provider
 * cannot extend the wall clock of the whole request. The two-stage shape
 * (first-useful vs. complete) is what lets the caller render early without the
 * confidence rules being relaxed to hit a number — the tier of a listing never
 * depends on how fast it arrived.
 *
 * Defaults are derived from the measured production baseline recorded in
 * `docs/product-match-foundation-v1.md`: commerce retrieval inside
 * `scan-identify` runs p50 ≈ 1.3–2.0 s / p95 ≈ 3.0 s *sequentially* across up
 * to four providers, so a 3 s per-provider ceiling is above the observed p95 of
 * the slowest single provider while an 8 s total ceiling is below the observed
 * end-to-end p95 of the existing cascade.
 */
export type ProductMatchDeadlines = {
  /** Hard ceiling for any single provider call. */
  perProviderMs: number;
  /**
   * Point at which the orchestrator stops waiting for stragglers and returns
   * whatever has completed. Never exceeded, even if zero providers answered.
   */
  totalMs: number;
  /**
   * Soft checkpoint used only for measurement: the moment at which the first
   * listing that already qualifies as useful became available. Emitted as
   * telemetry; it does not truncate or alter the result set.
   */
  firstUsefulTargetMs: number;
};

export const PRODUCT_MATCH_DEFAULT_DEADLINES: ProductMatchDeadlines = {
  perProviderMs: 3000,
  totalMs: 8000,
  firstUsefulTargetMs: 5000,
};

export function readDeadlines(envGet: EnvGet = defaultEnvGet): ProductMatchDeadlines {
  const perProviderMs = readInt(
    envGet,
    'PRODUCT_MATCH_PROVIDER_DEADLINE_MS',
    PRODUCT_MATCH_DEFAULT_DEADLINES.perProviderMs,
    250,
    15000,
  );
  const totalMs = readInt(
    envGet,
    'PRODUCT_MATCH_TOTAL_DEADLINE_MS',
    PRODUCT_MATCH_DEFAULT_DEADLINES.totalMs,
    500,
    30000,
  );
  const firstUsefulTargetMs = readInt(
    envGet,
    'PRODUCT_MATCH_FIRST_USEFUL_TARGET_MS',
    PRODUCT_MATCH_DEFAULT_DEADLINES.firstUsefulTargetMs,
    250,
    30000,
  );

  // A per-provider ceiling above the total ceiling is not a configuration the
  // orchestrator can honour, so it is clamped rather than obeyed. Silently
  // running past `totalMs` would defeat the only guarantee this type makes.
  return {
    perProviderMs: Math.min(perProviderMs, totalMs),
    totalMs,
    firstUsefulTargetMs: Math.min(firstUsefulTargetMs, totalMs),
  };
}

/**
 * Maximum listings returned to a caller. Deliberately small: this phase is
 * about which matches are defensible, not about breadth.
 */
export const PRODUCT_MATCH_MAX_LISTINGS = 24;

/** Maximum families returned to a caller. */
export const PRODUCT_MATCH_MAX_FAMILIES = 12;
