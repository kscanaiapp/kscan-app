// Closet Experience V1 — cloud status for the Closet header (PR A1, sections 31/32).
//
// Reads the EXISTING sidecar and the EXISTING entitlement authority. It starts
// no pass, retries nothing, and writes nothing — `useCloset()` already triggers
// `resumeClosetSync` / `resumeClosetRestore` on focus, and duplicating that here
// would double the passes for a status pill.
//
// ENTITLEMENT IS CONSUMED, NEVER REIMPLEMENTED (section 13). Eligibility comes
// from `isClosetCloudSyncEligible`, the same predicate the engine itself gates
// on, so the pill can never disagree with the engine about whether sync applies.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { listClosetSyncEntries } from '../services/closet/closetSyncStore';
import { isClosetCloudSyncEligible } from '../services/closet/closetSyncEngine';
import {
  presentClosetSyncStatus,
  type ClosetSyncPresentation,
} from '../services/closet/closetSyncPresentation';
import type { ClosetSyncEntry } from '../services/closet/closetSyncContract';
import { useKPlusEntitlement } from './useKPlusEntitlement';
import { useAuthSession } from '../contexts/AuthSessionContext';

/**
 * @param revision Bump to force a re-read. The Closet screen passes its item
 *   count / load generation, so a save or a delete refreshes the pill without
 *   this hook polling or subscribing to the store.
 */
export function useClosetSyncStatus(revision: unknown): ClosetSyncPresentation | null {
  const { isAuthenticated, user } = useAuthSession();
  const { state } = useKPlusEntitlement();
  const actorId = isAuthenticated ? user?.id ?? null : null;

  const [entries, setEntries] = useState<Record<string, ClosetSyncEntry>>({});
  // Stamped with the actor the read was issued for. A completion that lands
  // after an account change must never be rendered under the new actor —
  // the same rule useCloset() applies to items (section 72).
  const actorRef = useRef<string | null>(actorId);
  actorRef.current = actorId;

  const read = useCallback(() => {
    let live = true;
    const issuedFor = actorId;
    void listClosetSyncEntries(issuedFor)
      .then((next) => {
        if (!live || actorRef.current !== issuedFor) return;
        setEntries(next);
      })
      .catch(() => {
        // A sidecar we cannot read is not a Closet problem. Fall back to
        // "nothing pending" rather than inventing an attention state.
        if (!live || actorRef.current !== issuedFor) return;
        setEntries({});
      });
    return () => {
      live = false;
    };
  }, [actorId]);

  useFocusEffect(read);

  useEffect(() => read(), [read, revision]);

  // RESOLVING IS NOT INACTIVE (section 12). While the entitlement authority has
  // not answered, the presenter is told so and returns null — no pill, no
  // "unavailable" claim, no pitch.
  return presentClosetSyncStatus({
    resolving: state === 'loading',
    eligible: isClosetCloudSyncEligible(undefined, state),
    entries,
  });
}
