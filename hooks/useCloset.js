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
  /**
   * KSB29-026. A failed read is NOT an empty wardrobe.
   *
   * Both read paths called `loadCloset(actorId)`, which collapses every failure
   * to `[]`. A transient read error therefore rendered as "your Closet is
   * empty" — indistinguishable from destructive data loss, on the one surface
   * whose entire job is to be the user's owned-wardrobe truth. The typed loader
   * already reported the difference; nothing consumed it.
   *
   * Non-null means the last read failed and may be retried. Items from the
   * previous successful read are retained underneath it.
   */
  const [loadError, setLoadError] = useState(null);
  const [busy, setBusy] = useState(false);
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
    // Clear ONLY on an actor boundary. Clearing unconditionally made every
    // refresh flash an empty wardrobe and left it empty if the read then failed.
    setSnapshot((current) => (current.actorKey === actorKey ? current : { actorKey, items: [] }));
    setLoadError(null);

    void loadClosetTyped(actorId, { actorRequest })
      .then((result) => {
        if (!isCurrent()) return;
        if (result.ok) {
          // A genuine empty result IS empty — that distinction is the point.
          setSnapshot({ actorKey, items: getClosetItemProjections(result.items) });
          setLoadError(null);
        } else if (result.code === CLOSET_LOAD_CODES.ACTOR_CHANGED) {
          // The one failure that MUST clear: never show one actor another's rows.
          setSnapshot({ actorKey, items: [] });
        } else {
          // Retain what we last knew and surface a retriable error instead of
          // silently reporting that the user owns nothing.
          setLoadError({ code: result.code, message: result.message, retriable: true });
        }
        setLoading(false);
      })
      .catch(() => {
        if (!isCurrent()) return;
        setLoadError({
          code: CLOSET_LOAD_CODES.READ_FAILED,
          message: "We couldn't load your Closet.",
          retriable: true,
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
   * Same rule as hydrate: a failed re-read leaves the known items in place. A
   * refresh triggered right after a successful write must never be able to
   * blank the wardrobe the write just added to.
   */
  const refresh = useCallback(async () => {
    const actorRequest = createActorRequest();
    const result = await loadClosetTyped(actorId, { actorRequest });
    if (!isActorRequestCurrent(actorRequest)) return;
    if (result.ok) {
      setSnapshot({ actorKey, items: getClosetItemProjections(result.items) });
      setLoadError(null);
      return;
    }
    if (result.code === CLOSET_LOAD_CODES.ACTOR_CHANGED) {
      setSnapshot({ actorKey, items: [] });
      return;
    }
    setLoadError({ code: result.code, message: result.message, retriable: true });
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
  return { items, loading, busy, loadError, addFromUri, addFromScan, remove, refresh };
}
