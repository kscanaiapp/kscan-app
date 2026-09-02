import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { DressingRoom, Look } from '../types/styleObjects';
import { listDressingRooms, listLooks } from '../services/styleObjects';
import { captureActorScope, isActorScopeCurrent } from '../services/actorScope';

export function useDressingRooms() {
  const [rooms, setRooms] = useState<DressingRoom[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // A Dressing Room list is actor-bound state, so every mutation below is
  // gated on the actor generation captured before the request. `isAuthenticated`
  // stays true across an A -> B switch and a captured user id repeats across
  // A -> B -> A, so neither can reject a late list; only the monotonic epoch in
  // services/actorScope can. Without this, a list request started as A that
  // resolves after B signs in repopulated the grid with A's rooms.
  const reload = useCallback(async () => {
    const scope = captureActorScope();
    setLoading(true);
    setError(null);
    try {
      const nextRooms = await listDressingRooms();
      if (!isActorScopeCurrent(scope)) return;
      setRooms(nextRooms);
    } catch (err: any) {
      if (!isActorScopeCurrent(scope)) return;
      setError(err?.message || 'Unable to load Dressing Rooms.');
    } finally {
      // The loading flag is actor-bound too: a stale request must not clear a
      // spinner the CURRENT actor's in-flight request is still responsible for.
      if (isActorScopeCurrent(scope)) setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { rooms, loading, error, reload, setRooms };
}

export function useLooks() {
  const [looks, setLooks] = useState<Look[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setLooks(await listLooks());
    } catch (err: any) {
      setError(err?.message || 'Unable to load Looks.');
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  return { looks, loading, error, reload, setLooks };
}
