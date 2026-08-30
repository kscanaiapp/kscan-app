/**
 * Backend Commerce Funnel control (v127).
 *
 * Builds on the Phase 3 provider modernization:
 *   funnel OFF → exact Phase 3 behavior (commerce inline, one 4.5s discovery
 *                deadline, enrichment inside the scan response)
 *   funnel ON  → commerce is decoupled from scan completion: the scan response
 *                no longer waits on providers, a bounded fast path serves the
 *                first commerce shelf, and URL enrichment is deferred
 *
 * Rollback without redeploy: set BACKEND_COMMERCE_FUNNEL_V127_ENABLED=false.
 *
 * The governing UX principle, and the reason this layer exists:
 *   COMMERCE MAY LOAD AFTER THE SCAN.
 *   COMMERCE MUST NOT HOLD THE SCAN HOSTAGE.
 *
 * v127 changes orchestration only. The v124 identity-aware ranking model and
 * the v125 query construction are consumed unchanged — this layer decides
 * *when* and *how long* we retrieve, never *what wins*.
 */

export const COMMERCE_FUNNEL_VERSION = 'v127';

/**
 * Default OFF: this layer has not completed staging validation and it changes
 * the request/response sequence, which the client must opt into. Flip this
 * constant (or set the env var) once v127 has been validated on App Staging.
 *
 *   BACKEND_COMMERCE_FUNNEL_V127_ENABLED=true  → enabled
 *   BACKEND_COMMERCE_FUNNEL_V127_ENABLED=false → disabled (exact Phase 3)
 */
export const COMMERCE_FUNNEL_DEFAULT_ENABLED = false;

// ── Fast commerce path ───────────────────────────────────────────────────────

/**
 * Hard ceiling for the whole fast commerce fan-out.
 *
 * Chosen at the bottom of the 1.8–2.0s target band: the fast path is the first
 * thing a user sees after the scan result, and Phase 3 measurement showed
 * Poshmark alone ranging to 13.9s. Anything a provider cannot deliver inside
 * this window is not a fast result by definition — it can still arrive through
 * the deferred enrichment hop.
 */
export const FAST_COMMERCE_DEADLINE_MS = 1_900;

/**
 * Early success. Once this many rankable candidates exist there is nothing a
 * straggler can add to the *first* shelf that justifies holding it open, so the
 * fast path returns rather than waiting out the remaining budget.
 */
export const FAST_COMMERCE_SUFFICIENT_RESULTS = 3;

/**
 * How often the early-success condition is evaluated while the fan-out runs.
 * Small enough to not add perceptible latency, large enough to not busy-spin.
 */
export const FAST_COMMERCE_POLL_INTERVAL_MS = 25;

/**
 * The invariant that Phase 3 violated implicitly: a provider may never be given
 * a deadline longer than the budget that remains for the whole fan-out.
 *
 * Phase 3 paired a 4.5s global discovery deadline with a 4.5s per-provider
 * timeout, so a single slow provider could consume the entire window. Under
 * v127 every provider call is bounded by whichever is smaller.
 */
export function providerDeadlineMs(
  remainingBudgetMs: number,
  providerTimeoutMs: number,
): number {
  return Math.max(0, Math.min(remainingBudgetMs, providerTimeoutMs));
}

// ── Deferred URL enrichment ──────────────────────────────────────────────────

/**
 * Farfetch3 (~3.0s) and KicksCrew (~2.6s) are URL enrichment APIs, not keyword
 * discovery APIs. Their latency is too expensive for first paint, so they run
 * as a bounded follow-up against offers the user can already see.
 */
export const MAX_ENRICHMENT_CANDIDATES = 2;

/**
 * Ceiling for the deferred enrichment hop. Generous relative to the fast path
 * because nothing is waiting on it visually, but still bounded so a hung
 * provider cannot keep a client request open indefinitely.
 */
export const ENRICHMENT_DEADLINE_MS = 6_000;

// ── Result cache ─────────────────────────────────────────────────────────────

/**
 * Live-offer TTL.
 *
 * Ten minutes sits mid-band of the 5–15 minute target. The lower bound is
 * driven by price/availability drift (these are live offers, not catalog rows);
 * the upper bound by the fact that Recent Scans already persists the offers a
 * user actually saw, so the cache only has to accelerate *repeat retrieval*,
 * never act as the record of what was shown. Ten minutes comfortably covers a
 * scan → look away → re-open cycle without letting a stale price survive long.
 */
export const COMMERCE_CACHE_TTL_MS = 10 * 60 * 1000;

/** Bound on retained cache entries — this is an accelerator, not a store. */
export const COMMERCE_CACHE_MAX_ENTRIES = 200;

export function isCommerceFunnelEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_COMMERCE_FUNNEL_V127_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return COMMERCE_FUNNEL_DEFAULT_ENABLED;
}

export function commerceFunnelTreatmentBucket(
  enabled: boolean,
): 'commerce_funnel_on' | 'commerce_funnel_off' {
  return enabled ? 'commerce_funnel_on' : 'commerce_funnel_off';
}
