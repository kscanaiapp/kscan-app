/**
 * NOTE (INT-KPLUS-008): buildDueWatchPath is no longer on the Tier 1 refresh
 * path. A plain staleness SELECT is not mutual exclusion -- two concurrent
 * manual refreshes both passed it -- so handleRefresh now claims through
 * claim_user_commerce_watches_for_refresh instead.
 *
 * The module and its tests are retained deliberately: they still pin the
 * owner-scoping and injection-safety of the query builder, which the
 * single-watch "not due / not active / not found" lookup in handleRefresh
 * continues to rely on the same conventions for.
 */
/**
 * refreshQuery.ts — the due-watch selection predicate for a Tier 1
 * (user-open, authenticated) refresh.
 *
 * Lives in its own module so it can be asserted directly: importing index.ts
 * would run Deno.serve at module load, so anything only reachable from there
 * can be checked by reading source text but never by executing it.
 *
 * DEF-WL-04 (hostile-audit repair). §38 requires that no trigger re-invoke a
 * provider for a watch already checked inside MIN_REFRESH_INTERVAL_MS. The
 * staleness predicate was previously applied only to the batch branch, so the
 * Watch detail screen's REFRESH button — which sends a single watchId — had
 * no cooldown at all: one tap was one provider call, and holding the button
 * down was an unbounded provider fan-out on an endpoint any K+ user can
 * reach. It also made the endpoint's own `too_recent` reply unreachable, so
 * that branch reported "already fresh" only for watches that were in fact
 * paused or missing.
 */

/**
 * PostgREST path selecting the watches a Tier 1 refresh may actually observe.
 *
 * Invariants, in order:
 *   - always scoped to the calling actor and to live, active watches;
 *   - always filtered on staleness, for BOTH the single-watch and batch
 *     shapes — the trigger never changes whether the cooldown applies;
 *   - the batch shape is additionally capped.
 */
export function buildDueWatchPath(
  userId: string,
  staleCutoffIso: string,
  watchId: string | null,
  batchCap: number,
): string {
  let path = `user_commerce_watches?user_id=eq.${userId}&status=eq.active&deleted_at=is.null`;
  path += `&or=(last_checked_at.is.null,last_checked_at.lt.${staleCutoffIso})`;
  if (watchId) {
    path += `&id=eq.${watchId}`;
  } else {
    path += `&limit=${batchCap}`;
  }
  return path;
}
