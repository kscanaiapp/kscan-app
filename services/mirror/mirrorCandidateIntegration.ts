// Mirror Selfie → Closet candidate integration coordinator (Build 2.5 Step 4).
//
// THE ONE PLACE a completed MirrorExtractionSelection is turned into staged
// Closet candidates. It is a narrow ADAPTER over existing authority, not a new
// pipeline:
//
//   MirrorExtractionSelection
//     -> handoff validation (session/actor/crop ownership)
//     -> partition at 8 (existing CLOSET_CANDIDATE_BATCH_MAX_ITEMS)
//     -> stageMirrorSelfieGarmentCrops, ONE GROUP AT A TIME, SERIALLY
//     -> durability-gated Mirror crop cleanup
//     -> classification triggered exactly once (requeueClosetCandidatesOnReconnect)
//     -> aggregate MirrorStagingOutcome
//
// WHAT THIS MODULE OWNS: partitioning, serial dispatch, actor re-checks between
// groups, aggregation, and Mirror-crop lifecycle. Everything downstream of
// `stageMirrorSelfieGarmentCrops` — media derivation, duplicate detection,
// manifest persistence, classification, review, promotion — remains owned
// exactly where Build 1/2 already put it. This module calls that surface; it
// does not duplicate it.
//
// WHY SERIAL, NOT Promise.all. The candidate store serializes every mutation
// through one queue (services/closetCandidateLibrary.js#enqueue), so concurrent
// groups would not corrupt the manifest — but partial-result, actor-change and
// cancellation behavior all have to stay deterministic ("group 2 failed because
// the actor changed between group 1 and group 2" has no meaning if 1 and 2 were
// in flight together), and serial execution is the only way that sentence stays
// true.
//
// DOMAIN BOUNDARY. This file imports ONLY: closetMirrorStaging (staging),
// closetCandidateClassification (the reconnect entry point, not the classifier
// itself), actorContext, mirrorSessionStorage (crop cleanup) and
// closetTelemetry. It does not import, and must never import, scannerIdentification
// V2, identify_and_shop, services/library.js (Recent Scan), or anything
// commerce-shaped.

import * as FileSystem from 'expo-file-system/legacy';
import { createActorRequest, getActorContext, isActorRequestCurrent } from '../actorContext';
import {
  stageMirrorSelfieGarmentCrops,
  type MirrorCropStageOutcome,
  type StageMirrorSelfieGarmentCropsResult,
} from '../closetMirrorStaging';
import { CLOSET_CANDIDATE_BATCH_MAX_ITEMS } from '../closetCandidateLibrary';
import { requeueClosetCandidatesOnReconnect } from '../closetCandidateClassification';
import { isAutomaticallyRetryable, isUserRetryable } from '../closetCandidateErrors';
import { resolveClosetBatchFocus } from '../closetBatchReview';
import {
  deleteMirrorSessionFile,
  isMirrorSessionOwnedUri,
} from './mirrorSessionStorage';
import { emitClosetCandidateEvent } from '../closetTelemetry';
import { MIRROR_SELFIE_V1_ACTIVE } from '../../constants/featureFlags';
import type { MirrorExtractionSelection, MirrorGarmentCropInput } from '../../types/mirrorExtraction';
import type { ClosetCandidateErrorCode } from '../../types/closetCandidate';

// ── Result vocabulary ────────────────────────────────────────────────────────

export type MirrorStagingGroupStatus =
  | 'pending'
  | 'staging'
  | 'succeeded'
  | 'failed_retryable'
  | 'failed_non_retryable'
  | 'not_started'
  | 'cancelled';

export type MirrorStagingGroupState = {
  groupIndex: number;
  /** Step 3 order, preserved. This IS the group's stable identity for retry. */
  cropKeys: string[];
  candidateBatchId?: string;
  status: MirrorStagingGroupStatus;
};

/**
 * Whole-handoff rejections. Nothing has been created when one of these is
 * returned — the crop list never reached candidate staging at all.
 */
