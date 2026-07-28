import { useState, useCallback, useRef, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  listClosetCandidates,
  createClosetCandidate,
  createClosetCandidateBatch,
  manuallyClassifyClosetCandidate,
  retryClosetCandidate,
  rejectClosetCandidate,
  deleteClosetCandidate,
  cleanupExpiredClosetCandidates,
  recoverInterruptedClosetCandidates,
  sweepOrphanedClosetCandidateMedia,
} from '../services/closetCandidateLibrary';
import { createClosetBatchId } from '../services/closetCandidateSchema';
import {
  requeueClosetCandidatesOnReconnect,
  cancelAllClosetClassifications,
} from '../services/closetCandidateClassification';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  CLOSET_CANDIDATE_STAGING_ACTIVE,
  CLOSET_BATCH_REVIEW_V2_ACTIVE,
} from '../constants/featureFlags';

/**
 * Closet CANDIDATE staging state for the minimal Build 1 status surface.
 *
 * Actor safety mirrors useCloset() and useLibrary(): results are held in an
 * actorKey-stamped snapshot, and a completion captured before an actor transition
 * is DISCARDED rather than rendered under the new actor. The monotonic actor epoch
 * is what makes a same-user sign-out / sign-back-in cycle rejectable — the actorId
 * and actorKey are identical across that transition.
 *
 * FLAG SCOPE: `CLOSET_CANDIDATE_STAGING_ACTIVE` gates WRITE ENTRY POINTS and the
 * classification queue only. Reading, cleanup and recovery run regardless, because
 * candidate records on disk must remain readable and disposable after the flag is
 * turned off — exactly the rule the committed Closet already follows.
 */
