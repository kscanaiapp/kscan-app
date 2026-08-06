import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  loadClosetTyped,
  CLOSET_LOAD_CODES,
  deleteClosetItem,
  createClosetItem,
} from '../services/closetLibrary';
import { promoteScanToCloset } from '../services/closetPromotion';
import { getClosetItemProjections } from '../services/closetItemProjection';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { useAuthSession } from '../contexts/AuthSessionContext';

/**
 * Closet inventory state for the Library "Closet" section.
 *
 * Device-local only in this testing pass: there is no cloud list, no image
 * upload, and no background sync. Any future cloud path must be a separate,
 * explicitly authorized change.
 *
 * Actor safety mirrors useLibrary(): results are held in an actorKey-stamped
 * snapshot and a completion captured before an actor transition is discarded
 * rather than rendered under the new actor. The monotonic actor epoch is what
 * makes a same-user sign-out / sign-back-in cycle rejectable — the actorId and
 * actorKey are identical across that transition.
 *
 * WHAT THE SCREEN RECEIVES IS A PROJECTION. Records are read through
 * services/closetItemProjection.ts, which exposes the structured taxonomy and
 * drops the service-only fields — the candidate provenance, the scan lineage ids
 * and the client request id. This hook is the UI boundary, so it is where "a
 * screen cannot render provenance" stops being a convention and becomes true.
 */
export function useCloset() {
  const [snapshot, setSnapshot] = useState({ actorKey: null, items: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const { isAuthenticated, user } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';
  const requestGenerationRef = useRef(0);

  const hydrate = useCallback(() => {
    const requestGeneration = ++requestGenerationRef.current;
    let live = true;
    const actorRequest = createActorRequest();
    const isCurrent = () =>
      live &&
      requestGenerationRef.current === requestGeneration &&
      isActorRequestCurrent(actorRequest);

    setLoading(true);
    setLoadError(null);

    // The snapshot is NOT blanked here. Cross-actor safety is already provided
    // by the actorKey stamp below — a snapshot belonging to another actor reads
    // as empty without being destroyed — and blanking first is what turned a
    // failed read into a false "your Closet is empty".
    void loadClosetTyped(actorId, { actorRequest })
      .then((result) => {
        if (!isCurrent()) return;
        if (result.ok) {
          setSnapshot({ actorKey, items: getClosetItemProjections(result.items) });
        } else if (result.code !== CLOSET_LOAD_CODES.ACTOR_CHANGED) {
          // A failure describes the READ, not the inventory. Whatever this actor
          // already had on screen stays on screen, and the surface is told why
          // so it can offer recovery instead of claiming emptiness.
          setLoadError({ code: result.code, message: result.message });
        }
        setLoading(false);
      })
      .catch(() => {
        if (!isCurrent()) return;
        setLoadError({
          code: CLOSET_LOAD_CODES.READ_FAILED,
          message: "We couldn't load your Closet.",
        });
        setLoading(false);
      });

    return () => {
      live = false;
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
    };
  }, [actorId, actorKey]);

  useFocusEffect(hydrate);

  /**
   * Re-read from disk under a fresh actor request.
   *
   * A refresh REFRESHES. It never clears: a read that fails leaves the items the
   * actor already had intact and reports the failure instead, so an intake that
   * could not be re-read cannot present as an emptied Closet.
   */
  const refresh = useCallback(async () => {
    const actorRequest = createActorRequest();
    const requestGeneration = ++requestGenerationRef.current;
    let result;
    try {
      result = await loadClosetTyped(actorId, { actorRequest });
    } catch {
      result = {
        ok: false,
        items: [],
        code: CLOSET_LOAD_CODES.READ_FAILED,
        message: "We couldn't load your Closet.",
      };
    }
    // Ordering guard: a slower earlier read must not land on top of a newer one.
    if (
      !isActorRequestCurrent(actorRequest) ||
      requestGenerationRef.current !== requestGeneration
    ) {
      return result;
    }
    if (result.ok) {
      setSnapshot({ actorKey, items: getClosetItemProjections(result.items) });
      setLoadError(null);
    } else if (result.code !== CLOSET_LOAD_CODES.ACTOR_CHANGED) {
      setLoadError({ code: result.code, message: result.message });
    }
    return result;
  }, [actorId, actorKey]);

  /**
   * Direct native intake. `busy` is the double-tap guard; the store is
   * independently idempotent and actor-guarded, so a race that slips past the
   * UI guard still cannot produce a duplicate or a cross-actor write.
   */
  const addFromUri = useCallback(
    async (sourceUri, draft) => {
      if (busy) return { ok: false, reason: 'busy' };
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await createClosetItem({
          sourceUri,
          draft: { ...draft, origin: 'direct_intake' },
          actorRequest,
          ownerId: actorId,
        });
        // Guard the UI completion: a result that arrived after an actor change
        // must not be shown to the new actor.
        if (result.ok && isActorRequestCurrent(actorRequest)) {
          await refresh();
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [actorId, busy, refresh]
  );

  /** Non-destructive Recent Scan promotion. The source scan is never modified. */
  const addFromScan = useCallback(
    async (scan) => {
      if (busy) return { ok: false, reason: 'busy' };
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await promoteScanToCloset({
          scan,
          actorRequest,
          ownerId: actorId,
        });
        if (result.ok && isActorRequestCurrent(actorRequest)) {
          await refresh();
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [actorId, busy, refresh]
  );

  const remove = useCallback(
    async (id) => {
      const ok = await deleteClosetItem(id, { ownerId: actorId });
      if (ok) {
        setSnapshot((current) =>
          current.actorKey === actorKey
            ? { ...current, items: current.items.filter((item) => item.id !== id) }
            : current
        );
      }
      return ok;
    },
    [actorId, actorKey]
  );

  const items = snapshot.actorKey === actorKey ? snapshot.items : [];
  // A failure is only this actor's failure while their own snapshot is showing.
  const error = snapshot.actorKey === actorKey || snapshot.actorKey === null ? loadError : null;
  return { items, loading, busy, error, addFromUri, addFromScan, remove, refresh };
}
