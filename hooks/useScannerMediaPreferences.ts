import { useCallback, useEffect, useRef, useState } from 'react';
import {
  readScannerMediaPreference,
  writeScannerMediaPreference,
  SCANNER_MEDIA_DEFAULTS,
  type ScannerMediaPreference,
} from '../services/scannerMediaPreferences';

type ScannerChoices = Record<ScannerMediaPreference, boolean>;

/**
 * Persistent device-local Scanner camera/photo choices.
 * OS permissions remain owned by the point-of-use scanner/photo picker.
 * No permission request, token acquisition or backend write occurs here.
 */
export function useScannerMediaPreferences() {
  const [preferences, setPreferences] = useState<ScannerChoices>({ ...SCANNER_MEDIA_DEFAULTS });
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const revisionRef = useRef(0); // A stale read can never overwrite an explicit switch write.

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    const observedRevision = revisionRef.current;
    try {
      const [camera, photos] = await Promise.all([
        readScannerMediaPreference('camera'),
        readScannerMediaPreference('photos'),
      ]);
      if (!mounted.current || observedRevision !== revisionRef.current) return;
      setPreferences({ camera, photos });
      setReady(true);
      setError(null);
    } catch {
      if (!mounted.current || observedRevision !== revisionRef.current) return;
      // Storage cannot be trusted: keep camera and photo picker gated off.
      setReady(false);
      setError('Could not load your Scanner choices. Retry before using camera or photos.');
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  const setPreference = useCallback(async (key: ScannerMediaPreference, value: boolean) => {
    if (!ready || busyRef.current) return false;
    busyRef.current = true;
    revisionRef.current += 1;
    if (mounted.current) {
      setBusy(true);
      setError(null);
    }
    try {
      await writeScannerMediaPreference(key, value);
      if (mounted.current) setPreferences((prev) => ({ ...prev, [key]: value }));
      return true;
    } catch {
      if (mounted.current) {
        setError('Could not save your Scanner choice. Please try again.');
      }
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setBusy(false);
    }
  }, [ready]);

  return { preferences, ready, busy, error, refresh, setPreference };
}