export type MirrorIntegrationRejectReason =
  | 'mirror_integration_disabled'
  | 'mirror_integration_actor_stale'
  | 'mirror_integration_invalid_session'
  | 'mirror_integration_empty_selection'
  | 'mirror_integration_duplicate_crop_key'
  | 'mirror_integration_invalid_crop_key'
  | 'mirror_integration_crop_not_session_owned'
  | 'mirror_integration_crop_unreadable';

export type MirrorStagingOutcome = {
  totalCropCount: number;
  groups: MirrorStagingGroupState[];

  successfulCropKeys: string[];
  retryableCropKeys: string[];
  nonRetryableCropKeys: string[];
  notStartedCropKeys: string[];

  /** Crop files still on disk in the Mirror session after this call. */
  retainedCropKeys: string[];
  /** Crop files this call deleted (durable candidate media confirmed, or a
   *  non-retryable dead end). */
  cleanedCropKeys: string[];

  candidateBatchIds: string[];
  /** The batch a caller should focus review on, or null. First group that
   *  durably created or duplicate-matched something — see resolveClosetBatchFocus. */
  focusBatchId: string | null;

  outcome: 'created' | 'partial' | 'cancelled' | 'capacity_blocked' | 'actor_changed' | 'rejected' | 'empty';
  rejectReason?: MirrorIntegrationRejectReason;
};

export type IntegrateMirrorSelectionDeps = {
  /**
   * The actor snapshot captured at the TRUE start of the operation — before
   * this function was even called, ideally the first statement of whatever
   * kicked the operation off. Optional; when omitted, one is captured fresh at
   * function entry, which still catches a change that happens DURING the call.
   */
  actorRequest?: ReturnType<typeof createActorRequest>;
  resolveActive?: () => boolean;
  stageGroup?: (input: {
    actorRequest: ReturnType<typeof createActorRequest>;
    extractionSessionId: string;
    crops: MirrorGarmentCropInput[];
  }) => Promise<StageMirrorSelfieGarmentCropsResult>;
  requeueClassification?: typeof requeueClosetCandidatesOnReconnect;
  deleteCropFile?: typeof deleteMirrorSessionFile;
  fileExists?: (uri: string) => Promise<boolean>;
  /** Checked before each group. False stops dispatching further groups. */
  shouldContinue?: () => boolean;
  /** Fired after each group settles, with the outcome as computed so far. */
  onProgress?: (partial: MirrorStagingOutcome) => void;
};

// ── Validation ───────────────────────────────────────────────────────────────

const SESSION_OR_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function bucketCropCount(count: number): string {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 5) return '4-5';
  if (count <= 8) return '6-8';
  return '9_plus';
}

function bucketGroupCount(count: number): string {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  return '4_plus';
}

function emptyOutcome(reason: MirrorIntegrationRejectReason, totalCropCount: number): MirrorStagingOutcome {
  return {
    totalCropCount,
    groups: [],
    successfulCropKeys: [],
    retryableCropKeys: [],
    nonRetryableCropKeys: [],
    notStartedCropKeys: [],
    retainedCropKeys: [],
    cleanedCropKeys: [],
    candidateBatchIds: [],
    focusBatchId: null,
    outcome: 'rejected',
    rejectReason: reason,
  };
}

/**
 * Partition an ordered crop list at a maximum of CLOSET_CANDIDATE_BATCH_MAX_ITEMS.
 *
 * Sequential, never reordered, never truncated: 17 crops become 8 + 8 + 1, and
 * every crop appears in EXACTLY one group. This is the entire "more than eight"
 * rule — Step 3 deliberately returns the complete unpartitioned list so this is
 * the one place the limit is applied.
 */
export function partitionMirrorCrops(
  crops: MirrorGarmentCropInput[],
  maxGroupSize: number = CLOSET_CANDIDATE_BATCH_MAX_ITEMS,
): MirrorStagingGroupState[] {
  const size = Math.max(1, maxGroupSize);
  const groups: MirrorStagingGroupState[] = [];
  for (let start = 0; start < crops.length; start += size) {
    groups.push({
      groupIndex: groups.length,
      cropKeys: crops.slice(start, start + size).map((c) => c.cropKey),
      status: 'pending',
    });
  }
  return groups;
}

