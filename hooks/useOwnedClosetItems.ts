// Owned-closet items for selection UIs (manual builder, anchor pickers).
//
// Combines cloud saved_scans + inspiration_items with device-local scans from
// the existing library manifest, normalized to the unified OwnedClosetItem
// contract. Local-only scans are selectable but flagged not remote-backed;
// remote backing happens through the existing cloud-sync path at save time.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLibrary } from './useLibrary';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { listOwnedClosetItems } from '../services/ownedClosetItems';
import type { OwnedClosetItem } from '../types/ownedClosetItem';
import type { SavedScanModel } from '../services/savedScansCloud';
import { captureActorScope, currentActorScopeKey, isActorScopeCurrent } from '../services/actorScope';

export function useOwnedClosetItems() {
  const { scans, loading: libraryLoading } = useLibrary();
  const { isAuthenticated } = useAuthSession();
  const actorScopeKey = currentActorScopeKey();
  const [snapshot, setSnapshot] = useState<{ scopeKey: string; items: OwnedClosetItem[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, []);

  useEffect(() => { setError(null); setLoading(true); }, [actorScopeKey]);

  const reload = useCallback(async () => {
    if (!mountedRef.current || actorScopeKey !== currentActorScopeKey()) return;
    const scope = captureActorScope();
    const generation = ++generationRef.current;
    const isCurrent = () => mountedRef.current && generation === generationRef.current && isActorScopeCurrent(scope);
    const scopeKey = `${scope.actorId ?? 'anonymous'}#${scope.epoch}`;
    setLoading(true);
    setError(null);
    try {
      const localScans = (scans ?? []) as unknown as SavedScanModel[];
      if (!isAuthenticated) {
        // Signed-out: local view only (nothing persistable server-side).
        const { normalizeLocalSavedScan } = await import('../services/ownedClosetItems');
        if (isCurrent()) setSnapshot({ scopeKey, items: localScans.map(normalizeLocalSavedScan) });
        return;
      }
      const items = await listOwnedClosetItems({ localScans });
      if (isCurrent()) setSnapshot({ scopeKey, items });
    } catch (err: any) {
      if (isCurrent()) setError('Unable to load your closet. Please try again.');
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [scans, isAuthenticated, actorScopeKey]);

  useEffect(() => {
    if (!libraryLoading) void reload();
  }, [libraryLoading, reload]);

  const items = snapshot?.scopeKey === actorScopeKey ? snapshot.items : [];
  return { items, loading: loading || libraryLoading, error, reload, localScans: scans };
}
