import { useState, useCallback, useRef, useEffect } from 'react';
import { AppState } from 'react-native';
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
import {
  createActorRequest,
  getActorContext,
  isActorRequestCurrent,
} from '../services/actorContext';
import { resolveClosetBatchFocus } from '../services/closetBatchReview';
import { promoteSelectedClosetCandidates } from '../services/closetCandidatePromotion';
import { runClosetStartupRecovery } from '../services/closetRecovery';
import { stageMirrorSelfieGarmentCrops } from '../services/closetMirrorStaging';
import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  CLOSET_CANDIDATE_STAGING_ACTIVE,
  CLOSET_BATCH_REVIEW_V2_ACTIVE,
  MIRROR_SELFIE_V1_ACTIVE,
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
  /**
   * The monotonic actor epoch, read at render.
   *
   * AuthSessionContext advances the epoch synchronously BEFORE it publishes the
   * new session, and publishing the session is what re-renders every consumer of
   * useAuthSession — this hook included. So by the time this line runs again the
   * epoch is already the new one, which is what lets a same-user sign-out /
   * sign-back-in cycle be distinguished at all: actorId and actorKey are
   * identical across it and only the epoch moves.
   */
  const { epoch: actorEpoch } = getActorContext();
  const requestGenerationRef = useRef(0);
  /**
   * Which batch the review surface is looking at. NAVIGATION STATE, not candidate
   * persistence: it is never written to disk, and losing it costs nothing because
   * the projection falls back deterministically to the newest group.
   */
  const [activeBatchId, setActiveBatchId] = useState(null);

  /**
   * The RUNNING promotion operation, as the surface sees it.
   *
   * Purely observational and never persisted: the durable answer to "was this
   * promoted" is the candidate record's own status, which the projection reads.
   * This exists so the screen can show which card is being worked on, how far the
   * operation has got, and that a second submission is not available.
   *
   * Stamped with the actor key and epoch it was started under, exactly like the
   * candidate snapshot, so a late settle after an actor change is discarded rather
   * than rendered under whoever is signed in when it lands.
   */
  const [promotion, setPromotion] = useState(null);
  /**
   * Cooperative cancellation for the running operation.
   *
   * A ref rather than state because the coordinator polls it synchronously at its
   * safe checkpoints, between candidates — a state read would be a frame behind
   * and would let one more candidate start after the app had already backgrounded.
   */
  const promotionLiveRef = useRef(false);
  const promotionGenerationRef = useRef(0);

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
        // PHASE 4 CONVERGENCE. Single-flight per actor epoch, bounded, yielding,
        // and stopped at its own safe checkpoints by `isCurrent` — which covers
        // sign-out, actor change, epoch change and unmount in one predicate. It
        // runs after the list for the same reason the sweep does: nothing the
        // user is waiting for depends on it. It never starts a promotion.
        const recovered = await runClosetStartupRecovery(actorRequest, {
          shouldContinue: isCurrent,
        });
        if (!isCurrent()) return;
        // Re-read only when something actually converged, so an ordinary launch
        // with nothing to repair costs no extra manifest read.
        if (
          recovered.finalizedCount > 0 ||
          recovered.repairedCount > 0 ||
          recovered.cleanedCount > 0 ||
          recovered.retiredCount > 0
        ) {
          await refresh();
          if (!isCurrent()) return;
        }
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
   * An actor transition drops the review navigation context.
   *
   * Not a safety mechanism — the projection is actor-scoped and a foreign batch id
   * simply matches nothing — but leaving one actor's batch id pointing into another
   * actor's surface is meaningless state, and meaningless state is where a later
   * bug hides.
   */
  useEffect(() => {
    setActiveBatchId(null);
  }, [actorKey, actorEpoch]);

  /**
   * BACKGROUNDING COOPERATIVELY STOPS THE PROMOTION QUEUE.
   *
   * It clears the continue flag and nothing else. The coordinator reads it at its
   * own safe boundaries — before loading a candidate, before the storage preflight,
   * before the committed write — and never mid-write: a forced interruption during
   * an atomic manifest replacement is the one thing that could leave the store
   * genuinely damaged, and it is worth far more than the work it would save.
   *
   * Candidates that never started are NOT failures and are never persisted as any:
   * they are reported as not attempted and stay exactly as reviewable as they were.
   * Coming back to the foreground does not resume anything — the user asks again.
   */
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active') promotionLiveRef.current = false;
    });
    return () => {
      // An unmount stops the dequeue for the same reason a background does. Work
      // already inside a critical section still finishes: the service layer owns
      // it, and it revalidates the actor before every write regardless.
      promotionLiveRef.current = false;
      subscription?.remove?.();
    };
  }, []);

  /** An actor transition invalidates the queue AND the operation the UI shows. */
  useEffect(() => {
    promotionLiveRef.current = false;
    promotionGenerationRef.current += 1;
    setPromotion(null);
  }, [actorKey, actorEpoch]);

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
        // FOCUS FOLLOWS DURABILITY. `resolveClosetBatchFocus` returns a batch id
        // only when this intake actually created a record in it, so a total
        // failure and a capacity rejection with nothing accepted both leave the
        // current review context exactly where it was. Classification has not run
        // yet and is not waited for: the batch is worth showing the moment its
        // records exist.
        const focusBatchId = resolveClosetBatchFocus(result);
        if (focusBatchId) setActiveBatchId(focusBatchId);
        return result;
      } finally {
        setBusy(false);
      }
    },
    [actorId, busy, refresh],
  );

  /**
   * Stage one Mirror Selfie extraction batch (Build 2.5 Phase 0B).
   *
   * DELIBERATELY A SEPARATE METHOD, not a source-aware variant of
   * `addFromAssets`. `addFromAssets` coerces its `intake.sourceType` to
   * `camera`/`gallery` unconditionally — the correct behavior for that entry
   * point, and one this method must not disturb. Mirror crops delegate
   * entirely to services/closetMirrorStaging.ts, which is the only place that
   * sets sourceType: 'mirror_extract', enforces the dedicated Mirror flag,
   * validates the extraction session and crop identities, and derives
   * deterministic lineage. This method contributes exactly what every other
   * intake method here contributes: the captured actor request, the busy
   * guard, the snapshot refresh, and stale-completion rejection — no
   * Mirror-specific review state.
   */
  const addMirrorGarmentCrops = useCallback(
    async (extractionSessionId, crops) => {
      if (busy) return { kind: 'rejected', reason: 'mirror_staging_disabled' };
      setBusy(true);
      const actorRequest = createActorRequest();
      try {
        const result = await stageMirrorSelfieGarmentCrops({
          actorRequest,
          extractionSessionId,
          crops,
        });
        if (!isActorRequestCurrent(actorRequest)) return result;
        await refresh();
        if (result.kind === 'ok') {
          const createdAny = result.outcomes.some(
            (outcome) => outcome.outcome === 'created' && outcome.candidateId,
          );
          if (createdAny) {
            // Mirrors addFromAssets: durable acknowledgement and modal closure
            // must not wait on classification. One bounded pass covers the
            // whole batch — the queue runner's own concurrency cap and
            // in-flight tracking make a second call here redundant, not unsafe.
            void requeueClosetCandidatesOnReconnect(actorRequest)
              .then(() => {
                if (isActorRequestCurrent(actorRequest)) void refresh();
              })
              .catch(() => null);
          }
          const focusBatchId = resolveClosetBatchFocus({
            batchId: result.batchId,
            createdCandidateIds: result.outcomes
              .filter((outcome) => outcome.outcome === 'created' && outcome.candidateId)
              .map((outcome) => outcome.candidateId),
            sourceOutcomes: result.outcomes.map((outcome) => ({
              kind: outcome.outcome,
              candidateId: outcome.candidateId ?? null,
            })),
          });
          if (focusBatchId) setActiveBatchId(focusBatchId);
        }
        return result;
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh],
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

  /**
   * PROMOTE THE SUBMITTED SELECTION into the committed Closet.
   *
   * The hook contributes exactly three things and decides nothing else:
   *   - the flag gate, so the action does not exist when V2 is off
   *   - the snapshot handoff, taken once at submission
   *   - stale-settle rejection, so progress from a previous actor, a previous
   *     epoch or a superseded operation is dropped instead of rendered
   *
   * Eligibility, ordering, serialization, idempotency, the committed write and the
   * candidate tombstone all belong to the service. A second opinion formed here is
   * how a component ends up being the thing that decides what may be committed.
   */
  const promoteSelected = useCallback(
    async (candidateIds) => {
      if (!CLOSET_BATCH_REVIEW_V2_ACTIVE) {
        return { ok: false, errorCode: 'candidate_invalid_transition' };
      }
      if (promotionLiveRef.current) {
        return { ok: false, errorCode: 'candidate_invalid_transition', alreadyRunning: true };
      }

      const submitted = Array.isArray(candidateIds) ? [...candidateIds] : [];
      if (submitted.length === 0) {
        return { ok: false, errorCode: 'candidate_invalid_transition' };
      }

      const generation = ++promotionGenerationRef.current;
      const startedUnder = { actorKey, actorEpoch };
      const isCurrent = () =>
        promotionGenerationRef.current === generation &&
        startedUnder.actorKey === actorKey &&
        startedUnder.actorEpoch === actorEpoch;

      promotionLiveRef.current = true;
      const batchId = activeBatchId ?? null;
      setPromotion({
        ...startedUnder,
        batchId,
        requestedCount: submitted.length,
        completedCount: 0,
        promotedCount: 0,
        alreadyPromotedCount: 0,
        failedCount: 0,
        activeCandidateId: submitted[0] ?? null,
        pendingCandidateIds: submitted,
        results: [],
        done: false,
      });

      try {
        const result = await promoteSelectedClosetCandidates({
          actorId,
          actorEpoch,
          batchId,
          candidateIds: submitted,
          shouldContinue: () => promotionLiveRef.current === true,
          onProgress: async (event) => {
            // A stale consumer settles nothing. Checked before the state write AND
            // before the re-read, so a completed candidate from a previous actor
            // can never repaint the current one's surface.
            if (!isCurrent()) return;
            const settled = new Set(event.resultsSoFar.map((entry) => entry.candidateId));
            const remaining = submitted.filter(
              (id) => !settled.has(id) && id !== event.activeCandidateId,
            );
            setPromotion({
              ...startedUnder,
              batchId: event.batchId,
              requestedCount: event.requestedCount,
              completedCount: event.completedCount,
              promotedCount: event.promotedCount,
              alreadyPromotedCount: event.alreadyPromotedCount,
              failedCount: event.failedCount,
              activeCandidateId: event.activeCandidateId ?? null,
              pendingCandidateIds: remaining,
              results: event.resultsSoFar,
              done: event.done,
            });
            // Re-read after every per-item outcome so the promoted card appears as
            // soon as its record says so, rather than eight items later. The
            // authoritative projection, not the progress event, is what renders it.
            await refresh();
          },
        });
        if (!isCurrent()) return result;
        await refresh();
        setPromotion((current) =>
          current && current.actorKey === actorKey && current.actorEpoch === actorEpoch
            ? { ...current, activeCandidateId: null, pendingCandidateIds: [], done: true }
            : current,
        );
        return result;
      } finally {
        promotionLiveRef.current = false;
      }
    },
    [actorEpoch, actorId, actorKey, activeBatchId, refresh],
  );

  const candidates = snapshot.actorKey === actorKey ? snapshot.candidates : [];
  const activePromotion =
    promotion && promotion.actorKey === actorKey && promotion.actorEpoch === actorEpoch
      ? promotion
      : null;
  return {
    candidates,
    loading,
    busy,
    actorId,
    actorEpoch,
    activeBatchId,
    setActiveBatchId,
    stagingActive: CLOSET_CANDIDATE_STAGING_ACTIVE,
    batchIntakeActive: CLOSET_BATCH_REVIEW_V2_ACTIVE,
    mirrorStagingActive: MIRROR_SELFIE_V1_ACTIVE,
    promotion: activePromotion,
    promoting: activePromotion ? activePromotion.done !== true : false,
    addFromUri,
    addFromAssets,
    addMirrorGarmentCrops,
    retry,
    reject,
    remove,
    classifyManually,
    promoteSelected,
    refresh,
  };
}
