import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE } from '../constants/featureFlags';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { loadPrivateSavedLooks } from '../services/privateSavedLookStore';

export type PrivateSavedLooksSummary = {
  /** Whether this build can have private Saved Looks at all. */
  available: boolean;
  /** How many this actor has. `null` until a read has completed. */
  count: number | null;
  /** True when the read failed — distinct from "you have none". */
  unreadable: boolean;
};

/**
 * How many private Dressing Room Saved Looks the signed-in actor has.
 *
 * WHY THE LOOKS SCREEN NEEDS THIS (BUG-14): a Look saved from the private
 * Dressing Room lives in a device-local store, while Closet -> MY LOOKS lists
 * cloud `looks` rows. Two different entities, both correct, both called a
 * "Look" — so a user who saved one from the Dressing Room, saw the Saved Look
 * confirmation, then opened MY LOOKS was shown an empty state and reasonably
 * concluded their Look had not survived. Nothing was lost; the surface simply
 * could not see it.
 *
 * This hook is a COUNT and a route, deliberately not a merge. The two entities
 * have different shapes, different detail screens and different ownership
 * rules, and folding one list into the other would be a redesign rather than a
 * repair.
 *
 * Failure is reported, never flattened to zero: "we could not read your Saved
 * Looks" and "you have no Saved Looks" must not look the same, which is the
 * mistake that made this defect look like data loss in the first place.
 */
export function usePrivateSavedLooksSummary(): PrivateSavedLooksSummary {
  const { isAuthenticated, user, loading: actorLoading } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : null;

  const [state, setState] = useState<{ actorKey: string | null; count: number | null; unreadable: boolean }>({
    actorKey: null,
    count: null,
    unreadable: false,
  });

  const load = useCallback(() => {
    if (!PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE || actorLoading || !actorId) return undefined;
    let live = true;
    const actorRequest = createActorRequest();
    void loadPrivateSavedLooks(actorRequest)
      .then((result) => {
        if (!live || !isActorRequestCurrent(actorRequest)) return;
        setState({
          actorKey,
          count: result.ok ? result.looks.length : null,
          unreadable: !result.ok,
        });
      })
      .catch(() => {
        if (!live || !isActorRequestCurrent(actorRequest)) return;
        setState({ actorKey, count: null, unreadable: true });
      });
    return () => {
      live = false;
    };
  }, [actorId, actorKey, actorLoading]);

  useFocusEffect(load);

  // Another actor's count is never this actor's count.
  const mine = state.actorKey === actorKey;
  return {
    available: PRIVATE_DRESSING_ROOM_SAVED_LOOKS_ACTIVE && !!actorId,
    count: mine ? state.count : null,
    unreadable: mine ? state.unreadable : false,
  };
}
