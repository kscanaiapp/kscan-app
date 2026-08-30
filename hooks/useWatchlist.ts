// K+ Smart Watchlist V1 — list state for the Watchlist home screen.
//
// Tier 1 "user-open refresh" (§38 of the build brief): refreshing here calls
// the batch refresh action once per screen focus, never per render, and the
// server itself skips any watch checked within the last
// WATCHLIST_MIN_REFRESH_INTERVAL_MS — this hook does not attempt its own
// debouncing on top of that, since re-fetching the list is cheap (RLS-scoped
// single query) and re-refreshing provider state is what the server bounds.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { fetchWatchlist, refreshWatches } from '../services/watchlist/watchlistClient';
import type { CommerceWatch } from '../types/watchlist';

export function useWatchlist() {
  const { isAuthenticated } = useAuthSession();
  const [watches, setWatches] = useState<CommerceWatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const hasRequestedRefresh = useRef(false);

  const reload = useCallback(async () => {
    if (!isAuthenticated) {
      setWatches([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    const result = await fetchWatchlist();
    if (result.ok) {
      setWatches(result.data);
    } else {
      setError('Unable to load your Watchlist.');
    }
    setLoading(false);
  }, [isAuthenticated]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // One background batch refresh per authenticated mount, not per render or
  // per focus — opening/re-rendering Watchlist must not repeatedly invoke
  // providers (§38). Errors are swallowed: a failed background refresh must
  // never block the list from showing what it already has.
  useEffect(() => {
    if (!isAuthenticated || hasRequestedRefresh.current) return;
    hasRequestedRefresh.current = true;
    void (async () => {
      setRefreshing(true);
      await refreshWatches().catch(() => null);
      await reload();
      setRefreshing(false);
    })();
  }, [isAuthenticated, reload]);

  return { watches, loading, error, refreshing, reload };
}
