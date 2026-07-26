import { useState, useCallback, useEffect, useMemo } from 'react';
import { useFocusEffect } from 'expo-router';
import { loadLibrary, deleteScan as removeScan } from '../services/library';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { createActorRequest, isActorRequestCurrent, getActorContext } from '../services/actorContext';
import {
  listCloudSavedScans,
  mergeLocalAndCloudScans,
  CLOUD_SAVED_SCANS_ENABLED,
} from '../services/savedScansCloud';

/**
 * Manages local + cloud scan library state for the Style Library screen.
 * Reloads automatically whenever the screen regains focus so newly-saved
 * scans appear without manual refresh.
 *
 * ACCOUNT ISOLATION
 * State is held as an actor-keyed snapshot rather than a bare array. The old
 * implementation keyed its effect on `isAuthenticated`, which stays `true`
 * across an A -> B switch, so User A's scans stayed rendered for User B. The
 * snapshot is discarded the moment the actor key changes, and every
 * asynchronous result is validated against the captured actor epoch before it
 * is allowed to touch state.
 *
 * Cloud sync behavior:
 * - Local scans are always loaded first and shown immediately.
 * - If authenticated and CLOUD_SAVED_SCANS_ENABLED is true, cloud scans are
 *   loaded in the background and merged with local scans.
 * - Cloud failure is silent; local scans remain visible.
 * - Signed-out users stay local-only and see the ownerless partition.
 */
export function useLibrary() {
  const { isAuthenticated, user } = useAuthSession();

  // null actor === signed-out device-local (ownerless) projection.
  const actorId = isAuthenticated ? (user?.id ?? null) : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';

  const [snapshot, setSnapshot] = useState({ actorKey: null, scans: [] });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);

  // Clear the visible projection synchronously on actor transition so the
  // previous actor's scans cannot be rendered for even one frame while the new
  // snapshot loads.
  useEffect(() => {
    setSnapshot((prev) => (prev.actorKey === actorKey ? prev : { actorKey: null, scans: [] }));
    setLoading(true);
    setSyncError(null);
    setSyncing(false);
  }, [actorKey]);

  useFocusEffect(
    useCallback(() => {
      let live = true;
      const request = createActorRequest();
      const requestActorKey = actorKey;

      const stillValid = () => live && isActorRequestCurrent(request) && requestActorKey === actorKey;

      setLoading(true);
      setSyncing(false);
      setSyncError(null);

      void loadLibrary(actorId).then(async (localData) => {
        if (!stillValid()) return;

        // Show this actor's local scans immediately.
        setSnapshot({ actorKey: requestActorKey, scans: localData });
        setLoading(false);

        // Background cloud load if enabled and authenticated. The signed-out
        // ownerless partition is never uploaded or hydrated from the cloud.
        if (CLOUD_SAVED_SCANS_ENABLED && actorId) {
          setSyncing(true);
          try {
            const cloudResult = await listCloudSavedScans();
            if (stillValid()) {
              if (cloudResult.ok && Array.isArray(cloudResult.data)) {
                // Re-read under the same actor so a concurrent local save is
                // not lost, then merge.
                const latestLocal = await loadLibrary(actorId);
                if (stillValid()) {
                  setSnapshot({
                    actorKey: requestActorKey,
                    scans: mergeLocalAndCloudScans(latestLocal, cloudResult.data),
                  });
                }
              } else if (!cloudResult.ok) {
                setSyncError(cloudResult.error || 'Saved on this device. Cloud sync will retry later.');
              }
            }
          } catch {
            if (stillValid()) {
              setSyncError('Saved on this device. Cloud sync will retry later.');
            }
          } finally {
            // Guarded: a stale `finally` must not clear the new actor's syncing
            // state or otherwise write through after an actor transition.
            if (stillValid()) setSyncing(false);
          }
        }
      });

      return () => { live = false; };
    }, [actorId, actorKey])
  );

  const remove = useCallback(async (id) => {
    const request = createActorRequest();
    const ok = await removeScan(id, { actorRequest: request });
    if (ok && isActorRequestCurrent(request)) {
      setSnapshot((prev) =>
        prev.actorKey === actorKey
          ? { ...prev, scans: prev.scans.filter((s) => s.id !== id) }
          : prev,
      );
    }
    return ok;
  }, [actorKey]);

  // Only ever expose scans that belong to the currently rendered actor.
  const scans = useMemo(
    () => (snapshot.actorKey === actorKey ? snapshot.scans : []),
    [snapshot, actorKey],
  );

  return { scans, loading, remove, syncing, syncError, actorId, actorKey, actorEpoch: getActorContext().epoch };
}
