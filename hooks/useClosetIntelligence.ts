// Closet Intelligence V1 — the read-only downstream interface (PR B, section 64).
//
// A hook, not a service call. There is no intelligence endpoint and no durable
// intelligence store (section 55): the contract is recomputed locally from the
// authoritative Closet whenever that Closet changes, and memoized for the
// current data version in between.
//
// NOT WIRED TO ELISE, PACKING OR THE CONCIERGE. Section 64 is explicit that this
// lane exposes the interface and stops there. Those systems keep their own
// existing wardrobe sources; connecting them is a separate, reviewed change.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  computeClosetIntelligence,
  type ClosetIntelligence,
} from '../services/closet/closetIntelligence';
import { listClosetSyncEntries } from '../services/closet/closetSyncStore';
import type { ClosetSyncEntry } from '../services/closet/closetSyncContract';
import type { ClosetItemProjection } from '../services/closetItemProjection';
import { useAuthSession } from '../contexts/AuthSessionContext';

/**
 * @param items The actor's Closet, already loaded and projected by useCloset().
 * @param revision Bump to re-read the sidecar (a save, a delete, a restore).
 */
export function useClosetIntelligence(
  items: readonly ClosetItemProjection[],
  revision: unknown,
): ClosetIntelligence {
  const { isAuthenticated, user } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;

  const [entries, setEntries] = useState<Record<string, ClosetSyncEntry>>({});
  const actorRef = useRef<string | null>(actorId);
  actorRef.current = actorId;

  const read = useCallback(() => {
    let live = true;
    const issuedFor = actorId;
    void listClosetSyncEntries(issuedFor)
      .then((next) => {
        // A read completing after an account change belongs to the previous
        // actor. Folding it in would make B's intelligence describe a Closet
        // that is no longer on screen (section 72).
        if (!live || actorRef.current !== issuedFor) return;
        setEntries(next);
      })
      .catch(() => {
        if (!live || actorRef.current !== issuedFor) return;
        setEntries({});
      });
    return () => {
      live = false;
    };
  }, [actorId]);

  useEffect(() => read(), [read, revision]);

  // Recomputed when the authoritative Closet state changes — add, edit, delete,
  // restore completion, or a sync merge that moved a sidecar entry. Not cached
  // beyond that: a second durable store for derived arithmetic would be a new
  // data class to keep correct, delete and isolate, for no benefit.
  return useMemo(() => computeClosetIntelligence(items, entries), [items, entries]);
}
