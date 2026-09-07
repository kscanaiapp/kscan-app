// Closet Ownership V1 — the derived review set (PR A2, sections 48-51).
//
// Reads the actor's sync sidecar and hands it, with the items useCloset()
// already loaded, to the pure deriver. No store, no queue, no durable state:
// see DM-03 for why there is deliberately no Dismiss.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { listClosetSyncEntries } from '../services/closet/closetSyncStore';
import { deriveClosetReview, type ClosetReviewSummary } from '../services/closet/closetReview';
import type { ClosetSyncEntry } from '../services/closet/closetSyncContract';
import type { ClosetItemProjection } from '../services/closetItemProjection';
import { useAuthSession } from '../contexts/AuthSessionContext';

/**
 * @param items The actor's Closet, as projections.
 * @param revision Bump to re-read the sidecar after a mutation.
 */
export function useClosetReview(
  items: readonly ClosetItemProjection[],
  revision: unknown,
): ClosetReviewSummary {
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
        // A read that completed after an account change belongs to the previous
        // actor and must never be folded into this one's review set.
        if (!live || actorRef.current !== issuedFor) return;
        setEntries(next);
      })
      .catch(() => {
        // A sidecar we cannot read contributes no sync-derived reasons. The
        // item-derived ones (missing category, placeholder name) are unaffected,
        // so the review set degrades rather than disappearing or inventing work.
        if (!live || actorRef.current !== issuedFor) return;
        setEntries({});
      });
    return () => {
      live = false;
    };
  }, [actorId]);

  useEffect(() => read(), [read, revision]);

  // Whenever the sidecar is unreadable or empty, this still returns the
  // item-derived reasons — which is what keeps review working offline.
  return useMemo(() => deriveClosetReview(items, entries), [items, entries]);
}