async function defaultFileExists(uri: string): Promise<boolean> {
  try {
    const info = await FileSystem.getInfoAsync(uri);
    return info?.exists === true;
  } catch {
    return false;
  }
}

/**
 * Validate the handoff BEFORE any candidate is touched.
 *
 * Every check here is a precondition, not a business decision: a malformed or
 * stale handoff fails closed with a bounded reason, exactly like
 * stageMirrorSelfieGarmentCrops's own preflight (Step 1), which this mirrors on
 * purpose rather than inventing a second validation vocabulary.
 */
/**
 * String-discriminated, matching the `kind` convention used throughout the
 * candidate system (createClosetCandidate, stageMirrorSelfieGarmentCrops)
 * rather than a boolean `ok` — this project compiles with `strictNullChecks`
 * disabled, under which TypeScript cannot narrow a union on a boolean literal
 * discriminant.
 */
type HandoffValidationResult =
  | { kind: 'ok'; crops: MirrorGarmentCropInput[] }
  | { kind: 'rejected'; reason: MirrorIntegrationRejectReason };

async function validateHandoff(
  selection: MirrorExtractionSelection,
  actorRequest: ReturnType<typeof createActorRequest>,
  fileExists: (uri: string) => Promise<boolean>,
): Promise<HandoffValidationResult> {
  if (!isActorRequestCurrent(actorRequest)) {
    return { kind: 'rejected', reason: 'mirror_integration_actor_stale' };
  }

  const sessionId = selection?.extractionSessionId;
  if (typeof sessionId !== 'string' || !SESSION_OR_KEY_PATTERN.test(sessionId)) {
    return { kind: 'rejected', reason: 'mirror_integration_invalid_session' };
  }

  const crops = Array.isArray(selection?.crops) ? selection.crops : [];
  if (crops.length === 0) {
    return { kind: 'rejected', reason: 'mirror_integration_empty_selection' };
  }

  const seen = new Set<string>();
  for (const crop of crops) {
    if (typeof crop?.cropKey !== 'string' || !SESSION_OR_KEY_PATTERN.test(crop.cropKey)) {
      return { kind: 'rejected', reason: 'mirror_integration_invalid_crop_key' };
    }
    if (seen.has(crop.cropKey)) {
      return { kind: 'rejected', reason: 'mirror_integration_duplicate_crop_key' };
    }
    seen.add(crop.cropKey);

    if (typeof crop.cropUri !== 'string' || !crop.cropUri.trim()) {
      return { kind: 'rejected', reason: 'mirror_integration_crop_unreadable' };
    }
    // Ownership BEFORE readability: a URI outside the declared session must
    // never be staged even if it happens to exist on disk.
    if (!isMirrorSessionOwnedUri(crop.cropUri, sessionId)) {
      return { kind: 'rejected', reason: 'mirror_integration_crop_not_session_owned' };
    }
  }

  // Readability, checked once per crop, in parallel — a read-only stat, not a
  // mutation, so concurrency here does not touch the serialization concern
  // that keeps group DISPATCH sequential.
  const readable = await Promise.all(crops.map((crop) => fileExists(crop.cropUri)));
  if (readable.some((ok) => !ok)) {
    return { kind: 'rejected', reason: 'mirror_integration_crop_unreadable' };
  }

  return { kind: 'ok', crops };
}

// ── Per-crop outcome classification ─────────────────────────────────────────

/** True when the pipeline actually wrote durable candidate media for this crop. */
function isDurableOutcome(outcome: MirrorCropStageOutcome['outcome']): boolean {
  return outcome === 'created' || outcome === 'deduped_candidate' || outcome === 'duplicate_of_closet';
}

