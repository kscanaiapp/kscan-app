import { useState, useCallback, useRef, useEffect } from 'react';
import { useFocusEffect } from 'expo-router';
import {
  listClosetCandidates,
  createClosetCandidate,
  updateClosetCandidate,
  transitionClosetCandidate,
  retryClosetCandidate,
  rejectClosetCandidate,
  deleteClosetCandidate,
  cleanupExpiredClosetCandidates,
  recoverInterruptedClosetCandidates,
} from '../services/closetCandidateLibrary';
import { createClosetBatchId } from '../services/closetCandidateSchema';
import {
  runClosetCandidateQueue,
  cancelAllClosetClassifications,
} from '../services/closetCandidateClassification';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { CLOSET_CANDIDATE_STAGING_ACTIVE } from '../constants/featureFlags';

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
   *   4. run      — at most two classifications, flag permitting
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
        if (CLOSET_CANDIDATE_STAGING_ACTIVE) {
          await runClosetCandidateQueue(actorRequest);
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
          await runClosetCandidateQueue(actorRequest);
          if (isActorRequestCurrent(actorRequest)) await refresh();
        }
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
        await runClosetCandidateQueue(actorRequest);
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
      const patched = await updateClosetCandidate(actorRequest, candidateId, fields);
      if (!patched.ok) return patched;
      const advanced = await transitionClosetCandidate(actorRequest, candidateId, {
        to: 'ready_for_review',
        errorCode: null,
      });
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
    addFromUri,
    retry,
    reject,
    remove,
    classifyManually,
    refresh,
  };
}
