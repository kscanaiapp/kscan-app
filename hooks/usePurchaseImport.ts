// Receipt & Purchase Intelligence V1 — the import workflow.
//
//   choose -> crop -> extracting -> review -> committing -> done
//                                         \-> error (any step)
//
// Everything in this hook is TRANSIENT and in memory. The review model, the
// source image and the extraction result never touch durable storage. The
// only durable effect of the whole workflow is the explicit confirmation's
// Closet writes (services/purchaseImport/purchaseImportCommit.ts).
//
// ACTOR ISOLATION: the actor is captured when the session starts. If the
// signed-in account changes at any point, the session is torn down: the
// request is aborted, temp files are swept, the review is dropped, and the
// screen shows `session_changed`. A late extraction result for the old actor
// is ignored because its session id no longer matches.
//
// DOUBLE SUBMISSION: extraction and confirmation each hold an in-flight ref,
// so a second tap while one is running does nothing. The Closet store is
// independently idempotent on lineage, so even a race that slipped past the
// ref could not create a second item.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { createActorRequest, isActorRequestCurrent } from '../services/actorContext';
import { currentActorScopeKey } from '../services/actorScope';
import { loadCloset } from '../services/closetLibrary';
import { RECEIPT_INTELLIGENCE_V1 } from '../constants/featureFlags';
import type { PurchaseImportInputTier } from '../services/purchaseImport/purchaseImportContract';
import { extractPurchaseCandidates } from '../services/purchaseImport/purchaseImportClient';
import {
  commitPurchaseDrafts,
  draftsToRetry,
  type ActorRequest,
  type CommitResult,
} from '../services/purchaseImport/purchaseImportCommit';
import type { PurchaseImportErrorClass } from '../services/purchaseImport/purchaseImportErrors';
import {
  discardPurchaseImportArtifacts,
  prepareCroppedImage,
  stagePickedImage,
  sweepPurchaseImportArtifacts,
  type NormalizedCrop,
  type PickedImage,
  type StagedImage,
} from '../services/purchaseImport/purchaseImportImage';
import type { PurchaseReviewModel, ReviewCandidate } from '../services/purchaseImport/purchaseImportNormalizer';
import {
  applyCandidateEdit,
  buildClosetDrafts,
  countCorrections,
  markOwnedDuplicates,
  selectedUnitCount,
  setCandidateSelected,
  setCandidateUnits,
  type EditableCandidateField,
  type PurchaseClosetDraft,
} from '../services/purchaseImport/purchaseImportReview';
import {
  confidenceBucket,
  countBucket,
  emitPurchaseImportEvent,
} from '../services/purchaseImport/purchaseImportTelemetry';

type ReadyReview = Extract<PurchaseReviewModel, { state: 'ready' }>;

export type PurchaseImportStep = 'choose' | 'crop' | 'extracting' | 'review' | 'committing' | 'done' | 'error';

export type PurchaseImportState = {
  step: PurchaseImportStep;
  inputTier: PurchaseImportInputTier;
  staged: StagedImage | null;
  review: ReadyReview | null;
  candidates: ReviewCandidate[];
  /** Line index -> garment photo URI the customer chose. Optional per line. */
  photos: ReadonlyMap<number, string>;
  commit: CommitResult | null;
  errorClass: PurchaseImportErrorClass | null;
};

function newSessionId(): string {
  // Random and local. Derived from nothing in the document (spec section 22).
  return `${Date.now().toString(36)}${Math.floor(Math.random() * 0x7fffffff).toString(36)}`;
}

const INITIAL: PurchaseImportState = {
  step: 'choose',
  inputTier: 'order_confirmation',
  staged: null,
  review: null,
  candidates: [],
  photos: new Map(),
  commit: null,
  errorClass: null,
};