/**
 * Retryable in the sense a later attempt at THIS SAME crop could succeed.
 *
 * `candidate_actor_stale` is deliberately excluded: it is not that this crop
 * failed, it is that the operation itself moved to a different actor, and that
 * is handled at the group level, not folded into per-crop retryability.
 *
 * `candidate_limit_reached` is deliberately INCLUDED despite the error
 * registry marking it non-retryable (recovery: `remove_candidates`). The
 * registry's answer is about AUTOMATIC retry — retrying immediately would
 * just hit the same full cap — but nothing about the crop itself is wrong.
 * Once the user resolves existing candidates the cap frees up and this exact
 * crop can succeed, so it is retained rather than discarded. See §16/§22 of
 * the Step 4 addendum: "Retain remaining crops under the governed session
 * lifecycle."
 */
function isCropRetryable(errorCode: ClosetCandidateErrorCode | undefined): boolean {
  if (!errorCode) return false;
  if (errorCode === 'candidate_actor_stale') return false;
  if (errorCode === 'candidate_limit_reached') return true;
  return isAutomaticallyRetryable(errorCode) || isUserRetryable(errorCode);
}

// ── Coordinator ──────────────────────────────────────────────────────────────

/**
 * Stage a complete Mirror extraction selection into the existing Closet
 * candidate pipeline.
 *
 * Returns a full MirrorStagingOutcome even on partial failure — partial success
 * is a first-class result, never reduced to a generic failure.
 */
