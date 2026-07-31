// Mirror Selfie garment-crop staging adapter (Build 2.5 Phase 0B).
//
// THE ONE PLACE a Mirror Selfie extraction hands garment crops to the existing
// Closet candidate pipeline. This module stages already-produced crop URIs; it
// does not capture, validate, detect a person in, segment a garment from, or
// preview anything. Those stages do not exist yet and do not belong here.
//
// GOVERNING ROUTING CONTRACT:
//
//   1-8 garment crop URIs
//     -> sourceType: mirror_extract
//     -> shared batchId
//     -> deterministic batchPosition
//     -> createClosetCandidateBatch (existing pipeline, unmodified in kind)
//     -> identify_for_closet (dormant — see closetIdentificationV2.ts)
//     -> existing Closet batch-review projection
//
// WHAT THIS MODULE DOES NOT DO, on purpose:
//   - copy, move, rename, or delete crop files (deriveCandidateMedia does)
//   - reimplement storage preflight, hashing, or exact duplicate detection
//   - write the candidate or Closet manifest directly
//   - call classifyClosetCandidate (the existing queue runner owns that)
//   - persist the original Mirror Selfie or a parent-selfie URI
//   - create a Recent Scan or any commerce artifact
//   - promote a candidate into the committed Closet
//   - choose an identification intent (createClosetCandidateBatch's downstream
//     classification step hard-codes identify_for_closet; this module has no
//     intent parameter to offer one)

import * as ExpoCrypto from 'expo-crypto';
import { isActorRequestCurrent } from './actorContext';
import {
  createClosetCandidateBatch,
  CLOSET_CANDIDATE_BATCH_MAX_ITEMS,
} from './closetCandidateLibrary';
import { createClosetBatchId } from './closetCandidateSchema';
import { emitClosetCandidateEvent } from './closetTelemetry';
import { MIRROR_SELFIE_V1_ACTIVE } from '../constants/featureFlags';
import type { ClosetCandidateErrorCode } from '../types/closetCandidate';

/** Mirrors createActorRequest()'s shape from services/actorContext.js. */
export type ActorRequest = {
  actorId: string | null;
  epoch: number;
  requestId: string;
};

export type MirrorGarmentCropInput = {
  cropUri: string;
  cropKey: string;
};

export type StageMirrorSelfieGarmentCropsInput = {
  actorRequest: ActorRequest;
  extractionSessionId: string;
  crops: MirrorGarmentCropInput[];
};

/**
 * The batch-creation outcomes the existing candidate pipeline already
 * produces. No second vocabulary is invented here — see
 * services/closetCandidateLibrary.js#createClosetCandidate.
 */
export type ExistingCandidateCreationOutcome =
  | 'created'
  | 'deduped_candidate'
  | 'duplicate_of_closet'
  | 'already_in_closet'
  | 'rejected';

export type MirrorCropStageOutcome = {
  cropKey: string;
  batchPosition: number;
  candidateId?: string;
  outcome: ExistingCandidateCreationOutcome;
  errorCode?: ClosetCandidateErrorCode;
};

/**
 * Stable, Mirror-scoped preflight rejection reasons.
 *
 * These are INPUT rejections only — nothing has been created yet when one of
 * these is returned. `candidate_actor_stale` is reused rather than
 * reinvented: it already means exactly "the captured actor context is no
 * longer current" everywhere else in the candidate system.
 */
export type MirrorCropStagingRejectReason =
  | 'mirror_staging_disabled'
  | 'candidate_actor_stale'
  | 'mirror_invalid_session_id'
  | 'mirror_empty_crop_list'
  | 'mirror_batch_limit_exceeded'
  | 'mirror_invalid_crop_key'
  | 'mirror_duplicate_crop_key';

/**
 * String-discriminated result, matching the `kind` convention used throughout
 * the candidate system (createClosetCandidate, buildClosetV2Request) rather
 * than a boolean `ok` — this project compiles with `strictNullChecks`
 * disabled, under which TypeScript cannot narrow a union on a boolean
 * literal discriminant.
 */
export type StageMirrorSelfieGarmentCropsResult =
  | { kind: 'ok'; batchId: string; outcomes: MirrorCropStageOutcome[] }
  | { kind: 'rejected'; reason: MirrorCropStagingRejectReason };

// ── Validation shapes ────────────────────────────────────────────────────────

