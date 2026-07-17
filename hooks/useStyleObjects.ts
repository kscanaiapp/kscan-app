import { useCallback, useEffect, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { DressingRoom, Look } from '../types/styleObjects';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { listDressingRooms, listLooks } from '../services/styleObjects';
import {
  applyOwnedRoomListResult,
  applyOwnedRoomLocalMutation,
  beginOwnedRoomListLoad,
  clearOwnedRoomListForActorChange,
  createOwnedRoomListSnapshot,
  type OwnedDressingRoomSnapshot,
  type OwnedLookSnapshot,
} from '../services/ownedRoomListLogic';

function useOwnedListActorId(): string | null {
  const { user, loading: authLoading, isAuthenticated } = useAuthSession();
  if (authLoading) return null;
  if (!isAuthenticated || !user?.id) return null;
  return user.id;
}

export function useDressingRooms() {
  const { loading: authLoading } = useAuthSession();
  const actorId = useOwnedListActorId();

  const [snapshot, setSnapshot] = useState<OwnedDressingRoomSnapshot>(() =>
    createOwnedRoomListSnapshot<DressingRoom>(actorId),
  );
  const snapshotRef = useRef(snapshot);
  const actorIdRef = useRef(actorId);
  const generationRef = useRef(snapshot.generation);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const inFlightActorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

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

    inFlightRef.current = null;
    inFlightActorRef.current = null;
    const next = clearOwnedRoomListForActorChange(snapshotRef.current, actorId);
    generationRef.current = next.generation;
    setSnapshot(next);
  }, [actorId]);

  const reload = useCallback(async () => {
    if (authLoading) return;
    if (!actorId) {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setSnapshot(createOwnedRoomListSnapshot<DressingRoom>(null, generation));
      return;
    }

    if (inFlightRef.current && inFlightActorRef.current === actorId) {
      await inFlightRef.current;
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSnapshot((previous) => {
      const actorSnapshot = previous.actorId === actorId
        ? previous
        : clearOwnedRoomListForActorChange(previous, actorId);
      return beginOwnedRoomListLoad(actorSnapshot, actorId, generation);
    });

    const requestActorId = actorId;
    const request = (async () => {
      let items: DressingRoom[] | null = null;
      let errorMessage: string | null = null;
      try {
        items = await listDressingRooms();
      } catch (err: any) {
        errorMessage = err?.message || 'Unable to load Dressing Rooms.';
      }
      if (!mountedRef.current) return;
      if (actorIdRef.current !== requestActorId) return;

      setSnapshot((previous) => {
        const applied = applyOwnedRoomListResult({
          previous,
          generation,
          actorId: requestActorId,
          items,
          errorMessage,
        });
        return applied ?? previous;
      });
    })().finally(() => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        inFlightActorRef.current = null;
      }
    });

    inFlightRef.current = request;
    inFlightActorRef.current = requestActorId;
    await request;
  }, [actorId, authLoading]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const setRooms = useCallback((next: DressingRoom[] | ((prev: DressingRoom[]) => DressingRoom[])) => {
    const requestActorId = actorIdRef.current;
    const generation = generationRef.current;
    setSnapshot((previous) => {
      const applied = applyOwnedRoomLocalMutation({
        previous,
        actorId: requestActorId,
        generation,
        mutate: (items) => (typeof next === 'function' ? next(items) : next),
      });
      return applied ?? previous;
    });
  }, []);

  const visibleRooms = snapshot.actorId === actorId ? snapshot.items : [];

  return {
    rooms: visibleRooms,
    loading: Boolean(actorId) && snapshot.loading && snapshot.actorId === actorId,
    error: snapshot.actorId === actorId ? snapshot.errorMessage : null,
    reload,
    setRooms,
  };
}

export function useLooks() {
  const { loading: authLoading } = useAuthSession();
  const actorId = useOwnedListActorId();

  const [snapshot, setSnapshot] = useState<OwnedLookSnapshot>(() =>
    createOwnedRoomListSnapshot<Look>(actorId),
  );
  const snapshotRef = useRef(snapshot);
  const actorIdRef = useRef(actorId);
  const generationRef = useRef(snapshot.generation);
  const inFlightRef = useRef<Promise<void> | null>(null);
  const inFlightActorRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

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

    inFlightRef.current = null;
    inFlightActorRef.current = null;
    const next = clearOwnedRoomListForActorChange(snapshotRef.current, actorId);
    generationRef.current = next.generation;
    setSnapshot(next);
  }, [actorId]);

  const reload = useCallback(async () => {
    if (authLoading) return;
    if (!actorId) {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      setSnapshot(createOwnedRoomListSnapshot<Look>(null, generation));
      return;
    }

    if (inFlightRef.current && inFlightActorRef.current === actorId) {
      await inFlightRef.current;
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setSnapshot((previous) => {
      const actorSnapshot = previous.actorId === actorId
        ? previous
        : clearOwnedRoomListForActorChange(previous, actorId);
      return beginOwnedRoomListLoad(actorSnapshot, actorId, generation);
    });

    const requestActorId = actorId;
    const request = (async () => {
      let items: Look[] | null = null;
      let errorMessage: string | null = null;
      try {
        items = await listLooks();
      } catch (err: any) {
        errorMessage = err?.message || 'Unable to load Looks.';
      }
      if (!mountedRef.current) return;
      if (actorIdRef.current !== requestActorId) return;

      setSnapshot((previous) => {
        const applied = applyOwnedRoomListResult({
          previous,
          generation,
          actorId: requestActorId,
          items,
          errorMessage,
        });
        return applied ?? previous;
      });
    })().finally(() => {
      if (inFlightRef.current === request) {
        inFlightRef.current = null;
        inFlightActorRef.current = null;
      }
    });

    inFlightRef.current = request;
    inFlightActorRef.current = requestActorId;
    await request;
  }, [actorId, authLoading]);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const setLooks = useCallback((next: Look[] | ((prev: Look[]) => Look[])) => {
    const requestActorId = actorIdRef.current;
    const generation = generationRef.current;
    setSnapshot((previous) => {
      const applied = applyOwnedRoomLocalMutation({
        previous,
        actorId: requestActorId,
        generation,
        mutate: (items) => (typeof next === 'function' ? next(items) : next),
      });
      return applied ?? previous;
    });
  }, []);

  const visibleLooks = snapshot.actorId === actorId ? snapshot.items : [];

  return {
    looks: visibleLooks,
    loading: Boolean(actorId) && snapshot.loading && snapshot.actorId === actorId,
    error: snapshot.actorId === actorId ? snapshot.errorMessage : null,
    reload,
    setLooks,
  };
}