export async function integrateMirrorExtractionSelection(
  selection: MirrorExtractionSelection,
  deps: IntegrateMirrorSelectionDeps = {},
): Promise<MirrorStagingOutcome> {
  const resolveActive = deps.resolveActive ?? (() => MIRROR_SELFIE_V1_ACTIVE);
  const stageGroup = deps.stageGroup ?? stageMirrorSelfieGarmentCrops;
  const requeueClassification = deps.requeueClassification ?? requeueClosetCandidatesOnReconnect;
  const deleteCropFile = deps.deleteCropFile ?? deleteMirrorSessionFile;
  const fileExists = deps.fileExists ?? defaultFileExists;
  const shouldContinue = deps.shouldContinue ?? (() => true);

  const totalCropCount = Array.isArray(selection?.crops) ? selection.crops.length : 0;
  const startedAtMs = Date.now();

  // (1) The master gate. Nothing below may run while it is false.
  if (resolveActive() !== true) {
    return emptyOutcome('mirror_integration_disabled', totalCropCount);
  }

  // (2) Actor identity: the OPERATION's identity for its whole lifetime, and
  // every later check compares against THIS snapshot — never against a freshly
  // minted request, which would trivially always look current against itself.
  //
  // `deps.actorRequest`, WHEN THE CALLER SUPPLIES ONE, is what makes "the actor
  // changed before staging began" a real, checkable condition rather than a
  // contradiction: it is captured by the caller at the true start of the
  // operation (services/hooks/useClosetCandidates.js#stageMirrorSelection
  // captures it as its first statement, exactly like every sibling intake
  // method already does), so a change that happened between THAT capture and
  // THIS function actually running is visible here. Without an externally
  // supplied snapshot there is no earlier moment to compare against, and the
  // function falls back to capturing fresh — which still correctly detects a
  // change that happens DURING this call (the between-group and mid-validation
  // checks), just not one that happened strictly before it was invoked.
  const startedUnder = deps.actorRequest
    ? { actorId: deps.actorRequest.actorId, epoch: deps.actorRequest.epoch }
    : getActorContext();
  const actorRequest = deps.actorRequest ?? createActorRequest();
  const actorStillValid = () => {
    const now = getActorContext();
    return now.actorId === startedUnder.actorId && now.epoch === startedUnder.epoch;
  };

  const validated = await validateHandoff(selection, actorRequest, fileExists);
  if (validated.kind === 'rejected') {
    emitClosetCandidateEvent('mirror_candidate_staging_started', {
      cropCountBucket: bucketCropCount(totalCropCount),
      outcome: 'rejected',
      errorCode: validated.reason,
    });
    return emptyOutcome(validated.reason, totalCropCount);
  }
  const crops = validated.crops;
  const cropSessionId = selection.extractionSessionId;

  const groups = partitionMirrorCrops(crops);
  emitClosetCandidateEvent('mirror_candidate_staging_started', {
    cropCountBucket: bucketCropCount(totalCropCount),
    groupCountBucket: bucketGroupCount(groups.length),
    outcome: 'started',
  });

  const successfulCropKeys: string[] = [];
  const retryableCropKeys: string[] = [];
  const nonRetryableCropKeys: string[] = [];
  const notStartedCropKeys: string[] = [];
  const retainedCropKeys: string[] = [];
  const cleanedCropKeys: string[] = [];
  const candidateBatchIds: string[] = [];
  let focusBatchId: string | null = null;
  let anyCreated = false;
  let stoppedEarly: 'cancelled' | 'capacity_blocked' | 'actor_changed' | null = null;

  const cropByKey = new Map(crops.map((c) => [c.cropKey, c] as const));

  function partial(): MirrorStagingOutcome {
    return {
      totalCropCount,
      groups: groups.map((g) => ({ ...g })),
      successfulCropKeys: [...successfulCropKeys],
      retryableCropKeys: [...retryableCropKeys],
      nonRetryableCropKeys: [...nonRetryableCropKeys],
      notStartedCropKeys: [...notStartedCropKeys],
      retainedCropKeys: [...retainedCropKeys],
      cleanedCropKeys: [...cleanedCropKeys],
      candidateBatchIds: [...candidateBatchIds],
      focusBatchId,
      outcome: 'partial',
    };
  }

  async function cleanupCrop(cropKey: string): Promise<void> {
    const crop = cropByKey.get(cropKey);
    if (!crop) return;
    const deleted = await deleteCropFile(crop.cropUri, cropSessionId).catch(() => false);
    if (deleted) cleanedCropKeys.push(cropKey);
    else retainedCropKeys.push(cropKey);
  }

  // ── Serial group dispatch ──────────────────────────────────────────────────
  for (const group of groups) {
    if (stoppedEarly) {
      group.status = 'not_started';
      notStartedCropKeys.push(...group.cropKeys);
      // A group past the FIRST one to hit the stop condition never gets its
      // own turn to run the cancelled/actor-changed cleanup branches below —
      // it is short-circuited here instead. Skipping cleanup in this branch
      // was the actual bug: every group after the second one in a multi-group
      // actor-change or cancellation left its crop files stranded forever,
      // never reported as cleaned OR as retained.
      //
      // capacity_blocked is deliberately excluded: those crops are RETAINED,
      // not cleaned — the user may resolve existing candidates and retry
      // rather than re-extracting from scratch.
      if (stoppedEarly === 'cancelled' || stoppedEarly === 'actor_changed') {
        for (const key of group.cropKeys) await cleanupCrop(key);
      } else {
        retainedCropKeys.push(...group.cropKeys);
      }
      continue;
    }
    if (!shouldContinue()) {
      stoppedEarly = 'cancelled';
      group.status = 'cancelled';
      notStartedCropKeys.push(...group.cropKeys);
      // Cancellation cleans unstaged crops — nothing was submitted for them.
      for (const key of group.cropKeys) await cleanupCrop(key);
      continue;
    }
    if (!actorStillValid()) {
      stoppedEarly = 'actor_changed';
      group.status = 'not_started';
      notStartedCropKeys.push(...group.cropKeys);
      // The operation's OWN actor's leftover crops are cleaned; nothing is
      // created and nothing is attributed to whoever is now signed in.
      for (const key of group.cropKeys) await cleanupCrop(key);
      continue;
    }

    // NO PER-GROUP EMPTY-AFTER-PREFLIGHT CHECK, on purpose. It would be dead
    // code: `partitionMirrorCrops` never produces a group from an empty
    // slice, groups within one call never share a crop key (so no group can
    // be "already resolved" by an earlier group in the SAME run), and a RETRY
    // that reuses a selection whose crop files were already deleted after a
    // prior success fails HANDOFF VALIDATION for the WHOLE call — the
    // `mirror_integration_crop_unreadable` rejection — before any group is
    // ever partitioned or dispatched. "Never send an empty staging request"
    // is therefore already guaranteed structurally, by those two properties,
    // rather than by a guard here that could never fire.
    group.status = 'staging';
    const groupCrops = group.cropKeys.map((key) => cropByKey.get(key) as MirrorGarmentCropInput);

    let result: StageMirrorSelfieGarmentCropsResult;
    try {
      result = await stageGroup({
        actorRequest,
        extractionSessionId: cropSessionId,
        crops: groupCrops,
      });
    } catch {
      result = { kind: 'rejected', reason: 'mirror_batch_limit_exceeded' } as StageMirrorSelfieGarmentCropsResult;
    }

    if (result.kind === 'rejected') {
      if (result.reason === 'candidate_actor_stale') {
        stoppedEarly = 'actor_changed';
        group.status = 'not_started';
        notStartedCropKeys.push(...group.cropKeys);
        for (const key of group.cropKeys) await cleanupCrop(key);
        continue;
      }
      // A whole-call rejection (empty list, batch-limit, malformed key — none
      // of which should occur given handoff validation and deterministic
      // partitioning, but the outcome is still reported truthfully) retains
      // every crop in the group as retryable.
      group.status = 'failed_retryable';
      retryableCropKeys.push(...group.cropKeys);
      retainedCropKeys.push(...group.cropKeys);
      continue;
    }

    // result.kind === 'ok'
    group.candidateBatchId = result.batchId;
    candidateBatchIds.push(result.batchId);

    const groupFocus = resolveClosetBatchFocus({
      batchId: result.batchId,
      createdCandidateIds: result.outcomes.filter((o) => o.candidateId).map((o) => o.candidateId),
      sourceOutcomes: result.outcomes.map((o) => ({ kind: o.outcome, candidateId: o.candidateId ?? null })),
    });
    if (groupFocus && !focusBatchId) focusBatchId = groupFocus;

    let groupHitCapacity = false;
    for (const outcome of result.outcomes) {
      if (isDurableOutcome(outcome.outcome)) {
        successfulCropKeys.push(outcome.cropKey);
        anyCreated = anyCreated || outcome.outcome === 'created' || outcome.outcome === 'duplicate_of_closet';
        await cleanupCrop(outcome.cropKey);
      } else if (isCropRetryable(outcome.errorCode)) {
        retryableCropKeys.push(outcome.cropKey);
        retainedCropKeys.push(outcome.cropKey);
      } else {
        nonRetryableCropKeys.push(outcome.cropKey);
        await cleanupCrop(outcome.cropKey);
      }
      if (outcome.errorCode === 'candidate_limit_reached') groupHitCapacity = true;
    }

    group.status = result.outcomes.every((o) => isDurableOutcome(o.outcome))
      ? 'succeeded'
      : result.outcomes.some((o) => isDurableOutcome(o.outcome))
        ? 'succeeded'
        : 'failed_retryable';

    deps.onProgress?.(partial());

    if (groupHitCapacity) stoppedEarly = 'capacity_blocked';
  }

  // Classification is triggered EXACTLY ONCE for the whole operation, only if
  // something was durably created — mirrors useClosetCandidates#addMirrorGarmentCrops
  // for a single group. requeueClosetCandidatesOnReconnect is itself idempotent
  // (filters on status + in-flight), so this is safe even if called again later
  // by an unrelated focus/reconnect event.
  if (anyCreated && actorStillValid()) {
    await requeueClassification(actorRequest).catch(() => null);
  }

  const finalOutcome: MirrorStagingOutcome['outcome'] = stoppedEarly
    ? stoppedEarly
    : nonRetryableCropKeys.length === 0 && retryableCropKeys.length === 0
      ? 'created'
      : 'partial';

  emitClosetCandidateEvent(
    stoppedEarly === 'cancelled'
      ? 'mirror_candidate_staging_cancelled'
      : finalOutcome === 'created'
        ? 'mirror_candidate_staging_completed'
        : 'mirror_candidate_staging_partial',
    {
      cropCountBucket: bucketCropCount(totalCropCount),
      groupCountBucket: bucketGroupCount(groups.length),
      successCountBucket: bucketCropCount(successfulCropKeys.length),
      failureCountBucket: bucketCropCount(retryableCropKeys.length + nonRetryableCropKeys.length),
      durationBucket: bucketDurationMs(Date.now() - startedAtMs),
      outcome: finalOutcome,
    },
  );

  return {
    totalCropCount,
    groups,
    successfulCropKeys,
    retryableCropKeys,
    nonRetryableCropKeys,
    notStartedCropKeys,
    retainedCropKeys,
    cleanedCropKeys,
    candidateBatchIds,
    focusBatchId,
    outcome: finalOutcome,
  };
}

function bucketDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5_000) return 'under_5s';
  if (ms < 15_000) return '5_to_15s';
  if (ms < 30_000) return '15_to_30s';
  if (ms < 60_000) return '30_to_60s';
  return 'over_60s';
}

// ── Crash-window / recovery reconciliation ──────────────────────────────────

/**
 * Reconcile Mirror crops against ALREADY-DURABLE candidates.
 *
 * THE NARROW CASE THIS CLOSES: candidate media becomes durable, then the app
 * terminates before this module's own post-staging `cleanupCrop` call runs. The
 * crop file is orphaned in the Mirror session; without this it would sit until
 * the governed TTL sweep reclaims the whole session, days later.
 *
 * Matched by LINEAGE, not by re-attempting staging: `deriveMirrorSourceLineageId`
 * is deterministic from (extractionSessionId, cropKey), so a durable candidate
 * whose `sourceLineageId` matches proves this exact crop already has a home. It
 * is deleted; it is never restaged and never counted as a new failure.
 *
 * THIS IS NOT A RESUME QUEUE. It does not restart not-started or in-flight
 * groups — only Build 2.5 Step 4's own review/retry surfaces do that, driven by
 * the user. It only removes redundant temporary files whose durable twin
 * already exists. Bounded to the caller-supplied crop list; never an
 * unrestricted filesystem or manifest scan.
 */
