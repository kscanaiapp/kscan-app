// Closet Experience V1 — search / filter / sort state (PR A1).
//
// Holds the QUERY, not the items. `useCloset()` remains the sole owner of what
// the Closet contains and the sole thing that touches disk; this hook only
// remembers what the user asked to see and re-derives the view with the pure
// lens in services/closet/closetInventory.ts.
//
// NOT PERSISTED, DELIBERATELY. A search string and a category chip are
// per-visit intent, not settings. Persisting them would create a new durable,
// actor-scoped state class that account deletion and actor isolation would both
// have to cover (sections 72/73) in exchange for remembering a filter across an
// app restart — a bad trade. It also means the actor-isolation story is trivial:
// this state cannot leak between accounts because it does not outlive the mount.

import { useCallback, useMemo, useState } from 'react';
import type { ClosetItemProjection } from '../services/closetItemProjection';
import {
  queryCloset,
  summarizeCloset,
  type ClosetInventoryResult,
  type ClosetInventorySummary,
  type ClosetOriginFilterId,
  type ClosetSortId,
} from '../services/closet/closetInventory';

export type UseClosetInventoryResult = {
  /** Counts over EVERY item the actor owns — never over the filtered subset. */
  summary: ClosetInventorySummary;
  /** The filtered, sorted view. */
  view: ClosetInventoryResult;
  search: string;
  setSearch: (value: string) => void;
  category: string | null;
  setCategory: (value: string | null) => void;
  origin: ClosetOriginFilterId;
  setOrigin: (value: ClosetOriginFilterId) => void;
  sort: ClosetSortId;
  setSort: (value: ClosetSortId) => void;
  /** True when any control is narrowing the list. */
  isNarrowed: boolean;
  clear: () => void;
};

export function useClosetInventory(
  items: readonly ClosetItemProjection[],
): UseClosetInventoryResult {
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [origin, setOrigin] = useState<ClosetOriginFilterId>('all');
  const [sort, setSort] = useState<ClosetSortId>('recently_added');

  // The summary is computed over the UNFILTERED array on purpose: "You have 14
  // Tops" must not change to "You have 3 Tops" because a search box has text in
  // it. The summary describes the Closet; the view describes the query.
  const summary = useMemo(() => summarizeCloset(items), [items]);

  const view = useMemo(
    () => queryCloset(items, { search, category, origin, sort }),
    [items, search, category, origin, sort],
  );

  const clear = useCallback(() => {
    setSearch('');
    setCategory(null);
    setOrigin('all');
  }, []);

  return {
    summary,
    view,
    search,
    setSearch,
    category,
    setCategory,
    origin,
    setOrigin,
    sort,
    setSort,
    isNarrowed: view.filtered,
    clear,
  };
}
