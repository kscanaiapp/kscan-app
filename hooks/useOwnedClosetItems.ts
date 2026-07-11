// Owned-closet items for selection UIs (manual builder, anchor pickers).
//
// Combines cloud saved_scans + inspiration_items with device-local scans from
// the existing library manifest, normalized to the unified OwnedClosetItem
// contract. Local-only scans are selectable but flagged not remote-backed;
// remote backing happens through the existing cloud-sync path at save time.

import { useCallback, useEffect, useState } from 'react';
import { useLibrary } from './useLibrary';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { listOwnedClosetItems } from '../services/ownedClosetItems';
import type { OwnedClosetItem } from '../types/ownedClosetItem';
import type { SavedScanModel } from '../services/savedScansCloud';

export function useOwnedClosetItems() {
  const { scans, loading: libraryLoading } = useLibrary();
  const { isAuthenticated } = useAuthSession();
  const [items, setItems] = useState<OwnedClosetItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const localScans = (scans ?? []) as unknown as SavedScanModel[];
      if (!isAuthenticated) {
        // Signed-out: local view only (nothing persistable server-side).
        const { normalizeLocalSavedScan } = await import('../services/ownedClosetItems');
        setItems(localScans.map(normalizeLocalSavedScan));
        return;
      }
      setItems(await listOwnedClosetItems({ localScans }));
    } catch (err: any) {
      setError(err?.message || 'Unable to load your closet.');
    } finally {
      setLoading(false);
    }
  }, [scans, isAuthenticated]);

  useEffect(() => {
    if (!libraryLoading) void reload();
  }, [libraryLoading, reload]);

  return { items, loading: loading || libraryLoading, error, reload, localScans: scans };
}
