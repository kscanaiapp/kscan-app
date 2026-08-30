import { useState, useCallback, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  loadClosetTyped,
  CLOSET_LOAD_CODES,
  deleteClosetItem,
  createClosetItem,
  updateClosetItem,
} from '../services/closetLibrary';
import { promoteScanToCloset } from '../services/closetPromotion';
import { getClosetItemProjections } from '../services/closetItemProjection';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import {
  afterClosetItemDeleted,
  beforeClosetItemDeleted,
  noteClosetItemSaved,
  revertClosetItemDeleteMark,
  resumeClosetSync,
} from '../services/closet/closetSyncCoordinator';
import { useAuthSession } from '../contexts/AuthSessionContext';

/**
 * Closet inventory state for the Library "Closet" section.
 *
 * The Closet itself is DEVICE-LOCAL AND ALWAYS AVAILABLE. Build 34 Track B
 * Phase B2B adds OUTBOUND cloud sync as a K+ enhancement layered on top: every
 * local mutation below still completes, and is still reported to the user,
 * exactly as it did before, whether or not the cloud accepts anything. There
 * is no cloud LIST and no download path — inbound restore is B2C.
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

    // Opportunistic cloud resume, in the SAME focus effect as the local read
    // rather than a second one: this is one of B2B's normal triggers (with
    // save and delete), and it is what makes pending work from a previous
    // session, an offline period, or a lapsed-then-reactivated K+ entitlement
    // pick itself back up without any background scheduler.
    //
    // Never awaited and never able to affect what this screen renders — the
    // local read below is the sole authority for that. The engine is
    // single-flight, so this firing alongside a save trigger yields one pass.
    void resumeClosetSync('closet_opened');

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
          // Local save is already committed and already reflected above. Cloud
          // sync is started AFTER, and deliberately not awaited: the user is
          // done, and a slow or failing network must not hold the UI.
          void noteClosetItemSaved(actorId, result.item?.id);
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
          void noteClosetItemSaved(actorId, result.item?.id);
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [actorId, busy, refresh]
  );

  /**
   * Edit a committed Closet item's own metadata.
   *
   * The store is the authority on WHO may write: updateClosetItem resolves the
   * actor and matches the row against it, so a request for someone else's item
   * comes back `not_found` rather than mutating anything. This hook adds only
   * the UI-side guarantees — a single in-flight write, and a re-read from disk
   * afterwards so the grid shows the persisted record rather than an optimistic
   * guess about what was saved.
   */
  const update = useCallback(
    async (id, patch) => {
      if (busy) return { ok: false, reason: 'busy' };
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await updateClosetItem(id, patch, {
          actorRequest,
          ownerId: actorId,
        });
        if (result.ok && isActorRequestCurrent(actorRequest)) {
          await refresh();
          void noteClosetItemSaved(actorId, id);
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
      // MARKED BEFORE THE LOCAL DELETE, unlike save. deleteClosetItem is a hard
      // delete: mark afterwards and a crash in between would destroy the only
      // record that a synced cloud row still needs a tombstone. See
      // services/closet/closetSyncCoordinator.ts for the full ordering rules.
      const precondition = await beforeClosetItemDeleted(actorId, id);
      if (!precondition.allowed) {
        // NOT cloud-gating the local Closet: this item is known to have a
        // synced cloud row, and the local write required to durably remember
        // "the user wants this gone" could not be completed. Proceeding
        // would hard-delete the local record while leaving the cloud row
        // live with no trace anywhere that deletion was ever requested.
        // Surfaced as an ordinary failed removal — retrying is the correct
        // recovery, same as any other local write hiccup.
        return false;
      }
      const ok = await deleteClosetItem(id, { ownerId: actorId });
      if (ok) {
        setSnapshot((current) =>
          current.actorKey === actorKey
            ? { ...current, items: current.items.filter((item) => item.id !== id) }
            : current
        );
        void afterClosetItemDeleted();
      } else {
        // The local delete did not happen, so the cloud row must not be
        // tombstoned either.
        await revertClosetItemDeleteMark(actorId, id, precondition.previous);
      }
      return ok;
    },
    [actorId, actorKey]
  );

  const items = snapshot.actorKey === actorKey ? snapshot.items : [];
  // A failure is only this actor's failure while their own snapshot is showing.
  const error = snapshot.actorKey === actorKey || snapshot.actorKey === null ? loadError : null;
  return { items, loading, busy, error, addFromUri, addFromScan, update, remove, refresh };
}
