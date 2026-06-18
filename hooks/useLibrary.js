import { useState, useCallback } from 'react';
import { useFocusEffect } from 'expo-router';
import { loadLibrary, deleteScan as removeScan } from '../services/library';
import { useAuthSession } from '../contexts/AuthSessionContext';
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
 * Cloud sync behavior:
 * - Local scans are always loaded first and shown immediately.
 * - If authenticated and CLOUD_SAVED_SCANS_ENABLED is true, cloud scans are
 *   loaded in the background and merged with local scans.
 * - Cloud failure is silent; local scans remain visible.
 * - Unauthenticated users stay local-only.
 */
export function useLibrary() {
  const [scans, setScans] = useState([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState(null);
  const { isAuthenticated } = useAuthSession();

  useFocusEffect(
    useCallback(() => {
      let live = true;
      setLoading(true);
      setSyncing(false);
      setSyncError(null);

      loadLibrary().then(async (localData) => {
        if (!live) return;

        // Show local scans immediately.
        setScans(localData);
        setLoading(false);

        // Background cloud load if enabled and authenticated.
        if (CLOUD_SAVED_SCANS_ENABLED && isAuthenticated) {
          setSyncing(true);
          try {
            const cloudResult = await listCloudSavedScans();
            if (live) {
              if (cloudResult.ok && Array.isArray(cloudResult.data)) {
                const merged = mergeLocalAndCloudScans(localData, cloudResult.data);
                setScans(merged);
              } else if (!cloudResult.ok) {
                setSyncError(cloudResult.error || 'Saved on this device. Cloud sync will retry later.');
              }
            }
          } catch {
            if (live) {
              setSyncError('Saved on this device. Cloud sync will retry later.');
            }
          } finally {
            if (live) setSyncing(false);
          }
        }
      });

      return () => { live = false; };
    }, [isAuthenticated])
  );

  const remove = useCallback(async (id) => {
    const ok = await removeScan(id);
    if (ok) setScans((prev) => prev.filter((s) => s.id !== id));
    return ok;
  }, []);

  return { scans, loading, remove, syncing, syncError };
}