/**
 * Shared shape for `extractionSessionId` and `cropKey`.
 *
 * Bounded and allowlisted for the same reason evidence ids and telemetry
 * strings are: this pattern cannot express a `file://`/`content://` URI, a
 * filesystem path, or free-form user text, so neither value can carry PII or
 * a parent-selfie reference merely by being permissive.
 */
const SESSION_OR_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function isValidExtractionSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_OR_KEY_PATTERN.test(value);
}

function isValidCropKey(value: unknown): value is string {
  return typeof value === 'string' && SESSION_OR_KEY_PATTERN.test(value);
}

// ── Deterministic source lineage ─────────────────────────────────────────────

/**
 * Deterministic Mirror source lineage: `SHA-256("mirror_extract:" +
 * extractionSessionId + ":" + cropKey)`.
 *
 * Deliberately excludes the actor id, the crop URI, the file path, and every
 * other candidate field: actor isolation is already provided by the existing
 * actor-scoped lookup and write authority (every read and write below goes
 * through the captured `actorRequest`), so lineage only has to distinguish
 * crops, not actors.
 *
 * SAME actor + SAME session + SAME crop key -> same lineage, which is what
 * makes restaging the same crop idempotent through the existing committed-
 * Closet lineage check and the existing exact-hash active-candidate check.
 * Different crop keys, or different sessions, produce different lineage.
 */
export async function deriveMirrorSourceLineageId(
  extractionSessionId: string,
  cropKey: string,
  deps: { Crypto?: typeof ExpoCrypto } = {},
): Promise<string> {
  const crypto = deps.Crypto ?? ExpoCrypto;
  const input = `mirror_extract:${extractionSessionId}:${cropKey}`;
  const digest = await crypto.digestStringAsync(
    crypto.CryptoDigestAlgorithm.SHA256,
    input,
    { encoding: crypto.CryptoEncoding.HEX },
  );
  return digest.trim().toLowerCase();
}

// ── Telemetry ────────────────────────────────────────────────────────────────

function bucketCropCount(count: number): string {
  if (count <= 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 5) return '4-5';
  return '6-8';
}

function emitStaged(input: {
  cropCount: number;
  createdCount: number;
  duplicateCount: number;
  rejectedCount: number;
  batchLimitReached: boolean;
  outcome: string;
}): void {
  emitClosetCandidateEvent('mirror_selfie_crops_staged', {
    cropCountBucket: bucketCropCount(input.cropCount),
    createdCount: input.createdCount,
    duplicateCount: input.duplicateCount,
    rejectedCount: input.rejectedCount,
    batchLimitReached: input.batchLimitReached,
    outcome: input.outcome,
  });
}

// ── Staging ──────────────────────────────────────────────────────────────────

/**
 * Stage one to eight already-produced garment crop URIs as one Mirror Selfie
 * candidate batch.
 *
 * @param deps.resolveActive Test seam; defaults to reading the real flag.
 */
