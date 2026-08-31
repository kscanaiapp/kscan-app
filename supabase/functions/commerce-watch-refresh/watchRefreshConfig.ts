// watchRefreshConfig.ts — operational controls for Watch refresh (§37).
//
// These are operational limits, not permanent product policy, and are not
// provider quota numbers (the C0 audit found no measured quota for any
// provider except Serper/RapidAPI's vendor-advertised figures, and Watchlist
// V1 only ever calls the two URL-enrichment adapters, neither of which has
// any measured quota either). Env-overridable so an operator can tune them
// without a redeploy of logic, matching the commerceFunnelConfig.ts idiom.

function readEnv(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (globalThis as any)?.Deno?.env?.get?.(name);
    return typeof v === 'string' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

function readIntEnv(name: string, fallback: number): number {
  const raw = readEnv(name);
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Minimum time between two refreshes of the SAME watch, regardless of trigger. */
export const MIN_REFRESH_INTERVAL_MS = readIntEnv('WATCHLIST_MIN_REFRESH_INTERVAL_MS', 10 * 60 * 1000);

/** Tier 1 (user-open, authenticated): max watches refreshed in one request. */
export const USER_REFRESH_BATCH_CAP = readIntEnv('WATCHLIST_USER_REFRESH_BATCH_CAP', 25);

/** Tier 2 (worker sweep): max watches claimed per invocation. Mirrors the
 * process-account-deletions / kplus-reconcile-revenuecat claim-limit shape. */
export const WORKER_SWEEP_BATCH_CAP = readIntEnv('WATCHLIST_WORKER_SWEEP_BATCH_CAP', 50);

/** Bounded provider concurrency within one refresh batch (§37). */
export const REFRESH_CONCURRENCY = readIntEnv('WATCHLIST_REFRESH_CONCURRENCY', 4);

/** Per-adapter-call deadline. Matches the existing enrichment adapters' own
 * PROVIDER_TIMEOUT_MS (4500ms) with headroom for the surrounding orchestration. */
export const REFRESH_CALL_DEADLINE_MS = readIntEnv('WATCHLIST_REFRESH_CALL_DEADLINE_MS', 6000);

/**
 * Consecutive failed-to-resolve cycles before a listing's last_status may
 * become 'unavailable' (§40, §53). A single timeout/429/outage/malformed
 * response must never present as "no longer listed" — false negative is
 * preferable to a false unavailability claim, and both are preferable to a
 * false price alert.
 */
export const UNAVAILABLE_AFTER_CONSECUTIVE_FAILURES = readIntEnv(
  'WATCHLIST_UNAVAILABLE_AFTER_FAILURES',
  5,
);

/** Bounded event history per watch (§22, §34) — enforced in SQL by
 * append_user_commerce_watch_event; exported here only so callers agree on
 * the number when reasoning about behavior, not to re-implement pruning. */
export const MAX_EVENTS_PER_WATCH = 20;
