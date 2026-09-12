import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getSignatureStylePreferencesSnapshot,
  hydrateSignatureStylePreferences,
  setSignatureStylePreferences,
  subscribeSignatureStylePreferences,
  type LocalSignatureStylePreferences,
} from '../services/signature-style/localSignatureStylePreferences';

export interface UseSignatureStylePreferencesParams {
  userKey: string | null | undefined;
}

export interface UseSignatureStylePreferencesReturn {
  preferences: LocalSignatureStylePreferences;
  loading: boolean;
  updatePreferences: (update: Partial<LocalSignatureStylePreferences>) => Promise<void>;
}

export function useSignatureStylePreferences({
  userKey,
}: UseSignatureStylePreferencesParams): UseSignatureStylePreferencesReturn {
  const actorKey = userKey || null;
  const [loadingState, setLoadingState] = useState<{ actorKey: string | null; loading: boolean }>({
    actorKey,
    loading: Boolean(actorKey),
  });
  const hydrationVersionRef = useRef(0);

  const subscribe = useCallback(
    (listener: () => void) => subscribeSignatureStylePreferences(actorKey, listener),
    [actorKey],
  );
  const getSnapshot = useCallback(
    () => getSignatureStylePreferencesSnapshot(actorKey),
    [actorKey],
  );
  const preferences = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    const version = ++hydrationVersionRef.current;
    if (!actorKey) {
      setLoadingState({ actorKey: null, loading: false });
      return;
    }

    setLoadingState({ actorKey, loading: true });
    void hydrateSignatureStylePreferences(actorKey).finally(() => {
      if (hydrationVersionRef.current === version) {
        setLoadingState({ actorKey, loading: false });
      }
    });
  }, [actorKey]);

  const updatePreferences = useCallback(
    async (update: Partial<LocalSignatureStylePreferences>) => {
      if (!actorKey) return;
      await setSignatureStylePreferences(actorKey, update);
    },
    [actorKey],
  );

  const loading = actorKey
    ? loadingState.actorKey !== actorKey || loadingState.loading
    : false;
  return { preferences, loading, updatePreferences };
}