export async function reconcileDurableMirrorCrops(
  input: { extractionSessionId: string; crops: MirrorGarmentCropInput[] },
  deps: {
    actorRequest?: ReturnType<typeof createActorRequest>;
    listDurableLineageIds?: (actorRequest: ReturnType<typeof createActorRequest>) => Promise<Set<string>>;
    deriveLineageId?: (sessionId: string, cropKey: string) => Promise<string>;
    deleteCropFile?: typeof deleteMirrorSessionFile;
  } = {},
): Promise<{ reconciledCropKeys: string[] }> {
  const actorRequest = deps.actorRequest ?? createActorRequest();
  if (!isActorRequestCurrent(actorRequest)) return { reconciledCropKeys: [] };

  const deleteCropFile = deps.deleteCropFile ?? deleteMirrorSessionFile;
  const deriveLineageId =
    deps.deriveLineageId ??
    (async (sessionId: string, cropKey: string) => {
      const { deriveMirrorSourceLineageId } = await import('../closetMirrorStaging');
      return deriveMirrorSourceLineageId(sessionId, cropKey);
    });
  const listDurableLineageIds =
    deps.listDurableLineageIds ??
    (async (request: ReturnType<typeof createActorRequest>) => {
      const { listClosetCandidates } = await import('../closetCandidateLibrary');
      const listed = await listClosetCandidates(request);
      const lineageIds = new Set<string>();
      if (listed.ok) {
        for (const candidate of listed.candidates) {
          if (typeof candidate.sourceLineageId === 'string' && candidate.sourceLineageId) {
            lineageIds.add(candidate.sourceLineageId);
          }
        }
      }
      return lineageIds;
    });

  const durableLineageIds = await listDurableLineageIds(actorRequest);
  const reconciledCropKeys: string[] = [];

  for (const crop of input.crops ?? []) {
    if (!isActorRequestCurrent(actorRequest)) break;
    const lineageId = await deriveLineageId(input.extractionSessionId, crop.cropKey);
    if (!durableLineageIds.has(lineageId)) continue;
    const deleted = await deleteCropFile(crop.cropUri, input.extractionSessionId).catch(() => false);
    if (deleted) reconciledCropKeys.push(crop.cropKey);
  }

  return { reconciledCropKeys };
}
