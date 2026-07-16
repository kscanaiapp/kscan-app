import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  listSharedRoomsForCurrentUser,
  removeSharedRoomForCurrentUser,
  type SharedRoomMembershipSummary,
} from '../services/sharedRoomMemberships';
import {
  SHARED_WITH_ME_REFRESH_ERROR,
  applyOptimisticSharedRoomRemoval,
  applySharedWithMeListResult,
  applySuccessfulFinalSharedRoomRemoval,
  beginSharedWithMeLoad,
  clearSharedWithMeForActorChange,
  createSharedWithMeSnapshot,
  restoreSharedRoomAfterFailedRemoval,
  type SharedWithMeSnapshot,
} from '../services/sharedWithMeListLogic';

export type UseSharedRoomMembershipsResult = {
  snapshot: SharedWithMeSnapshot;
  rooms: SharedRoomMembershipSummary[];
  loading: boolean;
  refreshing: boolean;
  temporaryFailure: boolean;
  empty: boolean;
  unauthenticated: boolean;
  removingToken: string | null;
  removeError: string | null;
  reload: () => Promise<void>;
  removeFromList: (room: SharedRoomMembershipSummary) => Promise<boolean>;
  clearRemoveError: () => void;
};

export function useSharedRoomMemberships(): UseSharedRoomMembershipsResult {
  const { user, loading: authLoading, isAuthenticated } = useAuthSession();
  const actorId = isAuthenticated && user?.id ? user.id : null;

  const [snapshot, setSnapshot] = useState<SharedWithMeSnapshot>(() =>
    createSharedWithMeSnapshot(actorId),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [removingToken, setRemovingToken] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const snapshotRef = useRef(snapshot);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const inFlightActorRef = useRef<string | null>(null);
  const removedTokensRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);
  const actorIdRef = useRef(actorId);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    actorIdRef.current = actorId;
  }, [actorId]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const previousActor = snapshotRef.current.actorId;
    if (previousActor === actorId) return;

    // Invalidate any in-flight list for the previous actor.
    inFlightRef.current = null;
    inFlightActorRef.current = null;
    removedTokensRef.current = new Set();
    setRemoveError(null);
    setRemovingToken(null);
    setRefreshing(false);
    setSnapshot((previous) => clearSharedWithMeForActorChange(previous, actorId));
  }, [actorId]);

  const reload = useCallback(async () => {
    if (authLoading) return;
    if (!actorId) {
      if (mountedRef.current) {
        setSnapshot((previous) => clearSharedWithMeForActorChange(previous, null));
      }
      return;
    }

    if (inFlightRef.current) {
      // Deduplicate only when the in-flight request belongs to this actor.
      if (inFlightActorRef.current === actorId) {
        await inFlightRef.current;
        return;
      }
    }

    let generation = 0;
    setSnapshot((previous) => {
      const next = beginSharedWithMeLoad(previous, actorId);
      generation = next.generation;
      return next;
    });
    setRefreshing(true);

    const requestActorId = actorId;
    const request = (async () => {
      const result = await listSharedRoomsForCurrentUser();
      if (!mountedRef.current) return;
      if (actorIdRef.current !== requestActorId) return;

      setSnapshot((previous) => {
        const applied = applySharedWithMeListResult({
          previous,
          generation,
          actorId: requestActorId,
          result,
          removedTokens: removedTokensRef.current,
        });
        return applied ?? previous;
      });
    })().finally(() => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        inFlightActorRef.current = null;
      }
      if (mountedRef.current && actorIdRef.current === requestActorId) {
        setRefreshing(false);
      }
    });

    inFlightRef.current = request;
    inFlightActorRef.current = requestActorId;
    await request;
  }, [actorId, authLoading]);

  // Match owned-room focus refresh (useDressingRooms → useFocusEffect).
  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const removeFromList = useCallback(async (room: SharedRoomMembershipSummary) => {
    if (removingToken) return false;

    const token = room.shareToken;
    setRemovingToken(token);
    setRemoveError(null);

    const previousRooms = snapshotRef.current.rooms;
    setSnapshot((previous) => applySuccessfulFinalSharedRoomRemoval(previous, token));

    removedTokensRef.current.add(token);

    try {
      const result = await removeSharedRoomForCurrentUser(token);
      if (!mountedRef.current) return false;

      if (result.status === 'removed') {
        setRemovingToken(null);
        return true;
      }

      removedTokensRef.current.delete(token);
      setSnapshot((previous) => {
        const rooms = restoreSharedRoomAfterFailedRemoval(previous.rooms, room);
        return {
          ...previous,
          rooms,
          phase: rooms.length === 0 ? 'empty' : 'ready',
          errorMessage: null,
        };
      });
      setRemoveError(
        result.status === 'unauthenticated'
          ? 'Sign in to update your Shared with Me list.'
          : SHARED_WITH_ME_REFRESH_ERROR,
      );
      setRemovingToken(null);
      return false;
    } catch {
      if (!mountedRef.current) return false;
      removedTokensRef.current.delete(token);
      setSnapshot((previous) => {
        const rooms = restoreSharedRoomAfterFailedRemoval(
          previous.rooms.length === 0 ? previousRooms : previous.rooms,
          room,
        );
        return {
          ...previous,
          rooms,
          phase: rooms.length === 0 ? 'empty' : 'ready',
          errorMessage: null,
        };
      });
      setRemoveError(SHARED_WITH_ME_REFRESH_ERROR);
      setRemovingToken(null);
      return false;
    }
  }, [removingToken]);

  const clearRemoveError = useCallback(() => {
    setRemoveError(null);
  }, []);

  const loading =
    Boolean(actorId) &&
    snapshot.phase === 'loading' &&
    snapshot.rooms.length === 0;

  return {
    snapshot,
    rooms: snapshot.rooms,
    loading,
    refreshing,
    temporaryFailure: snapshot.phase === 'temporary_failure',
    empty: snapshot.phase === 'empty',
    unauthenticated: !actorId || snapshot.phase === 'unauthenticated',
    removingToken,
    removeError,
    reload,
    removeFromList,
    clearRemoveError,
  };
}