export function useClosetCandidates() {
  const [snapshot, setSnapshot] = useState({ actorKey: null, candidates: [] });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const { isAuthenticated, user } = useAuthSession();
  const actorId = isAuthenticated ? user?.id ?? null : null;
  const actorKey = actorId ? `user:${actorId}` : 'device-local';
  const requestGenerationRef = useRef(0);

  /** Re-read from disk under a fresh actor request. */
  const refresh = useCallback(async () => {
    const actorRequest = createActorRequest();
    const result = await listClosetCandidates(actorRequest);
    if (!isActorRequestCurrent(actorRequest)) return;
    setSnapshot({ actorKey, candidates: result.ok ? result.candidates : [] });
  }, [actorKey]);

  /**
   * Controlled startup / focus sequence, in this order for a reason:
   *   1. expire   — a lapsed candidate must never be recovered or requeued
   *   2. recover  — interrupted `classifying` records, bounded by interruptionCount
   *   3. list     — what the user sees
   *   4. run      — at most two classifications, flag permitting, AFTER the
   *                 connectivity port is given a chance to become optimistic again
   *
   * STEP 4 USES THE RECONNECT ENTRY POINT, NOT THE BARE QUEUE. The default
   * connectivity provider is reactive: a transport failure latches it offline, and
   * the only paths back to optimism are a completed request (which the offline
   * preflight now prevents from ever being attempted) or an explicit refresh.
   * Calling `runClosetCandidateQueue` directly here left that latch permanent for
   * the rest of the session — every focus and every manual retry re-parked the
   * candidate without ever touching the network. Screen focus IS the foreground
   * signal this build has, so it is where the refresh belongs.
   */
  const hydrate = useCallback(() => {
    const requestGeneration = ++requestGenerationRef.current;
    let live = true;
    const actorRequest = createActorRequest();
    const isCurrent = () =>
      live &&
      requestGenerationRef.current === requestGeneration &&
      isActorRequestCurrent(actorRequest);

    setLoading(true);
    setSnapshot({ actorKey, candidates: [] });

    void (async () => {
      try {
        await cleanupExpiredClosetCandidates(actorRequest);
        await recoverInterruptedClosetCandidates(actorRequest);
        const result = await listClosetCandidates(actorRequest);
        if (!isCurrent()) return;
        setSnapshot({ actorKey, candidates: result.ok ? result.candidates : [] });
        setLoading(false);
        // Collect media whose record is already gone. Runs AFTER the list so it
        // never delays what the user sees, and is flag-independent for the same
        // reason cleanup is: files on disk must remain collectable after the
        // flag is turned off. It refuses to run on a partial manifest read.
        await sweepOrphanedClosetCandidateMedia(actorRequest);
        if (!isCurrent()) return;
        if (CLOSET_CANDIDATE_STAGING_ACTIVE) {
          // Bounded: one pass, concurrency two, actor epoch and expiry revalidated
          // per candidate by the runner itself.
          await requeueClosetCandidatesOnReconnect(actorRequest);
          if (!isCurrent()) return;
          await refresh();
        }
      } catch {
        if (!isCurrent()) return;
        setSnapshot({ actorKey, candidates: [] });
        setLoading(false);
      }
    })();

    return () => {
      live = false;
      if (requestGenerationRef.current === requestGeneration) {
        requestGenerationRef.current += 1;
      }
    };
  }, [actorKey, refresh]);

  useFocusEffect(hydrate);

  /**
   * Abort every in-flight classification when the owning hook unmounts or the
   * actor changes. Epoch validation would already reject the late write; this
   * stops us paying for it.
   */
  useEffect(() => {
    return () => {
      cancelAllClosetClassifications();
    };
  }, [actorKey]);

  /**
   * Stage one photo. `busy` is the double-tap guard; the store is independently
   * idempotent, capped and actor-guarded, so a race that slips past the UI guard
   * still cannot produce a duplicate or a cross-actor write.
   *
   * The batch id is minted HERE, at the intake boundary, and passed down — a
   * single-photo intake still gets one so Build 2's batch review never has to
   * special-case records that predate it.
   */
  const addFromUri = useCallback(
    async (sourceUri, intake = {}) => {
      if (!CLOSET_CANDIDATE_STAGING_ACTIVE) {
        return { kind: 'rejected', code: 'candidate_invalid_transition' };
      }
      if (busy) return { kind: 'rejected', code: 'candidate_invalid_transition' };
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await createClosetCandidate(actorRequest, {
          sourceUri,
          sourceType: intake.sourceType === 'camera' ? 'camera' : 'gallery',
          batchId: intake.batchId || createClosetBatchId(),
          sourceLineageId: intake.sourceLineageId,
          sourceId: intake.sourceId,
          draft: intake.draft,
          ownerId: actorId,
        });
        if (!isActorRequestCurrent(actorRequest)) return result;
        await refresh();
        if (result.kind === 'created') {
          // Staging a photo is a deliberate foreground action, so it clears a
          // latched offline belief too. Otherwise a single earlier network blip
          // would park every subsequent intake without ever trying the network.
          await requeueClosetCandidatesOnReconnect(actorRequest);
          if (isActorRequestCurrent(actorRequest)) await refresh();
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [actorId, busy, refresh],
  );

  /**
   * Build 2's bounded gallery entry point. This remains unavailable unless the
   * additional V2 capability is active, preserving Build 1's single intake when
   * V2 is off. Each newly durable candidate becomes eligible for the existing
   * reconnect-aware queue; the picker never waits for network work.
   */
  const addFromAssets = useCallback(
    async (assets, intake = {}) => {
      if (!CLOSET_BATCH_REVIEW_V2_ACTIVE) {
        return { kind: 'rejected', code: 'candidate_invalid_transition' };
      }
      if (busy) return { kind: 'rejected', code: 'candidate_invalid_transition' };
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await createClosetCandidateBatch(actorRequest, {
          assets,
          sourceType: intake.sourceType === 'camera' ? 'camera' : 'gallery',
          batchId: intake.batchId || createClosetBatchId(),
          sourceLineageId: intake.sourceLineageId,
          sourceId: intake.sourceId,
          draft: intake.draft,
          ownerId: actorId,
          onCandidateCreated: () => {
            // The batch coordinator calls this only after that candidate's
            // manifest write completed. Do not await classification: durable
            // local acknowledgement and modal closure must not depend on it.
            void requeueClosetCandidatesOnReconnect(actorRequest)
              .then(() => {
                if (isActorRequestCurrent(actorRequest)) void refresh();
              })
              .catch(() => null);
          },
        });
        if (!isActorRequestCurrent(actorRequest)) return result;
        await refresh();
        return result;
      } finally {
        setBusy(false);
      }
    },
    [actorId, busy, refresh],
  );

  const retry = useCallback(
    async (candidateId) => {
      const actorRequest = createActorRequest();
      const result = await retryClosetCandidate(actorRequest, candidateId);
      if (!isActorRequestCurrent(actorRequest)) return result;
      await refresh();
      if (result.ok && CLOSET_CANDIDATE_STAGING_ACTIVE) {
        // The user tapping retry is a first-class "I believe I am online again"
        // signal, so it clears the latched offline belief before the queue runs.
        // Without this the retry transitions the record to `queued` and the
        // offline preflight immediately re-parks it, forever.
        await requeueClosetCandidatesOnReconnect(actorRequest);
        if (isActorRequestCurrent(actorRequest)) await refresh();
      }
      return result;
    },
    [refresh],
  );

  const reject = useCallback(
    async (candidateId) => {
      // Abort first: a rejected candidate's in-flight request is wasted work.
      cancelAllClosetClassifications();
      const actorRequest = createActorRequest();
      const result = await rejectClosetCandidate(actorRequest, candidateId);
      if (isActorRequestCurrent(actorRequest)) await refresh();
      return result;
    },
    [refresh],
  );

  const remove = useCallback(
    async (candidateId) => {
      cancelAllClosetClassifications();
      const actorRequest = createActorRequest();
      const result = await deleteClosetCandidate(actorRequest, candidateId);
      if (isActorRequestCurrent(actorRequest)) await refresh();
      return result;
    },
    [refresh],
  );

  /**
   * Manual classification: the user supplies the taxonomy the backend could not,
   * and the candidate advances to review.
   *
   * Two steps rather than one because they are two different authorities — the
   * metadata patch is user-authored content, and the transition is a state-machine
   * decision. The transition is attempted only after the patch actually persisted.
   */
  const classifyManually = useCallback(
    async (candidateId, fields) => {
      const actorRequest = createActorRequest();
      // Validation, the protected-field gate, and the authoritative
      // needs_manual_classification → ready_for_review transition all live in
      // the service. The hook only refreshes what the user sees.
      const advanced = await manuallyClassifyClosetCandidate(actorRequest, candidateId, fields);
      if (isActorRequestCurrent(actorRequest)) await refresh();
      return advanced;
    },
    [refresh],
  );

  const candidates = snapshot.actorKey === actorKey ? snapshot.candidates : [];
  return {
    candidates,
    loading,
    busy,
    stagingActive: CLOSET_CANDIDATE_STAGING_ACTIVE,
    batchIntakeActive: CLOSET_BATCH_REVIEW_V2_ACTIVE,
    addFromUri,
    addFromAssets,
    retry,
    reject,
    remove,
    classifyManually,
    refresh,
  };
}