export async function stageMirrorSelfieGarmentCrops(
  input: StageMirrorSelfieGarmentCropsInput,
  deps: { resolveActive?: () => boolean } = {},
): Promise<StageMirrorSelfieGarmentCropsResult> {
  const resolveActive = deps.resolveActive ?? (() => MIRROR_SELFIE_V1_ACTIVE);

  // (1) The master gate. Nothing below this line may run while it is false —
  // no candidate, no media, no legacy direct Closet insertion.
  if (resolveActive() !== true) {
    emitStaged({
      cropCount: Array.isArray(input?.crops) ? input.crops.length : 0,
      createdCount: 0,
      duplicateCount: 0,
      rejectedCount: 0,
      batchLimitReached: false,
      outcome: 'rejected',
    });
    return { kind: 'rejected', reason: 'mirror_staging_disabled' };
  }

  // (2) Actor currency, BEFORE inspecting crop files. This is the adapter's
  // OWN check, distinct from and in addition to the post-media revalidation
  // `createClosetCandidateBatch` -> `createClosetCandidate` already performs.
  const actorRequest = input?.actorRequest;
  if (!isActorRequestCurrent(actorRequest)) {
    return { kind: 'rejected', reason: 'candidate_actor_stale' };
  }

  // (3) extractionSessionId: present and bounded. Forward-looking only in
  // Phase 0B — no session database or manifest is created here.
  if (!isValidExtractionSessionId(input?.extractionSessionId)) {
    return { kind: 'rejected', reason: 'mirror_invalid_session_id' };
  }
  const extractionSessionId = input.extractionSessionId;

  const crops = Array.isArray(input?.crops) ? input.crops : [];

  // (4) Empty list.
  if (crops.length < 1) {
    return { kind: 'rejected', reason: 'mirror_empty_crop_list' };
  }

  // (5) Batch ceiling, BEFORE any media work and BEFORE any duplicate-key
  // check. Rejected outright, never silently truncated to the first eight.
  if (crops.length > CLOSET_CANDIDATE_BATCH_MAX_ITEMS) {
    return { kind: 'rejected', reason: 'mirror_batch_limit_exceeded' };
  }

  // (6) Crop-key shape and uniqueness. The adapter does not decide whether an
  // image IS a garment crop (segmentation's job, later); it only decides
  // whether the caller-supplied identity for each one is well-formed and
  // distinct within this request. `cropUri` readability is intentionally NOT
  // checked here — that already belongs to, and is already owned by,
  // createClosetCandidate's existing storage preflight and media derivation,
  // per-crop, without this adapter reimplementing it.
  const seenKeys = new Set<string>();
  for (const crop of crops) {
    if (!isValidCropKey(crop?.cropKey)) {
      return { kind: 'rejected', reason: 'mirror_invalid_crop_key' };
    }
    if (seenKeys.has(crop.cropKey)) {
      return { kind: 'rejected', reason: 'mirror_duplicate_crop_key' };
    }
    seenKeys.add(crop.cropKey);
  }

  // (7) One shared batch id, existing format, minted once for this call.
  const batchId = createClosetBatchId();

  // (8) Per-crop deterministic lineage, preserving input order as the
  // eventual batchPosition. createClosetCandidateBatch assigns batchPosition
  // from array index, so the order supplied here IS the picker order.
  const assets = await Promise.all(
    crops.map(async (crop) => ({
      uri: typeof crop?.cropUri === 'string' ? crop.cropUri.trim() : '',
      // Reuses the existing per-asset id field; createClosetCandidateBatch
      // already threads `asset.assetId` into each candidate's `sourceId`.
      assetId: crop.cropKey,
      sourceLineageId: await deriveMirrorSourceLineageId(extractionSessionId, crop.cropKey),
    })),
  );

  // (9) Delegate creation entirely. Media derivation, storage preflight,
  // content hashing, exact duplicate detection, actor revalidation, candidate
  // persistence and the unresolved-candidate cap all remain owned by
  // createClosetCandidateBatch / createClosetCandidate.
  const batchResult = await createClosetCandidateBatch(actorRequest, {
    assets,
    sourceType: 'mirror_extract',
    batchId,
  });

  const capacityRejected = new Set<number>(batchResult.rejectedForCapacityIndexes ?? []);
  const outcomes: MirrorCropStageOutcome[] = crops.map((crop, index) => {
    const found = (batchResult.sourceOutcomes ?? []).find(
      (entry: { sourceIndex: number }) => entry.sourceIndex === index,
    );
    if (found) {
      const outcome: MirrorCropStageOutcome = {
        cropKey: crop.cropKey,
        batchPosition: index,
        outcome: found.kind,
      };
      if (found.candidateId) outcome.candidateId = found.candidateId;
      if (found.code) outcome.errorCode = found.code;
      return outcome;
    }
    // Never reached createClosetCandidate at all: either the global
    // unresolved-candidate cap rejected it, or the actor went stale partway
    // through the batch and the existing loop stopped early. Both are
    // reported truthfully with the EXISTING codes that already mean them.
    return {
      cropKey: crop.cropKey,
      batchPosition: index,
      outcome: 'rejected',
      errorCode: capacityRejected.has(index) ? 'candidate_limit_reached' : 'candidate_actor_stale',
    };
  });

  const createdCount = outcomes.filter((o) => o.outcome === 'created').length;
  const duplicateCount = outcomes.filter(
    (o) =>
      o.outcome === 'deduped_candidate' ||
      o.outcome === 'duplicate_of_closet' ||
      o.outcome === 'already_in_closet',
  ).length;
  const rejectedCount = outcomes.filter((o) => o.outcome === 'rejected').length;

  emitStaged({
    cropCount: crops.length,
    createdCount,
    duplicateCount,
    rejectedCount,
    batchLimitReached: capacityRejected.size > 0,
    outcome: batchResult.kind,
  });

  return { kind: 'ok', batchId: batchResult.batchId, outcomes };
}
