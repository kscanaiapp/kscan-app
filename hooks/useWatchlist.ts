// K+ Smart Watchlist V1 — list state for the Watchlist home screen.
//
// Tier 1 "user-open refresh" (§38 of the build brief): refreshing here calls
// the batch refresh action once per screen focus, never per render, and the
// server itself skips any watch checked within the last
// WATCHLIST_MIN_REFRESH_INTERVAL_MS — this hook does not attempt its own
// debouncing on top of that, since re-fetching the list is cheap (RLS-scoped
// single query) and re-refreshing provider state is what the server bounds.
//
// INT-KPLUS-003 — actor isolation.
// This hook previously keyed everything on `isAuthenticated`. That is NOT actor
// identity: it stays `true` across an A -> B account switch, so the reload
// effect never re-ran and Actor A's watches kept rendering under Actor B. Worse,
// an in-flight fetch had no staleness check at all, so a late A response could
// repopulate the list after B had loaded.
//
// State is now keyed on the canonical actor scope key (actor id + epoch) from
// services/actorScope, and every async completion re-validates the scope it
// captured before mutating. The epoch is what makes an A -> B -> A switch safe:
// the actor id matches again, but the generation does not.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  captureActorScope,
  currentActorScopeKey,
  isActorScopeCurrent,
} from '../services/actorScope';
import { fetchWatchlist, refreshWatches } from '../services/watchlist/watchlistClient';
import type { CommerceWatch } from '../types/watchlist';

export function useWatchlist() {
  const { isAuthenticated, user } = useAuthSession();
  // Recomputed on every render; `user?.id` is only the render trigger, the key
  // itself carries the epoch so a same-id re-authentication still changes it.
  const actorScopeKey = currentActorScopeKey();

  const [watches, setWatches] = useState<CommerceWatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasRequestedRefresh = useRef<string | null>(null);
  // The actor whose data currently sits in `watches`. Anything else is stale
  // and must never be rendered, not even for one frame.
  const loadedScopeKey = useRef<string | null>(null);

  const reload = useCallback(async () => {
    const scope = captureActorScope();
    if (!isAuthenticated) {
      setWatches([]);
      loadedScopeKey.current = null;
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await fetchWatchlist();
    // Actor changed while the request was in flight: drop it entirely.
    if (!isActorScopeCurrent(scope)) return;
    if (result.ok) {
      setWatches(result.data);
      loadedScopeKey.current = `${scope.actorId ?? 'anonymous'}#${scope.epoch}`;
    } else {
      setError('Unable to load your Watchlist.');
    }
    setLoading(false);
    // actorScopeKey participates so a change of actor produces a NEW reload
    // identity even while isAuthenticated stays true.
  }, [isAuthenticated, actorScopeKey]);

  // Clear synchronously on an actor boundary, before any await can resolve, so
  // the previous actor's watches are never visible to the next one.
  useEffect(() => {
    if (loadedScopeKey.current !== null && loadedScopeKey.current !== actorScopeKey) {
      setWatches([]);
      setError(null);
      setLoading(true);
      loadedScopeKey.current = null;
    }
  }, [actorScopeKey]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // One background batch refresh per authenticated mount, not per render or
  // per focus — opening/re-rendering Watchlist must not repeatedly invoke
  // providers (§38). Errors are swallowed: a failed background refresh must
  // never block the list from showing what it already has.
  //
  // Tracked per actor scope, not as a plain boolean: a new actor is entitled to
  // its own single refresh, and the previous actor's flag must not suppress it.
  useEffect(() => {
    if (!isAuthenticated || hasRequestedRefresh.current === actorScopeKey) return;
    hasRequestedRefresh.current = actorScopeKey;
    const scope = captureActorScope();
    void (async () => {
      setRefreshing(true);
      await refreshWatches().catch(() => null);
      if (!isActorScopeCurrent(scope)) return;
      await reload();
      if (!isActorScopeCurrent(scope)) return;
      setRefreshing(false);
    })();
  }, [isAuthenticated, actorScopeKey, reload]);

  // Never hand back another actor's rows, even if a render lands between the
  // actor transition and the clearing effect above.
  const safeWatches = loadedScopeKey.current === actorScopeKey ? watches : [];

  return { watches: safeWatches, loading, error, refreshing, reload };
}
