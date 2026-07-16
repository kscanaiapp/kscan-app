import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';

import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  listSharedRoomsForCurrentUser,
  removeSharedRoomForCurrentUser,
  type SharedRoomMembershipSummary,
} from '../services/sharedRoomMemberships';
import {
  SHARED_WITH_ME_REMOVE_ERROR,
  applySharedWithMeListResult,
  applySuccessfulFinalSharedRoomRemoval,
  beginSharedWithMeLoad,
  clearSharedRoomRemovalSuppression,
  clearSharedWithMeForActorChange,
  createSharedRoomRemovalSuppression,
  createSharedWithMeSnapshot,
  forgetRemovedSharedRoomToken,
  isSharedWithMeSnapshotVisibleToActor,
  rememberRemovedSharedRoomToken,
  removedSharedRoomTokensForActor,
  restoreSharedRoomAfterFailedRemovalForActor,
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
  const actorId = !authLoading && isAuthenticated && user?.id ? user.id : null;

  const [snapshot, setSnapshot] = useState<SharedWithMeSnapshot>(() =>
    createSharedWithMeSnapshot(actorId),
  );
  const [refreshing, setRefreshing] = useState(false);
  const [removingToken, setRemovingToken] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const snapshotRef = useRef(snapshot);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const inFlightActorRef = useRef<string | null>(null);
  const generationRef = useRef(snapshot.generation);
  const removalSuppressionRef = useRef(createSharedRoomRemovalSuppression(actorId));
  const removingTokenRef = useRef<string | null>(null);
  const removalActorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);
  const actorIdRef = useRef(actorId);

  // These refs are request guards, so update them during render rather than
  // waiting for a passive effect where prior-actor data could still win a race.
  snapshotRef.current = snapshot;
  actorIdRef.current = actorId;

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
    removalSuppressionRef.current = createSharedRoomRemovalSuppression(actorId);
    removingTokenRef.current = null;
    removalActorRef.current = null;
    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setRemoveError(null);
    setRemovingToken(null);
    setRefreshing(false);
    setSnapshot((previous) => ({
      ...clearSharedWithMeForActorChange(previous, actorId),
      generation,
    }));
  }, [actorId]);

  const reload = useCallback(async () => {
    if (authLoading) return;
    if (!actorId) return;

    if (inFlightRef.current) {
      // Deduplicate only when the in-flight request belongs to this actor.
      if (inFlightActorRef.current === actorId) {
        await inFlightRef.current;
        return;
      }
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSnapshot((previous) => {
      const actorSnapshot = previous.actorId === actorId
        ? previous
        : clearSharedWithMeForActorChange(previous, actorId);
      return {
        ...beginSharedWithMeLoad(actorSnapshot, actorId),
        generation,
      };
    });
    setRefreshing(true);

    const requestActorId = actorId;
    const request = (async () => {
      let result;
      try {
        result = await listSharedRoomsForCurrentUser();
      } catch {
        result = { ok: false, reason: 'temporary_failure' } as const;
      }
      if (!mountedRef.current) return;
      if (actorIdRef.current !== requestActorId) return;

      // Capture suppression before scheduling the updater. The request cleanup
      // may clear the lifecycle-bound tombstones before React runs this update.
      const removedTokensAtCompletion = new Set(
        removedSharedRoomTokensForActor(
          removalSuppressionRef.current,
          requestActorId,
        ),
      );
      setSnapshot((previous) => {
        const applied = applySharedWithMeListResult({
          previous,
          generation,
          actorId: requestActorId,
          result,
          removedTokens: removedTokensAtCompletion,
        });
        return applied ?? previous;
      });
    })().finally(() => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        inFlightActorRef.current = null;
        if (removalActorRef.current !== requestActorId) {
          removalSuppressionRef.current = clearSharedRoomRemovalSuppression(
            removalSuppressionRef.current,
            requestActorId,
          );
        }
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
    const requestActorId = actorIdRef.current;
    if (!requestActorId || removingTokenRef.current) return false;

    const token = room.shareToken;
    const actorSnapshot = snapshotRef.current;
    if (
      actorSnapshot.actorId !== requestActorId ||
      !actorSnapshot.rooms.some((entry) => entry.shareToken === token)
    ) {
      return false;
    }

    removingTokenRef.current = token;
    removalActorRef.current = requestActorId;
    setRemovingToken(token);
    setRemoveError(null);

    setSnapshot((previous) => previous.actorId === requestActorId
      ? applySuccessfulFinalSharedRoomRemoval(previous, token)
      : previous);

    removalSuppressionRef.current = rememberRemovedSharedRoomToken(
      removalSuppressionRef.current,
      requestActorId,
      token,
    );

    try {
      const result = await removeSharedRoomForCurrentUser(token);
      if (!mountedRef.current) return false;
      if (
        actorIdRef.current !== requestActorId ||
        removalActorRef.current !== requestActorId ||
        removingTokenRef.current !== token
      ) {
        return false;
      }

      if (result.status === 'removed') {
        removingTokenRef.current = null;
        removalActorRef.current = null;
        setRemovingToken(null);
        if (!inFlightRef.current || inFlightActorRef.current !== requestActorId) {
          removalSuppressionRef.current = clearSharedRoomRemovalSuppression(
            removalSuppressionRef.current,
            requestActorId,
          );
        }
        return true;
      }

      removalSuppressionRef.current = forgetRemovedSharedRoomToken(
        removalSuppressionRef.current,
        requestActorId,
        token,
      );
      setSnapshot((previous) => {
        return restoreSharedRoomAfterFailedRemovalForActor({
          previous,
          operationActorId: requestActorId,
          room,
        }) ?? previous;
      });
      setRemoveError(
        result.status === 'unauthenticated'
          ? 'Sign in to update your Shared with Me list.'
          : SHARED_WITH_ME_REMOVE_ERROR,
      );
      removingTokenRef.current = null;
      removalActorRef.current = null;
      setRemovingToken(null);
      if (!inFlightRef.current) {
        removalSuppressionRef.current = clearSharedRoomRemovalSuppression(
          removalSuppressionRef.current,
          requestActorId,
        );
      }
      return false;
    } catch {
      if (!mountedRef.current) return false;
      if (
        actorIdRef.current !== requestActorId ||
        removalActorRef.current !== requestActorId ||
        removingTokenRef.current !== token
      ) {
        return false;
      }
      removalSuppressionRef.current = forgetRemovedSharedRoomToken(
        removalSuppressionRef.current,
        requestActorId,
        token,
      );
      setSnapshot((previous) => {
        return restoreSharedRoomAfterFailedRemovalForActor({
          previous,
          operationActorId: requestActorId,
          room,
        }) ?? previous;
      });
      setRemoveError(SHARED_WITH_ME_REMOVE_ERROR);
      removingTokenRef.current = null;
      removalActorRef.current = null;
      setRemovingToken(null);
      if (!inFlightRef.current) {
        removalSuppressionRef.current = clearSharedRoomRemovalSuppression(
          removalSuppressionRef.current,
          requestActorId,
        );
      }
      return false;
    }
  }, []);

  const clearRemoveError = useCallback(() => {
    setRemoveError(null);
  }, []);

  const snapshotVisible = isSharedWithMeSnapshotVisibleToActor({
    snapshot,
    actorId,
    authLoading,
  });
  const visibleSnapshot: SharedWithMeSnapshot = snapshotVisible
    ? snapshot
    : {
        phase: actorId ? 'loading' : 'unauthenticated',
        rooms: [],
        actorId,
        generation: generationRef.current,
        errorMessage: null,
      };

  const loading =
    Boolean(actorId) &&
    visibleSnapshot.phase === 'loading' &&
    visibleSnapshot.rooms.length === 0;

  return {
    snapshot: visibleSnapshot,
    rooms: visibleSnapshot.rooms,
    loading,
    refreshing: snapshotVisible ? refreshing : false,
    temporaryFailure: visibleSnapshot.phase === 'temporary_failure',
    empty: visibleSnapshot.phase === 'empty',
    unauthenticated: authLoading || !actorId || visibleSnapshot.phase === 'unauthenticated',
    removingToken: snapshotVisible ? removingToken : null,
    removeError: snapshotVisible ? removeError : null,
    reload,
    removeFromList,
    clearRemoveError,
  };
}
