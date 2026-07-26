import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { loadLibrary, deleteScan as removeScan } from '../services/library';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  listCloudSavedScans,
  mergeLocalAndCloudScans,
  syncLocalSavedScansToCloud,
  CLOUD_SAVED_SCANS_ENABLED,
} from '../services/savedScansCloud';

/**
 * Manages local + cloud scan library state for the Style Library screen.
 * Reloads automatically whenever the screen regains focus so newly-saved
 * scans appear without manual refresh.
 *
 * Cloud sync behavior:
 * - Local scans are always loaded first and shown immediately.
 * - If authenticated and CLOUD_SAVED_SCANS_ENABLED is true, cloud scans are
 *   loaded in the background and merged with local scans.
 * - Cloud failure is silent; local scans remain visible.
 * - Unauthenticated users stay local-only.
 * - Actor/generation guards ensure User A responses never render for User B.
 */
export function useLibrary() {
  const [snapshot, setSnapshot] = useState({ actorKey: null, scans: [] });
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const { isAuthenticated, user } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';
  const requestGenerationRef = useRef(0);

  useFocusEffect(
    useCallback(() => {
      const requestGeneration = ++requestGenerationRef.current;
      let live = true;
      // The local generation counter alone cannot distinguish a same-user
      // sign-out / sign-back-in cycle: actorId and actorKey are identical
      // afterwards. The monotonic actor epoch does, so hydration completions
      // captured before the transition are rejected rather than repopulating
      // the reauthenticated session with pre-transition state.
      const actorRequest = createActorRequest();
      const isCurrent = () =>
        live &&
        requestGenerationRef.current === requestGeneration &&
        isActorRequestCurrent(actorRequest);

      setLoading(true);
      setSyncing(false);
      setSyncError(null);
      setSnapshot({ actorKey, scans: [] });

      void loadLibrary(actorId).then(async (localData) => {
        if (!isCurrent()) return;

        // Show local scans immediately.
        setSnapshot({ actorKey, scans: localData });
        setLoading(false);

        // Background cloud load if enabled and authenticated.
        if (CLOUD_SAVED_SCANS_ENABLED && actorId) {
          setSyncing(true);
          try {
            const syncResult = await syncLocalSavedScansToCloud(localData, actorId);
            if (!isCurrent()) return;
            if (syncResult.failed > 0) {
              setSyncError('Saved on this device. Cloud sync will retry later.');
            }

            const cloudResult = await listCloudSavedScans(actorId);
            if (!isCurrent()) return;
            if (
              cloudResult.ok &&
              cloudResult.actorId === actorId &&
              Array.isArray(cloudResult.data)
            ) {
              // Re-read after the network request so a newer local save cannot
              // be erased by the older local snapshot captured above.
              const latestLocalData = await loadLibrary(actorId);
              if (!isCurrent()) return;
              const cloudWithTombstones = [
                ...cloudResult.data,
                ...(Array.isArray(cloudResult.tombstones) ? cloudResult.tombstones : []),
              ];
              const merged = mergeLocalAndCloudScans(
                latestLocalData,
                cloudWithTombstones,
                actorId,
              );
              setSnapshot({ actorKey, scans: merged });
            } else if (!cloudResult.ok) {
              setSyncError(cloudResult.error || 'Saved on this device. Cloud sync will retry later.');
            }
          } catch {
            if (isCurrent()) {
              setSyncError('Saved on this device. Cloud sync will retry later.');
            }
          } finally {
            if (isCurrent()) setSyncing(false);
          }
        }
      }).catch(() => {
        if (!isCurrent()) return;
        setSnapshot({ actorKey, scans: [] });
        setLoading(false);
      });

      return () => {
        live = false;
        if (requestGenerationRef.current === requestGeneration) {
          requestGenerationRef.current += 1;
        }
      };
    }, [actorId, actorKey])
  );

  const remove = useCallback(async (id) => {
    const target = snapshot.actorKey === actorKey
      ? snapshot.scans.find((scan) => scan.id === id)
      : null;
    const ok = await removeScan(id, { ownerId: actorId, cloudId: target?.cloudId });
    if (ok) {
      setSnapshot((current) => (current.actorKey === actorKey
        ? { ...current, scans: current.scans.filter((scan) => scan.id !== id) }
        : current));
    }
    return ok;
  }, [actorId, actorKey, snapshot]);

  const scans = snapshot.actorKey === actorKey ? snapshot.scans : [];
  return { scans, loading, remove, syncing, syncError };
}
