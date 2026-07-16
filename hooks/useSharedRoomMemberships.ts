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
  const removedTokensRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const previousActor = snapshotRef.current.actorId;
    if (previousActor === actorId) return;

    removedTokensRef.current = new Set();
    setRemoveError(null);
    setRemovingToken(null);
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
      await inFlightRef.current;
      return;
    }

    let generation = 0;
    setSnapshot((previous) => {
      const next = beginSharedWithMeLoad(previous, actorId);
      generation = next.generation;
      return next;
    });
    setRefreshing(true);

    const request = (async () => {
      const result = await listSharedRoomsForCurrentUser();
      if (!mountedRef.current) return;

      setSnapshot((previous) => {
        const applied = applySharedWithMeListResult({
          previous,
          generation,
          actorId,
          result,
          removedTokens: removedTokensRef.current,
        });
        return applied ?? previous;
      });
    })().finally(() => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
      }
      if (mountedRef.current) {
        setRefreshing(false);
      }
    });

    inFlightRef.current = request;
    await request;
  }, [actorId, authLoading]);

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
    setSnapshot((previous) => {
      const rooms = applyOptimisticSharedRoomRemoval(previous.rooms, token);
      return {
        ...previous,
        rooms,
        phase: rooms.length === 0 ? 'empty' : previous.phase === 'temporary_failure' ? 'temporary_failure' : 'ready',
        errorMessage: previous.phase === 'temporary_failure' ? previous.errorMessage : null,
      };
    });

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