export function usePurchaseImport() {
  const { isAuthenticated, user } = useAuthSession();
  const isAnonymous = Boolean((user as { is_anonymous?: boolean } | null)?.is_anonymous);
  const actorId = isAuthenticated && !isAnonymous ? user?.id ?? null : null;
  const actorScopeKey = currentActorScopeKey();

  const [state, setState] = useState<PurchaseImportState>(INITIAL);
  const stateRef = useRef(state);
  stateRef.current = state;

  const sessionRef = useRef<string>(newSessionId());
  const actorRef = useRef<string | null>(actorId);
  const workflowScopeRef = useRef(actorScopeKey);
  const mountedRef = useRef(true);
  const stagingRef = useRef<string | null>(null);
  const entryCleanupRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const extractingRef = useRef(false);
  const committingRef = useRef(false);
  const originalCandidatesRef = useRef<ReviewCandidate[]>([]);
  const draftsRef = useRef<PurchaseClosetDraft[]>([]);

  const enabled = RECEIPT_INTELLIGENCE_V1;

  const teardown = useCallback(async (staged: StagedImage | null) => {
    abortRef.current?.abort();
    abortRef.current = null;
    await discardPurchaseImportArtifacts(staged);
  }, []);

  // Entry sweep: removes anything an abandoned earlier session left behind.
  // Exit: abort and sweep whatever this session still holds.
  useEffect(() => {
    mountedRef.current = true;
    entryCleanupRef.current = sweepPurchaseImportArtifacts();
    return () => {
      mountedRef.current = false;
      sessionRef.current = newSessionId();
      abortRef.current?.abort();
      void discardPurchaseImportArtifacts(stateRef.current.staged);
    };
  }, []);

  // Actor switch: discard stale state (Journey H).
  useEffect(() => {
    if (actorRef.current === actorId && workflowScopeRef.current === actorScopeKey) return;
    const hadSession = stateRef.current.step !== 'choose' || stateRef.current.staged !== null;
    actorRef.current = actorId;
    workflowScopeRef.current = actorScopeKey;
    sessionRef.current = newSessionId();
    extractingRef.current = false;
    committingRef.current = false;
    stagingRef.current = null;
    void teardown(stateRef.current.staged);
    originalCandidatesRef.current = [];
    draftsRef.current = [];
    setState({ ...INITIAL, step: hadSession ? 'error' : 'choose', errorClass: hadSession ? 'session_changed' : null });
  }, [actorId, actorScopeKey, teardown]);

  // Check the canonical epoch directly: authentication can advance before
  // React has rendered the new actor or run the clearing effect above.
  const canUseWorkflow = useCallback(() => mountedRef.current
    && actorScopeKey === currentActorScopeKey(), [actorScopeKey]);

  const fail = useCallback((errorClass: PurchaseImportErrorClass) => {
    emitPurchaseImportEvent('purchase_import_failed', {
      failureClass: errorClass,
      inputTier: stateRef.current.inputTier,
    });
    setState((prev) => ({ ...prev, step: 'error', errorClass }));
  }, []);

  /** Start a session: pick the input tier. */
  const setInputTier = useCallback((inputTier: PurchaseImportInputTier) => {
    if (!canUseWorkflow()) return;
    setState((prev) => (prev.step === 'choose' ? { ...prev, inputTier } : prev));
  }, [canUseWorkflow]);

  /** The customer picked an image. It is staged into the feature's temp namespace. */
  const acceptPickedImage = useCallback(
    async (image: PickedImage) => {
      if (!canUseWorkflow() || stagingRef.current !== null) return;
      if (!enabled) return fail('feature_disabled');
      if (!actorId) return fail('unauthorized');
      const session = newSessionId();
      sessionRef.current = session;
      stagingRef.current = session;
      const request = createActorRequest();
      try {
        // A delayed entry sweep must finish before this session creates files.
        await entryCleanupRef.current;
        if (!canUseWorkflow() || !isActorRequestCurrent(request) || sessionRef.current !== session) return;
        const staged = await stagePickedImage(image);
        if (!canUseWorkflow() || !isActorRequestCurrent(request) || sessionRef.current !== session) {
          await discardPurchaseImportArtifacts(staged);
          return;
        }
        if (!staged) return fail('invalid_file');
        emitPurchaseImportEvent('purchase_import_started', { inputTier: stateRef.current.inputTier });
        setState((prev) => ({ ...prev, step: 'crop', staged, errorClass: null }));
      } finally {
        if (stagingRef.current === session) stagingRef.current = null;
      }
    },
    [actorId, enabled, fail, canUseWorkflow],
  );

  /** Crop confirmed: minimize, extract, normalize. */
  const extract = useCallback(
    async (crop: NormalizedCrop) => {
      if (!canUseWorkflow()) return;
      if (extractingRef.current) return; // Journey D: duplicate submission
      const { staged, inputTier } = stateRef.current;
      if (!staged) return;
      if (!actorId) return fail('unauthorized');
      extractingRef.current = true;
      const session = sessionRef.current;
      const request = createActorRequest();
      const controller = new AbortController();
      const isCurrent = () => canUseWorkflow() && isActorRequestCurrent(request)
        && sessionRef.current === session && !controller.signal.aborted;
      abortRef.current = controller;
      setState((prev) => ({ ...prev, step: 'extracting', errorClass: null }));
      try {
        const prepared = await prepareCroppedImage(staged, crop);
        // The staged source is no longer needed once the crop exists.
        await discardPurchaseImportArtifacts(staged);
        if (!isCurrent()) return;
        if (prepared.ok === false) return fail(prepared.errorClass);

        const result = await extractPurchaseCandidates({
          imageBase64: prepared.base64,
          inputTier,
          requestId: session,
          signal: controller.signal,
          isCurrent,
        });
        if (!isCurrent()) return;
        if (result.ok === false) return fail(result.errorClass);

        // Deterministic duplicate hints against what this actor already owns.
        let candidates = result.review.candidates;
        try {
          const owned = await loadCloset(actorId);
          candidates = markOwnedDuplicates(candidates, result.review.document.merchant.value, owned);
        } catch {
          /* hints are optional; review proceeds without them */
        }
        if (!isCurrent()) return;

        originalCandidatesRef.current = candidates;
        emitPurchaseImportEvent('purchase_import_extraction_completed', {
          inputTier,
          candidateCountBucket: countBucket(candidates.length),
          excludedCountBucket: countBucket(
            Object.values(result.review.excluded).reduce((sum, n) => sum + n, 0),
          ),
          documentConfidenceBucket: confidenceBucket(result.review.document.documentConfidence),
        });
        setState((prev) => ({
          ...prev,
          step: 'review',
          staged: null,
          review: result.review,
          candidates,
          photos: new Map(),
        }));
      } catch {
        if (isCurrent()) fail('provider_unavailable');
      } finally {
        if (sessionRef.current === session) extractingRef.current = false;
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [actorId, fail, canUseWorkflow],
  );

  const editCandidate = useCallback((lineIndex: number, field: EditableCandidateField, value: unknown) => {
    if (!canUseWorkflow()) return;
    setState((prev) =>
      prev.step !== 'review'
        ? prev
        : {
            ...prev,
            candidates: prev.candidates.map((c) => (c.lineIndex === lineIndex ? applyCandidateEdit(c, field, value) : c)),
          },
    );
  }, [canUseWorkflow]);

  const toggleCandidate = useCallback((lineIndex: number) => {
    if (!canUseWorkflow()) return;
    setState((prev) =>
      prev.step !== 'review'
        ? prev
        : {
            ...prev,
            candidates: prev.candidates.map((c) => (c.lineIndex === lineIndex ? setCandidateSelected(c, !c.selected) : c)),
          },
    );
  }, [canUseWorkflow]);

  const setUnits = useCallback((lineIndex: number, units: number) => {
    if (!canUseWorkflow()) return;
    setState((prev) =>
      prev.step !== 'review'
        ? prev
        : { ...prev, candidates: prev.candidates.map((c) => (c.lineIndex === lineIndex ? setCandidateUnits(c, units) : c)) },
    );
  }, [canUseWorkflow]);

  const setPhoto = useCallback((lineIndex: number, uri: string | null) => {
    if (!canUseWorkflow()) return;
    setState((prev) => {
      if (prev.step !== 'review') return prev;
      const photos = new Map(prev.photos);
      if (uri) photos.set(lineIndex, uri);
      else photos.delete(lineIndex);
      return { ...prev, photos };
    });
  }, [canUseWorkflow]);

  /** "Add N items to my Closet" — the explicit ownership action. */
  const confirm = useCallback(async () => {
    if (!canUseWorkflow()) return;
    if (committingRef.current) return; // double tap
    const current = stateRef.current;
    if (current.step !== 'review' || !current.review) return;
    if (!actorId) return fail('unauthorized');
    const units = selectedUnitCount(current.candidates);
    if (units === 0) return;

    committingRef.current = true;
    const session = sessionRef.current;
    // One actor request for the whole confirmation. A mid-way account change
    // invalidates it and the store refuses the remaining writes.
    const actorRequest = createActorRequest() as ActorRequest;
    const drafts = buildClosetDrafts(current.candidates, current.review.document, {
      sessionId: session,
      inputTier: current.inputTier,
    });
    draftsRef.current = drafts;

    const corrections = countCorrections(originalCandidatesRef.current, current.candidates);
    const correctionTotal = Object.values(corrections).reduce((sum, n) => sum + n, 0);
    emitPurchaseImportEvent('purchase_import_reviewed', {
      inputTier: current.inputTier,
      candidateCountBucket: countBucket(current.candidates.length),
      confirmedCountBucket: countBucket(units),
      rejectedCountBucket: countBucket(current.candidates.filter((c) => !c.selected).length),
      correctionCountBucket: countBucket(correctionTotal),
      correctionsNaming: corrections.naming,
      correctionsMaker: corrections.maker,
      correctionsClassification: corrections.classification,
      correctionsAppearance: corrections.appearance,
      correctionsFit: corrections.fit,
      correctionsMoney: corrections.money,
      photoCountBucket: countBucket(current.photos.size),
    });

    setState((prev) => ({ ...prev, step: 'committing' }));
    try {
      const result = await commitPurchaseDrafts(drafts, {
        actorRequest,
        ownerId: actorId,
        photos: current.photos,
      });
      if (!canUseWorkflow() || !isActorRequestCurrent(actorRequest) || sessionRef.current !== session) return;
      finishCommit(result);
    } finally {
      if (sessionRef.current === session) committingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, fail, canUseWorkflow]);

  const finishCommit = (result: CommitResult) => {
    if (result.actorChanged) {
      setState((prev) => ({ ...prev, step: 'error', errorClass: 'session_changed', commit: result }));
      emitPurchaseImportEvent('purchase_import_failed', { failureClass: 'session_changed' });
      return;
    }
    const complete = result.failedCount === 0;
    emitPurchaseImportEvent('purchase_import_confirmed', {
      inputTier: stateRef.current.inputTier,
      confirmedCountBucket: countBucket(result.addedCount),
      completionState: complete ? 'complete' : 'partial',
    });
    setState((prev) => ({
      ...prev,
      step: complete ? 'done' : 'review',
      commit: result,
      errorClass: complete ? null : 'partial_closet_persistence',
    }));
  };

  /** Retry only the units that did not land. Cannot duplicate the ones that did. */
  const retryFailed = useCallback(async () => {
    if (!canUseWorkflow()) return;
    if (committingRef.current) return;
    const current = stateRef.current;
    const previous = current.commit;
    if (!previous || !actorId || !current.review) return;
    // Rebuilt from the CURRENT review so a correction made after the failure
    // is what gets saved. The lineage ids are the same ones (same session, same
    // line, same unit), and only units that did not land are re-sent.
    const failedIds = new Set(
      previous.outcomes.filter((o) => o.status === 'failed' || o.status === 'not_attempted').map((o) => o.sourceLineageId),
    );
    const rebuilt = buildClosetDrafts(current.candidates, current.review.document, {
      sessionId: sessionRef.current,
      inputTier: current.inputTier,
    }).filter((d) => failedIds.has(d.sourceLineageId));
    const pending = draftsToRetry(rebuilt, previous);
    if (pending.length === 0) {
      // Every failed unit was deselected: what was added stands, and nothing is pending.
      const kept = previous.outcomes.filter((o) => o.status === 'added' || o.status === 'already_added');
      finishCommit({ outcomes: kept, addedCount: kept.length, failedCount: 0, actorChanged: false });
      return;
    }
    committingRef.current = true;
    const session = sessionRef.current;
    const actorRequest = createActorRequest() as ActorRequest;
    setState((prev) => ({ ...prev, step: 'committing' }));
    try {
      const retry = await commitPurchaseDrafts(pending, {
        actorRequest,
        ownerId: actorId,
        photos: stateRef.current.photos,
      });
      if (!canUseWorkflow() || !isActorRequestCurrent(actorRequest) || sessionRef.current !== session) return;
      // Merge: earlier successes stand, retried units take their new outcome.
      // A failed unit the customer deselected before retrying is dropped: they
      // chose not to add it, so it is neither added nor failed any more.
      const retried = new Map(retry.outcomes.map((o) => [o.sourceLineageId, o]));
      const outcomes = previous.outcomes
        .filter((o) => o.status === 'added' || o.status === 'already_added' || retried.has(o.sourceLineageId))
        .map((o) => retried.get(o.sourceLineageId) ?? o);
      finishCommit({
        outcomes,
        addedCount: outcomes.filter((o) => o.status === 'added' || o.status === 'already_added').length,
        failedCount: outcomes.filter((o) => o.status === 'failed' || o.status === 'not_attempted').length,
        actorChanged: retry.actorChanged,
      });
    } finally {
      if (sessionRef.current === session) committingRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actorId, canUseWorkflow]);

  /** Cancel at any step before confirmation. Nothing is written (Journey G). */
  const cancel = useCallback(async () => {
    if (!canUseWorkflow()) return;
    const { staged, step } = stateRef.current;
    if (step === 'committing') return; // an in-flight write finishes and reports
    sessionRef.current = newSessionId();
    const session = sessionRef.current;
    stagingRef.current = null;
    extractingRef.current = false;
    await teardown(staged);
    if (!canUseWorkflow() || sessionRef.current !== session) return;
    originalCandidatesRef.current = [];
    draftsRef.current = [];
    if (step !== 'done' && step !== 'choose') {
      emitPurchaseImportEvent('purchase_import_failed', { completionState: 'cancelled' });
    }
    setState(INITIAL);
  }, [teardown, canUseWorkflow]);

  const visibleState = workflowScopeRef.current === actorScopeKey ? state : INITIAL;

  return {
    enabled,
    signedIn: actorId !== null,
    state: visibleState,
    selectedUnits: selectedUnitCount(visibleState.candidates),
    setInputTier,
    acceptPickedImage,
    extract,
    editCandidate,
    toggleCandidate,
    setUnits,
    setPhoto,
    confirm,
    retryFailed,
    cancel,
  };
}
