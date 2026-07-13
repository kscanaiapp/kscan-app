import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  getStyleDnaPreferencesSnapshot,
  hydrateStyleDnaPreferences,
  setStyleDnaPreferences,
  subscribeStyleDnaPreferences,
  type LocalStyleDnaPreferences,
} from '../services/style-dna/localStyleDnaPreferences';

export interface UseStyleDnaPreferencesParams {
  userKey: string | null | undefined;
}

export interface UseStyleDnaPreferencesReturn {
  preferences: LocalStyleDnaPreferences;
  loading: boolean;
  updatePreferences: (update: Partial<LocalStyleDnaPreferences>) => Promise<void>;
}

export function useStyleDnaPreferences({
  userKey,
}: UseStyleDnaPreferencesParams): UseStyleDnaPreferencesReturn {
  const actorKey = userKey || null;
  const [loadingState, setLoadingState] = useState<{ actorKey: string | null; loading: boolean }>({
    actorKey,
    loading: Boolean(actorKey),
  });
  const hydrationVersionRef = useRef(0);

  const subscribe = useCallback(
    (listener: () => void) => subscribeStyleDnaPreferences(actorKey, listener),
    [actorKey],
  );
  const getSnapshot = useCallback(
    () => getStyleDnaPreferencesSnapshot(actorKey),
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
    void hydrateStyleDnaPreferences(actorKey).finally(() => {
      if (hydrationVersionRef.current === version) {
        setLoadingState({ actorKey, loading: false });
      }
    });
  }, [actorKey]);

  const updatePreferences = useCallback(
    async (update: Partial<LocalStyleDnaPreferences>) => {
      if (!actorKey) return;
      await setStyleDnaPreferences(actorKey, update);
    },
    [actorKey],
  );

  const loading = actorKey
    ? loadingState.actorKey !== actorKey || loadingState.loading
    : false;
  return { preferences, loading, updatePreferences };
}
