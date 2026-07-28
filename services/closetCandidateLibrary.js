/**
 * K Scan Closet CANDIDATE store — durable, actor-scoped, device-local staging.
 *
 * THE INVARIANT THIS MODULE EXISTS TO PROTECT:
 *
 *     ClosetCandidate record  !=  committed Closet item
 *
 * services/closetLibrary.js remains the ONLY authority for owned inventory. This
 * is a sibling store with its own manifest and its own disjoint media roots:
 *
 *   kscan_closet/            kscan_closet.json             committed  (untouched)
 *   kscan_closet_candidates/ kscan_closet_candidates.json  staged     (here)
 *
 * It deliberately reuses the proven closetLibrary.js persistence principles —
 * explicit allowlist construction, full-array atomic replacement, one serialized
 * mutation queue, pre-write validation, post-media-write actor revalidation,
 * reference-aware media cleanup, fail-safe reads — rather than inventing a second
 * persistence style. The audit's earlier per-key AsyncStorage suggestion does not
 * apply: the authoritative Closet implementation is file-backed, and a staging
 * layer on a different substrate would need its own atomicity and its own
 * corruption story.
 *
 * Build 1 exposes single-candidate intake only. The batch APIs exist because
 * every record already carries a batchId and Build 2's review surface needs to
 * address a batch — not because Build 1 has a batch picker.
 */

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { resolveWriteAuthority, isActorRequestCurrent } from './actorContext';
import { loadCloset, findClosetItemByLineage } from './closetLibrary';
import {
  CLOSET_CANDIDATE_MAX_UNRESOLVED,
  CLOSET_CANDIDATE_MAX_INTERRUPTIONS,
  CLOSET_CANDIDATE_TTL_MS,
} from '../types/closetCandidate';
import {
  buildClosetCandidateRecord,
  createClosetCandidateId,
  createClosetBatchId,
  migrateClosetCandidateRecord,
  normalizeManualClassificationInput,
} from './closetCandidateSchema';
import {
  evaluateTransition,
  isUnresolvedStatus,
  isLegalInitialStatus,
} from './closetCandidateStateMachine';
import {
  CANDIDATE_DIR,
  CANDIDATE_MANIFEST_PATH,
  CANDIDATE_MANIFEST_TEMP_PATH,
  CANDIDATE_MANIFEST_BACKUP_PATH,
  preflightCandidateStorage,
  deriveCandidateMedia,
  computeCandidateContentHash,
  unlinkUnreferencedCandidateMedia,
  sweepOrphanedCandidateMedia,
} from './closetCandidateMedia';
import { emitClosetCandidateEvent } from './closetTelemetry';

/**
 * Fields a caller may NEVER patch.
 *
 * Ownership, identity, lineage, media, lifetime and the attempt ledger are set by
 * this module from resolved authority and from what actually happened. A patch
 * that could move `ownerId` is a cross-actor write; one that could move
 * `expiresAt` or `createdAt` is an expiry bypass; one that could move
 * `interruptionCount` defeats the crash-loop brake.
 */
export const CLOSET_CANDIDATE_PROTECTED_FIELDS = Object.freeze([
  'schemaVersion',
  'candidateId',
  'batchId',
  'batchPosition',
  'ownerId',
  'candidateImageUri',
  'candidateThumbnailUri',
  'originalImageUri',
  'contentHash',
  'contentHashVersion',
  'normalizedByteLength',
  'sourceType',
  'sourceLineageId',
  'createdAt',
  'expiresAt',
  'attemptCount',
  'automaticRetryCount',
  'interruptionCount',
  'status',
  // The promotion tombstone. Writable ONLY by finalizeClosetCandidatePromotion,
  // from a committed Closet item it has already read back. A component that
  // could set these could claim an item was promoted that never was.
  'promotedClosetItemId',
  'promotedAt',
]);

/** Fields the classification orchestrator and manual entry may write. */
const PATCHABLE_FIELDS = Object.freeze([
  'title',
  'brand',
  'category',
  'clothingType',
  'subtype',
  'primaryColor',
  'secondaryColors',
  'material',
  'size',
  'notes',
  'confidence',
  'classificationVersion',
  'duplicateMatch',
  'errorCode',
  'lastAttemptAt',
  'sourceId',
]);

let candidateMutationQueue = Promise.resolve();

// ── Internal helpers ─────────────────────────────────────────────────────────

function enqueue(operation) {
  const result = candidateMutationQueue.then(operation, operation);
  candidateMutationQueue = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * Atomically replace the manifest.
 *
 * WHY NOT A DIRECT WRITE: `writeAsStringAsync` onto the canonical path truncates
 * first and streams second. A force-kill, a full disk or a killed process in that
 * window leaves a half-written manifest, and the read path's fail-to-empty then
 * reports every candidate as gone.
 *
 * The sequence is write-verify-swap, and it never leaves the store with no
 * manifest at all:
 *
 *   1. discard any stale temp from an earlier interrupted write
 *   2. write the replacement BESIDE the canonical file
 *   3. read it back and compare — an unverified replacement is never swapped in
 *   4. move the current manifest aside to `.bak` (still the last valid manifest)
 *   5. move the verified replacement into place
 *   6. drop the backup
 *
 * A crash between 4 and 5 is the one window that leaves no canonical manifest,
 * and `recoverManifestFromBackup` closes it on the next read.
 */
async function persistCandidates(records) {
  await FileSystem.makeDirectoryAsync(CANDIDATE_DIR, { intermediates: true }).catch(
    () => null,
  );
  const payload = JSON.stringify(records);

  await FileSystem.deleteAsync(CANDIDATE_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
    () => null,
  );
  await FileSystem.writeAsStringAsync(CANDIDATE_MANIFEST_TEMP_PATH, payload, {
    encoding: FileSystem.EncodingType.UTF8,
  });

  // Durability gate. A truncated or unreadable temp file must never replace a
  // good manifest, so the swap only happens if the bytes read back match.
  let verified = null;
  try {
    verified = await FileSystem.readAsStringAsync(CANDIDATE_MANIFEST_TEMP_PATH, {
      encoding: FileSystem.EncodingType.UTF8,
    });
  } catch {
    verified = null;
  }
  if (verified !== payload) {
    await FileSystem.deleteAsync(CANDIDATE_MANIFEST_TEMP_PATH, { idempotent: true }).catch(
      () => null,
    );
    const error = new Error('closet_candidate_manifest_unverified');
    error.code = 'candidate_persist_failed';
    throw error;
  }

  const existing = await FileSystem.getInfoAsync(CANDIDATE_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (existing?.exists) {
    await FileSystem.deleteAsync(CANDIDATE_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
      () => null,
    );
    await FileSystem.moveAsync({
      from: CANDIDATE_MANIFEST_PATH,
      to: CANDIDATE_MANIFEST_BACKUP_PATH,
    });
  }

  try {
    await FileSystem.moveAsync({
      from: CANDIDATE_MANIFEST_TEMP_PATH,
      to: CANDIDATE_MANIFEST_PATH,
    });
  } catch (error) {
    // Put the last valid manifest back rather than leaving the store empty.
    const backup = await FileSystem.getInfoAsync(CANDIDATE_MANIFEST_BACKUP_PATH).catch(
      () => ({ exists: false }),
    );
    if (backup?.exists) {
      await FileSystem.moveAsync({
        from: CANDIDATE_MANIFEST_BACKUP_PATH,
        to: CANDIDATE_MANIFEST_PATH,
      }).catch(() => null);
    }
    throw error;
  }

  await FileSystem.deleteAsync(CANDIDATE_MANIFEST_BACKUP_PATH, { idempotent: true }).catch(
    () => null,
  );
}

/**
 * Close the crash window inside `persistCandidates`: the manifest was moved aside
 * but the replacement had not landed yet. The backup IS the last valid manifest,
 * so it is restored rather than discarded.
 */
async function recoverManifestFromBackup() {
  const canonical = await FileSystem.getInfoAsync(CANDIDATE_MANIFEST_PATH).catch(() => ({
    exists: false,
  }));
  if (canonical?.exists) return false;
  const backup = await FileSystem.getInfoAsync(CANDIDATE_MANIFEST_BACKUP_PATH).catch(() => ({
    exists: false,
  }));
  if (!backup?.exists) return false;
  try {
    await FileSystem.moveAsync({
      from: CANDIDATE_MANIFEST_BACKUP_PATH,
      to: CANDIDATE_MANIFEST_PATH,
    });
    emitClosetCandidateEvent('closet_candidate_store_recovered', {
      errorCode: 'candidate_store_recovery_required',
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the complete manifest across EVERY actor partition.
 *
 * A record that fails migration is SKIPPED, not dropped from disk and not
 * repaired: a corrupt or future-version entry must never block the rest of the
 * store from loading, and must never be silently deleted on a read path.
 *
 * `corrupt` and `skipped` are not diagnostics — they are a WRITE INTERLOCK.
 * `readCandidatesForMutation` refuses to hand a reduced record set to a writer,
 * because persisting it is exactly what would delete the entries this read could
 * not interpret.
 */
async function readAllCandidates() {
  await recoverManifestFromBackup();
  const info = await FileSystem.getInfoAsync(CANDIDATE_MANIFEST_PATH);
  if (!info.exists) return { records: [], skipped: 0, raw: [] };

  let parsed;
  try {
    parsed = JSON.parse(await FileSystem.readAsStringAsync(CANDIDATE_MANIFEST_PATH));
  } catch {
    // A manifest we cannot parse is reported as empty rather than truncated to
    // zero on disk. Overwriting it here would destroy every candidate over a
    // transient read fault.
    return { records: [], skipped: 0, raw: [], corrupt: true };
  }
  if (!Array.isArray(parsed)) return { records: [], skipped: 0, raw: [], corrupt: true };

  const records = [];
  let skipped = 0;
  let futureSchema = 0;
  for (const entry of parsed) {
    const migrated = migrateClosetCandidateRecord(entry);
    if (migrated.ok) {
      records.push(migrated.record);
      continue;
    }
    skipped += 1;
    if (migrated.errorCode === 'candidate_store_future_schema') futureSchema += 1;
  }
  if (skipped > 0) {
    emitClosetCandidateEvent('closet_candidate_cleanup_failed', {
      errorCode: futureSchema > 0 ? 'candidate_store_future_schema' : 'candidate_store_corrupt',
      countBucket: bucketCount(skipped),
    });
  }
  return { records, skipped, raw: parsed, futureSchema };
}

/**
 * The mutation-side read. Fails closed whenever the manifest could not be read
 * completely, so no writer can rewrite the file from a partial view of it.
 *
 * Reads (list/get) deliberately do NOT use this: showing the user the candidates
 * that ARE readable is correct, and is not destructive.
 */
async function readCandidatesForMutation() {
  const state = await readAllCandidates();
  if (state.corrupt) {
    return { ok: false, errorCode: 'candidate_store_recovery_required' };
  }
  if ((state.skipped ?? 0) > 0) {
    return {
      ok: false,
      errorCode:
        (state.futureSchema ?? 0) > 0
          ? 'candidate_store_future_schema'
          : 'candidate_store_recovery_required',
    };
  }
  return { ok: true, records: state.records };
}

function isVisibleToActor(record, actorId) {
  if (actorId === undefined) return true;
  const ownerId =
    typeof record.ownerId === 'string' && record.ownerId.trim() ? record.ownerId : null;
  if (actorId === null) return ownerId === null;
  return ownerId === actorId;
}

function isExpired(record, nowMs) {
  const at = Date.parse(record?.expiresAt ?? '');
  if (!Number.isFinite(at)) return true;
  return at <= nowMs;
}

function bucketCount(count) {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 5) return '4-5';
  if (count <= 10) return '6-10';
  return '11+';
}

/**
 * Resolve write authority AND apply the Android platform divergence.
 *
 * Mirrors services/closetLibrary.js#createClosetItem and services/library.js:
 * Android has never supported signed-out durable writes, so an ownerless write is
 * rejected here rather than downgraded. iOS keeps its durable ownerless partition.
 */
function resolveCandidateAuthority(actorRequest, declaredOwnerId) {
  const authority = resolveWriteAuthority(actorRequest, declaredOwnerId);
  if (!authority.ok) {
    return {
      ok: false,
      errorCode:
        authority.reason === 'missing_actor_context'
          ? 'candidate_actor_required'
          : 'candidate_actor_stale',
    };
  }
  if (Platform.OS === 'android' && authority.ownerId === null) {
    return { ok: false, errorCode: 'candidate_actor_required' };
  }
  return { ok: true, ownerId: authority.ownerId };
}

async function cleanupCandidateMedia(paths) {
  const wanted = paths.filter(Boolean);
  if (wanted.length === 0) return [];
  try {
    // Deleting against a PARTIAL reference set could unlink media that a record
    // we failed to read still owns. A leak is recoverable; a wrong delete is not.
    const state = await readCandidatesForMutation();
    if (!state.ok) return wanted;
    return await unlinkUnreferencedCandidateMedia(wanted, state.records);
  } catch {
    return wanted;
  }
}

// ── Reads ────────────────────────────────────────────────────────────────────

/**
 * Candidates for the captured actor, newest first.
 *
 * Expired records are EXCLUDED here as well as swept by cleanup. Filtering on
 * read is what guarantees an expired candidate cannot classify, retry, save, or
 * reappear as active even if a cleanup pass has not run yet.
 */
export async function listClosetCandidates(actorRequest, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, undefined);
  if (!authority.ok) return { ok: false, errorCode: authority.errorCode, candidates: [] };
  try {
    await candidateMutationQueue;
    const nowMs = options.nowMs ?? Date.now();
    const { records } = await readAllCandidates();
    const candidates = records
      .filter(
        (record) => isVisibleToActor(record, authority.ownerId) && !isExpired(record, nowMs),
      )
      .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')));
    return { ok: true, candidates };
  } catch {
    return { ok: false, errorCode: 'candidate_store_corrupt', candidates: [] };
  }
}

export async function getClosetCandidate(actorRequest, candidateId, options = {}) {
  const result = await listClosetCandidates(actorRequest, options);
  if (!result.ok) return { ok: false, errorCode: result.errorCode };
  const candidate = result.candidates.find((entry) => entry.candidateId === candidateId);
  if (!candidate) return { ok: false, errorCode: 'candidate_store_corrupt' };
  return { ok: true, candidate };
}

/** Candidates in one intake batch. Build 2's review surface addresses a batch. */
export async function listClosetCandidatesByBatch(actorRequest, batchId, options = {}) {
  const result = await listClosetCandidates(actorRequest, options);
  if (!result.ok) return result;
  return {
    ok: true,
    candidates: result.candidates.filter((entry) => entry.batchId === batchId),
  };
}

// ── Duplicate detection ──────────────────────────────────────────────────────

/**
 * Exact-signature equality for the active-candidate collision check.
 *
 * ALL FOUR components must match. A digest match with a DIFFERENT byte length is
 * not a duplicate — it is an inconsistency, and it is handled by the caller as a
 * fail-closed suspicious state rather than by deduplicating on the digest alone.
 */
function sameExactSignature(a, b) {
  if (!a?.contentHash || !b?.contentHash) return false;
  if (a.contentHashVersion !== b.contentHashVersion) return false;
  if (a.contentHash !== b.contentHash) return false;
  return a.normalizedByteLength === b.normalizedByteLength;
}

/** A digest match whose byte length disagrees. Never used to delete anything. */
function isSuspiciousHashCollision(a, b) {
  return (
    !!a?.contentHash &&
    !!b?.contentHash &&
    a.contentHashVersion === b.contentHashVersion &&
    a.contentHash === b.contentHash &&
    a.normalizedByteLength !== b.normalizedByteLength
  );
}

// ── Create ───────────────────────────────────────────────────────────────────

/**
 * Stage one candidate.
 *
 * STRING-DISCRIMINATED RESULT rather than a boolean `ok`: creation has five
 * genuinely different successful-or-not outcomes and the caller has to tell them
 * apart to show the right thing. `duplicate_active_candidate` and
 * `already_in_closet` are not failures — they are correct, idempotent answers.
 *
 *   { kind: 'created',              candidate }
 *   { kind: 'deduped_candidate',    candidate, code: 'duplicate_active_candidate' }
 *   { kind: 'already_in_closet',    closetItemId, code: 'already_in_closet' }
 *   { kind: 'duplicate_of_closet',  candidate, code: 'already_in_closet' }
 *   { kind: 'rejected',             code }
 */
export async function createClosetCandidate(actorRequest, input = {}) {
  const pre = resolveCandidateAuthority(actorRequest, input.ownerId);
  if (!pre.ok) return { kind: 'rejected', code: pre.errorCode };

  const sourceUri = typeof input.sourceUri === 'string' ? input.sourceUri.trim() : '';
  if (!sourceUri) return { kind: 'rejected', code: 'candidate_media_unreadable' };

  const nowMs = input.nowMs ?? Date.now();

  // (1) Committed-Closet lineage idempotency, BEFORE any media work. A source
  // already promoted to the Closet must resolve to that item rather than spend a
  // media write and an identification unit re-staging it.
  const lineage =
    typeof input.sourceLineageId === 'string' && input.sourceLineageId.trim()
      ? input.sourceLineageId.trim()
      : null;
  if (lineage) {
    const committed = await findClosetItemByLineage(lineage, pre.ownerId);
    if (committed) {
      return { kind: 'already_in_closet', closetItemId: committed.id, code: 'already_in_closet' };
    }
  }

  // (2) Unresolved cap, checked cheaply here and again inside the serialized
  // section. Nothing is evicted: intake is refused instead.
  const existingList = await listClosetCandidates(actorRequest, { nowMs });
  if (!existingList.ok) return { kind: 'rejected', code: existingList.errorCode };
  const unresolvedCount = existingList.candidates.filter((entry) =>
    isUnresolvedStatus(entry.status),
  ).length;
  if (unresolvedCount >= CLOSET_CANDIDATE_MAX_UNRESOLVED) {
    return { kind: 'rejected', code: 'candidate_limit_reached' };
  }

  // (3) Storage preflight before we decode anything.
  const preflight = await preflightCandidateStorage(sourceUri);
  if (!preflight.ok) return { kind: 'rejected', code: preflight.errorCode };

  let imageUri = null;
  let thumbnailUri = null;

  try {
    const media = await deriveCandidateMedia(sourceUri);
    if (!media.ok) return { kind: 'rejected', code: media.errorCode };
    imageUri = media.imageUri;
    thumbnailUri = media.thumbnailUri;

    const hashed = await computeCandidateContentHash(imageUri);
    if (!hashed.ok) {
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      return { kind: 'rejected', code: hashed.errorCode };
    }

    // (4) Re-validate AFTER the async media work. The actor may have changed
    // while bytes were being written; a stale authenticated write is rejected
    // outright and is never downgraded into the ownerless partition.
    const post = resolveCandidateAuthority(actorRequest, input.ownerId);
    if (!post.ok) {
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      return { kind: 'rejected', code: post.errorCode };
    }

    const signature = {
      contentHash: hashed.contentHash,
      contentHashVersion: hashed.contentHashVersion,
      normalizedByteLength: hashed.normalizedByteLength,
    };

    // (5) Committed-Closet EXACT HASH collision. Existing Closet items generally
    // carry no hash today (Build 1 does not migrate the committed schema), so
    // this is normally inert — but when a hash IS present the candidate is staged
    // in `duplicate` and is NEVER classified automatically.
    const committedItems = await loadCloset(post.ownerId).catch(() => []);
    let closetHashMatch = null;
    let suspiciousCollisionSeen = false;
    for (const item of committedItems) {
      if (isSuspiciousHashCollision(item, signature)) {
        // FAIL CLOSED on THIS item only. A digest match with a disagreeing byte
        // length is not evidence of sameness; treating it as one would risk
        // suppressing a genuinely different garment. But one inconsistent item
        // must not end the scan — a genuine exact match later in the Closet is
        // still a genuine exact match. The user's source media is untouched.
        suspiciousCollisionSeen = true;
        continue;
      }
      if (sameExactSignature(item, signature)) {
        closetHashMatch = item;
        break;
      }
    }
    if (suspiciousCollisionSeen) {
      emitClosetCandidateEvent('closet_candidate_duplicate_detected', {
        algorithmVersion: signature.contentHashVersion,
        outcome: 'suspicious_signature_mismatch',
        scope: 'committed_closet',
      });
    }

    const record = buildClosetCandidateRecord(
      {
        sourceType: input.sourceType,
        sourceId: input.sourceId,
        sourceLineageId: lineage,
        // Picker and camera URIs are ephemeral external inputs. Only verified
        // candidate-owned derivatives may become durable references.
        originalImageUri: null,
        candidateImageUri: imageUri,
        candidateThumbnailUri: thumbnailUri,
        title: input.draft?.title,
        notes: input.draft?.notes,
        ...signature,
        status: closetHashMatch ? 'duplicate' : 'queued',
        ...(closetHashMatch
          ? {
            duplicateMatch: {
              closetItemId: closetHashMatch.id,
              confidence: 1,
              reasons: ['exact_normalized_bytes'],
              algorithmVersion: signature.contentHashVersion,
            },
          }
          : {}),
      },
      post.ownerId,
      new Date(nowMs).toISOString(),
      {
        candidateId: createClosetCandidateId(),
        batchId: input.batchId || createClosetBatchId(),
        batchPosition: input.batchPosition,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + CLOSET_CANDIDATE_TTL_MS).toISOString(),
        updatedAt: new Date(nowMs).toISOString(),
      },
    );

    // A record must be born in a legal initial status or the state machine has
    // been bypassed before it ever ran.
    if (!isLegalInitialStatus(record.status)) {
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      return { kind: 'rejected', code: 'candidate_invalid_transition' };
    }

    const committed = await enqueue(async () => {
      // Last-moment actor check inside the serialized section.
      if (!isActorRequestCurrent(actorRequest)) return { outcome: 'stale' };

      const readState = await readCandidatesForMutation();
      if (!readState.ok) {
        return { outcome: 'store_unreadable', errorCode: readState.errorCode };
      }
      const records = readState.records;

      // (6) ACTIVE-CANDIDATE collision, re-checked here because another intake
      // for the same photo may have committed while this one wrote media.
      for (const entry of records) {
        if (!isVisibleToActor(entry, record.ownerId)) continue;
        if (!isUnresolvedStatus(entry.status)) continue;
        if (isExpired(entry, nowMs)) continue;
        if (isSuspiciousHashCollision(entry, signature)) {
          emitClosetCandidateEvent('closet_candidate_duplicate_detected', {
            algorithmVersion: signature.contentHashVersion,
            outcome: 'suspicious_signature_mismatch',
            scope: 'active_candidate',
          });
          continue;
        }
        if (sameExactSignature(entry, signature)) {
          return { outcome: 'deduped', candidate: entry };
        }
      }

      const unresolvedNow = records.filter(
        (entry) =>
          isVisibleToActor(entry, record.ownerId) &&
          isUnresolvedStatus(entry.status) &&
          !isExpired(entry, nowMs),
      ).length;
      if (unresolvedNow >= CLOSET_CANDIDATE_MAX_UNRESOLVED) {
        return { outcome: 'limit' };
      }

      await persistCandidates([record, ...records]);
      return { outcome: 'created', candidate: record };
    });

    if (committed.outcome === 'stale') {
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      return { kind: 'rejected', code: 'candidate_actor_stale' };
    }
    if (committed.outcome === 'limit') {
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      return { kind: 'rejected', code: 'candidate_limit_reached' };
    }
    if (committed.outcome === 'store_unreadable') {
      // Nothing was written. This attempt's own media is the only thing to undo,
      // and `cleanupCandidateMedia` is itself interlocked against a partial read.
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      return { kind: 'rejected', code: committed.errorCode };
    }
    if (committed.outcome === 'deduped') {
      // The redundant media this attempt created is dropped. The survivor's own
      // media is protected by the reference-aware scan.
      await cleanupCandidateMedia([imageUri, thumbnailUri]);
      emitClosetCandidateEvent('closet_candidate_duplicate_detected', {
        algorithmVersion: signature.contentHashVersion,
        outcome: 'deduped',
        scope: 'active_candidate',
      });
      return {
        kind: 'deduped_candidate',
        candidate: committed.candidate,
        code: 'duplicate_active_candidate',
      };
    }

    emitClosetCandidateEvent('closet_candidate_created', {
      sourceType: record.sourceType,
      status: record.status,
    });
    emitClosetCandidateEvent('closet_candidate_media_prepared', {
      hasThumbnail: !!thumbnailUri,
      freeSpaceKnown: preflight.freeSpaceKnown === true,
    });

    if (closetHashMatch) {
      emitClosetCandidateEvent('closet_candidate_duplicate_detected', {
        algorithmVersion: signature.contentHashVersion,
        outcome: 'needs_review',
        scope: 'committed_closet',
      });
      return {
        kind: 'duplicate_of_closet',
        candidate: committed.candidate,
        code: 'already_in_closet',
      };
    }

    return { kind: 'created', candidate: committed.candidate };
  } catch {
    await cleanupCandidateMedia([imageUri, thumbnailUri]);
    return { kind: 'rejected', code: 'candidate_persist_failed' };
  }
}

// ── Mutations ────────────────────────────────────────────────────────────────

/**
 * Apply one serialized, actor-validated mutation to a single candidate.
 *
 * `mutate(record)` returns the NEXT record or a `{ errorCode }` rejection. Every
 * mutation in this module funnels through here, which is what guarantees they all
 * share the same epoch check, the same visibility scope, the same expiry rule and
 * the same protected-field handling.
 */
/** Maximum gallery assets accepted by a Build 2 intake operation. */
export const CLOSET_CANDIDATE_BATCH_MAX_ITEMS = 8;

/**
 * Creates a picker-ordered batch without making it all-or-nothing. Each
 * candidate is durable independently, so a later source failure cannot erase
 * an already acknowledged candidate.
 */
export async function createClosetCandidateBatch(actorRequest, input = {}) {
  const authority = resolveCandidateAuthority(actorRequest, input.ownerId);
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const selectedCount = assets.length;
  const batchId = typeof input.batchId === 'string' && input.batchId.trim()
    ? input.batchId.trim()
    : createClosetBatchId();
  const emptyOutcome = (code) => ({
    kind: 'rejected',
    code,
    batchId,
    selectedCount,
    acceptedCount: 0,
    acceptedForCapacityCount: 0,
    rejectedForCapacityCount: 0,
    rejectedForCapacityIndexes: [],
    failedSourceIndexes: [],
    createdCandidateIds: [],
    createdSourceIndexes: [],
    duplicateSourceIndexes: [],
    sourceOutcomes: [],
  });

  if (!authority.ok) return emptyOutcome(authority.errorCode);
  if (selectedCount < 1 || selectedCount > CLOSET_CANDIDATE_BATCH_MAX_ITEMS) {
    return emptyOutcome('candidate_batch_limit_exceeded');
  }

  const nowMs = input.nowMs ?? Date.now();
  const existing = await listClosetCandidates(actorRequest, { nowMs });
  if (!existing.ok) return emptyOutcome(existing.errorCode);

  const unresolvedCount = existing.candidates.filter((entry) => isUnresolvedStatus(entry.status)).length;
  const acceptedCount = Math.min(
    selectedCount,
    Math.max(0, CLOSET_CANDIDATE_MAX_UNRESOLVED - unresolvedCount),
  );
  const rejectedForCapacityIndexes = Array.from(
    { length: selectedCount - acceptedCount },
    (_, offset) => acceptedCount + offset,
  );
  const createdCandidateIds = [];
  const createdSourceIndexes = [];
  const duplicateSourceIndexes = [];
  const failedSourceIndexes = [];
  const sourceOutcomes = [];

  // Only this deterministic picker-order prefix touches media. The rejected
  // suffix is never stat'ed, normalized, hashed, classified, or persisted.
  for (let sourceIndex = 0; sourceIndex < acceptedCount; sourceIndex += 1) {
    const asset = assets[sourceIndex];
    const sourceUri = typeof asset?.uri === 'string' ? asset.uri.trim() : '';
    const result = await createClosetCandidate(actorRequest, {
      sourceUri,
      sourceType: input.sourceType,
      sourceId: typeof asset?.assetId === 'string' ? asset.assetId : input.sourceId,
      sourceLineageId: input.sourceLineageId,
      batchId,
      batchPosition: sourceIndex,
      draft: input.draft,
      ownerId: authority.ownerId,
      nowMs,
    });
    const candidateId = result.candidate?.candidateId ?? null;
    sourceOutcomes.push({ sourceIndex, kind: result.kind, code: result.code ?? null, candidateId });
    if (result.kind === 'created' && candidateId) {
      createdCandidateIds.push(candidateId);
      createdSourceIndexes.push(sourceIndex);
      // The manifest has already been durably replaced by createClosetCandidate.
      // Notification failures must never turn an acknowledged candidate back
      // into an intake failure, so the queue handoff remains best-effort.
      if (typeof input.onCandidateCreated === 'function') {
        await Promise.resolve(input.onCandidateCreated(result.candidate)).catch(() => null);
      }
    }
    if (result.kind === 'deduped_candidate' || result.kind === 'duplicate_of_closet') {
      duplicateSourceIndexes.push(sourceIndex);
    }
    if (result.kind === 'rejected') failedSourceIndexes.push(sourceIndex);
    if (!isActorRequestCurrent(actorRequest)) break;
  }

  return {
    kind: failedSourceIndexes.length || rejectedForCapacityIndexes.length ? 'partial' : 'created',
    batchId,
    selectedCount,
    acceptedCount,
    acceptedForCapacityCount: acceptedCount,
    rejectedForCapacityCount: rejectedForCapacityIndexes.length,
    rejectedForCapacityIndexes,
    failedSourceIndexes,
    createdCandidateIds,
    createdSourceIndexes,
    duplicateSourceIndexes,
    sourceOutcomes,
  };
}

async function mutateCandidate(actorRequest, candidateId, mutate, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, options.ownerId);
  if (!authority.ok) return { ok: false, errorCode: authority.errorCode };

  const nowMs = options.nowMs ?? Date.now();
  try {
    return await enqueue(async () => {
      if (!isActorRequestCurrent(actorRequest)) {
        return { ok: false, errorCode: 'candidate_actor_stale' };
      }
      const readState = await readCandidatesForMutation();
      if (!readState.ok) return { ok: false, errorCode: readState.errorCode };
      const records = readState.records;
      const index = records.findIndex(
        (entry) =>
          entry.candidateId === candidateId && isVisibleToActor(entry, authority.ownerId),
      );
      if (index === -1) return { ok: false, errorCode: 'candidate_store_corrupt' };

      const current = records[index];
      if (!options.allowExpired && isExpired(current, nowMs)) {
        return { ok: false, errorCode: 'candidate_expired' };
      }

      const outcome = mutate(current, nowMs);
      if (outcome?.errorCode) return { ok: false, errorCode: outcome.errorCode };

      const next = outcome.record;
      // Ownership is never taken from a mutation. Re-asserted rather than trusted.
      next.ownerId = current.ownerId;
      next.candidateId = current.candidateId;
      next.batchId = current.batchId;
      next.batchPosition = current.batchPosition;
      next.createdAt = current.createdAt;
      next.expiresAt = current.expiresAt;
      next.updatedAt = new Date(nowMs).toISOString();

      const updated = records.slice();
      updated[index] = next;
      await persistCandidates(updated);
      return { ok: true, candidate: next };
    });
  } catch {
    return { ok: false, errorCode: 'candidate_persist_failed' };
  }
}

/**
 * Patch approved metadata.
 *
 * A patch naming ANY protected field is REJECTED outright rather than having the
 * offending key quietly dropped. A silent drop would let a caller believe it had
 * reassigned ownership or extended expiry, and the bug would only surface later
 * as data that did not change.
 */
export async function updateClosetCandidate(actorRequest, candidateId, patch, options = {}) {
  if (patch && typeof patch === 'object' && !Array.isArray(patch)) {
    for (const field of CLOSET_CANDIDATE_PROTECTED_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(patch, field)) {
        return { ok: false, errorCode: 'candidate_invalid_transition' };
      }
    }
  }
  return mutateCandidate(
    actorRequest,
    candidateId,
    (current, nowMs) => {
      const draft = { ...current };
      for (const field of PATCHABLE_FIELDS) {
        if (patch && Object.prototype.hasOwnProperty.call(patch, field)) {
          draft[field] = patch[field];
        }
      }
      return {
        record: buildClosetCandidateRecord(draft, current.ownerId, new Date(nowMs).toISOString(), {
          candidateId: current.candidateId,
          batchId: current.batchId,
          createdAt: current.createdAt,
          expiresAt: current.expiresAt,
          updatedAt: new Date(nowMs).toISOString(),
        }),
      };
    },
    options,
  );
}

/**
 * The single status-change entry point.
 *
 * `transition` is `{ to, errorCode?, patch?, attempt?, interruption? }`. The
 * legality decision belongs to the pure state machine; this function owns only
 * the persistence of the decision and the attempt ledger.
 */
export async function transitionClosetCandidate(
  actorRequest,
  candidateId,
  transition = {},
  options = {},
) {
  return mutateCandidate(
    actorRequest,
    candidateId,
    (current, nowMs) => {
      const evaluated = evaluateTransition(current.status, transition.to);
      if (evaluated.kind !== 'ok') return { errorCode: 'candidate_invalid_transition' };

      const draft = { ...current };
      if (transition.patch && typeof transition.patch === 'object') {
        for (const field of PATCHABLE_FIELDS) {
          if (Object.prototype.hasOwnProperty.call(transition.patch, field)) {
            draft[field] = transition.patch[field];
          }
        }
      }
      draft.status = evaluated.to;
      draft.errorCode = transition.errorCode ?? null;

      if (transition.attempt === 'manual' || transition.attempt === 'automatic') {
        draft.attemptCount = (current.attemptCount ?? 0) + 1;
        draft.lastAttemptAt = new Date(nowMs).toISOString();
        // A RETRY is an attempt that is not the first. Incrementing on the first
        // automatic attempt too would spend one of the two retries before
        // anything had failed, giving 2 automatic attempts where the policy is 1
        // attempt + 2 retries = 3.
        if (transition.attempt === 'automatic' && (current.attemptCount ?? 0) >= 1) {
          draft.automaticRetryCount = (current.automaticRetryCount ?? 0) + 1;
        }
      }
      if (transition.interruption === true) {
        draft.interruptionCount = (current.interruptionCount ?? 0) + 1;
      }

      const record = buildClosetCandidateRecord(
        draft,
        current.ownerId,
        new Date(nowMs).toISOString(),
        {
          candidateId: current.candidateId,
          batchId: current.batchId,
          createdAt: current.createdAt,
          expiresAt: current.expiresAt,
          updatedAt: new Date(nowMs).toISOString(),
        },
      );
      // The allowlist builder normalizes counters; re-assert the ledger it was
      // handed so an increment can never be rounded away.
      record.attemptCount = draft.attemptCount ?? 0;
      record.automaticRetryCount = draft.automaticRetryCount ?? 0;
      record.interruptionCount = draft.interruptionCount ?? 0;
      return { record };
    },
    options,
  );
}

/**
 * Manual classification: the user supplies the taxonomy the backend could not.
 *
 * TWO AUTHORITIES, ONE SEQUENCE. The field patch is user-authored content and
 * goes through `updateClosetCandidate` (protected-field gate, allowlist rebuild);
 * the status change is a state-machine decision and goes through
 * `transitionClosetCandidate` (`needs_manual_classification → ready_for_review`
 * legality). The transition is attempted only after the patch actually
 * persisted, so a validation failure provably leaves the candidate unchanged.
 *
 * Everything the mutation funnel already guarantees applies to both steps:
 * actor-epoch revalidation, expiry enforcement, and the createdAt / expiresAt /
 * interruptionCount / retry-ledger pins. `errorCode` is cleared by the
 * transition because the record is no longer describing a failure.
 *
 * Lives in the service layer, not the hook, so it is directly executable in
 * tests — the hook is a thin caller that adds input validation for the UI.
 */
export async function manuallyClassifyClosetCandidate(
  actorRequest,
  candidateId,
  fields,
  options = {},
) {
  const normalized = normalizeManualClassificationInput(fields);
  if (!normalized.ok) return { ok: false, errorCode: normalized.errorCode };

  // Manual classification is FOR one state. Checking before the patch matters:
  // patching first and letting the transition fail would leave a queued or
  // classifying candidate carrying user-authored taxonomy it never asked for.
  // A candidate the read cannot surface (expired, missing, other actor) is NOT
  // rejected here — the mutation funnel below owns those cases and names them
  // precisely (`candidate_expired` rather than a generic not-found), and it
  // persists nothing on the way to saying so.
  const loaded = await getClosetCandidate(actorRequest, candidateId, options);
  if (loaded.ok && loaded.candidate.status !== 'needs_manual_classification') {
    return { ok: false, errorCode: 'candidate_invalid_transition' };
  }

  const patched = await updateClosetCandidate(
    actorRequest,
    candidateId,
    normalized.fields,
    options,
  );
  if (!patched.ok) return patched;

  return transitionClosetCandidate(
    actorRequest,
    candidateId,
    { to: 'ready_for_review', errorCode: null },
    options,
  );
}

/**
 * FINALIZE A PROMOTION: record that this candidate became a committed item.
 *
 * The ONE writer of the promotion tombstone. `closetItemId` is supplied by the
 * promotion coordinator from a committed Closet item it has already written AND
 * read back — never from a patch, never from a component, and never from the
 * candidate itself. That is why `promotedClosetItemId` and `promotedAt` are in
 * the protected list: no generic patch or transition can reach them.
 *
 * IDEMPOTENT. A candidate already `saved` for the SAME committed item answers ok
 * without a second transition, which is what makes the "committed write landed,
 * finalization did not" crash window repairable by simply retrying. A candidate
 * already `saved` for a DIFFERENT item is refused rather than reassigned.
 *
 * EXPIRY IS ALLOWED HERE, and only here. The committed item already exists and is
 * durable; refusing to record that fact because the candidate lapsed in the
 * meantime would leave the store permanently unable to tell the truth about it,
 * and every retry would re-enter the same unfinalizable state. Expiry is what
 * stops a lapsed candidate from BEING promoted, and that gate runs before the
 * committed write — twice.
 */
export async function finalizeClosetCandidatePromotion(
  actorRequest,
  candidateId,
  options = {},
) {
  const closetItemId =
    typeof options.closetItemId === 'string' && options.closetItemId.trim()
      ? options.closetItemId.trim().slice(0, 120)
      : null;
  if (!closetItemId) return { ok: false, errorCode: 'candidate_invalid_transition' };

  return mutateCandidate(
    actorRequest,
    candidateId,
    (current, nowMs) => {
      const stamp = new Date(nowMs).toISOString();

      if (current.status === 'saved') {
        if (current.promotedClosetItemId !== closetItemId) {
          return { errorCode: 'candidate_invalid_transition' };
        }
        // Already finalized for this exact item. Re-persisted rather than
        // special-cased out of the funnel so there is one write path, one actor
        // check and one allowlist rebuild for every finalization.
        return { record: { ...current } };
      }

      const evaluated = evaluateTransition(current.status, 'saved');
      if (evaluated.kind !== 'ok') return { errorCode: 'candidate_invalid_transition' };

      const record = buildClosetCandidateRecord(
        {
          ...current,
          status: 'saved',
          errorCode: null,
          promotedClosetItemId: closetItemId,
          // A repair keeps the ORIGINAL promotion time when one is already
          // recorded, so a retry cannot backdate or advance the moment the item
          // actually became durable.
          promotedAt: current.promotedAt ?? stamp,
        },
        current.ownerId,
        stamp,
        {
          candidateId: current.candidateId,
          batchId: current.batchId,
          batchPosition: current.batchPosition,
          createdAt: current.createdAt,
          expiresAt: current.expiresAt,
          updatedAt: stamp,
        },
      );
      // The allowlist builder normalizes counters; re-assert the ledger so a
      // promotion cannot quietly reset the attempt history.
      record.attemptCount = current.attemptCount ?? 0;
      record.automaticRetryCount = current.automaticRetryCount ?? 0;
      record.interruptionCount = current.interruptionCount ?? 0;
      return { record };
    },
    { ...options, allowExpired: true },
  );
}

/**
 * Manual retry.
 *
 * Deliberately does NOT reset createdAt, expiresAt, interruptionCount or the
 * automatic-retry ledger. Manual retry is a second chance within the candidate's
 * existing lifetime, not a new candidate wearing the old one's id.
 */
export async function retryClosetCandidate(actorRequest, candidateId, options = {}) {
  return transitionClosetCandidate(
    actorRequest,
    candidateId,
    { to: 'queued', attempt: 'manual', errorCode: null },
    options,
  );
}

export async function rejectClosetCandidate(actorRequest, candidateId, options = {}) {
  const result = await transitionClosetCandidate(
    actorRequest,
    candidateId,
    { to: 'rejected' },
    { ...options, allowExpired: true },
  );
  if (!result.ok) return result;
  const released = await releaseRejectedCandidateMedia(actorRequest, candidateId);
  return {
    ok: true,
    candidate: released.candidate ?? result.candidate,
    mediaFailures: released.mediaFailures,
  };
}

/**
 * Release the media of a rejected candidate.
 *
 * TWO THINGS IN ONE ORDERED OPERATION, and the order matters:
 *   1. persist the record with its media URIs CLEARED
 *   2. only then unlink the files
 *
 * A crash between the two leaks two files, which `sweepOrphanedClosetCandidateMedia`
 * collects on the next focus. The reverse order would leave a surviving record
 * pointing at files that no longer exist — a broken thumbnail the user sees,
 * rather than garbage they do not.
 *
 * The reference check runs against the ALREADY-CLEARED record set, which is the
 * defect this exists to avoid: passing the un-cleared set would show the rejected
 * record still referencing its own media, and nothing would ever be unlinked.
 */
async function releaseRejectedCandidateMedia(actorRequest, candidateId) {
  try {
    return await enqueue(async () => {
      const readState = await readCandidatesForMutation();
      if (!readState.ok) return { candidate: null, mediaFailures: [] };
      const records = readState.records;
      const index = records.findIndex((entry) => entry.candidateId === candidateId);
      if (index === -1) return { candidate: null, mediaFailures: [] };

      const target = records[index];
      if (target.status !== 'rejected') return { candidate: target, mediaFailures: [] };

      const doomed = [target.candidateThumbnailUri, target.candidateImageUri].filter(Boolean);
      const cleared = { ...target, candidateImageUri: null, candidateThumbnailUri: null };
      const updated = records.slice();
      updated[index] = cleared;

      await persistCandidates(updated);
      const failures = await unlinkUnreferencedCandidateMedia(doomed, updated);
      return { candidate: cleared, mediaFailures: failures };
    });
  } catch {
    return { candidate: null, mediaFailures: [] };
  }
}

/** Hard delete. Removes the record and unlinks its candidate-owned media. */
export async function deleteClosetCandidate(actorRequest, candidateId, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, options.ownerId);
  if (!authority.ok) return { ok: false, errorCode: authority.errorCode };
  try {
    return await enqueue(async () => {
      if (!isActorRequestCurrent(actorRequest)) {
        return { ok: false, errorCode: 'candidate_actor_stale' };
      }
      const readState = await readCandidatesForMutation();
      if (!readState.ok) return { ok: false, errorCode: readState.errorCode };
      const records = readState.records;
      const target = records.find(
        (entry) =>
          entry.candidateId === candidateId && isVisibleToActor(entry, authority.ownerId),
      );
      if (!target) return { ok: false, errorCode: 'candidate_store_corrupt' };
      const survivors = records.filter((entry) => entry !== target);
      const failures = await unlinkUnreferencedCandidateMedia(
        [target.candidateThumbnailUri, target.candidateImageUri],
        survivors,
      );
      await persistCandidates(survivors);
      return { ok: true, removed: 1, mediaFailures: failures };
    });
  } catch {
    return { ok: false, errorCode: 'candidate_persist_failed' };
  }
}

/** Delete every candidate in one intake batch, for the captured actor only. */
export async function deleteClosetCandidateBatch(actorRequest, batchId, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, options.ownerId);
  if (!authority.ok) return { ok: false, errorCode: authority.errorCode };
  if (typeof batchId !== 'string' || !batchId.trim()) {
    return { ok: false, errorCode: 'candidate_store_corrupt' };
  }
  try {
    return await enqueue(async () => {
      if (!isActorRequestCurrent(actorRequest)) {
        return { ok: false, errorCode: 'candidate_actor_stale' };
      }
      const readState = await readCandidatesForMutation();
      if (!readState.ok) return { ok: false, errorCode: readState.errorCode };
      const records = readState.records;
      const doomed = records.filter(
        (entry) => entry.batchId === batchId && isVisibleToActor(entry, authority.ownerId),
      );
      if (doomed.length === 0) return { ok: true, removed: 0, mediaFailures: [] };
      const survivors = records.filter((entry) => !doomed.includes(entry));
      const failures = await unlinkUnreferencedCandidateMedia(
        doomed.flatMap((entry) => [entry.candidateThumbnailUri, entry.candidateImageUri]),
        survivors,
      );
      await persistCandidates(survivors);
      return { ok: true, removed: doomed.length, mediaFailures: failures };
    });
  } catch {
    return { ok: false, errorCode: 'candidate_persist_failed' };
  }
}

// ── Sweeps ───────────────────────────────────────────────────────────────────

/**
 * Expiration sweep. Idempotent, and a failure here never prevents the committed
 * Closet — or this store — from loading.
 */
export async function cleanupExpiredClosetCandidates(actorRequest, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, options.ownerId);
  if (!authority.ok) return { ok: false, errorCode: authority.errorCode, removed: 0 };
  const nowMs = options.nowMs ?? Date.now();
  try {
    return await enqueue(async () => {
      const readState = await readCandidatesForMutation();
      if (!readState.ok) {
        return { ok: false, errorCode: readState.errorCode, removed: 0, mediaFailures: [] };
      }
      const records = readState.records;
      // Scoped to the captured actor. A sweep that removed every actor's expired
      // records would be a cross-actor write dressed as housekeeping.
      //
      // A PROMOTED TOMBSTONE IS NEVER COLLECTED HERE. The 7-day candidate clock
      // is the lifetime of an UNRESOLVED draft; a promoted record is the store's
      // only durable evidence that a committed item came from this candidate, and
      // it is what the provenance repair path, the batch projection and Phase 4's
      // media-cleanup certification all read. Retention and collection of these
      // records is a Phase 4 decision — it is deliberately NOT assumed to be the
      // same seven days.
      const doomed = records.filter(
        (entry) =>
          isVisibleToActor(entry, authority.ownerId) &&
          isExpired(entry, nowMs) &&
          entry.status !== 'saved',
      );
      if (doomed.length === 0) {
        emitClosetCandidateEvent('closet_candidate_cleanup_completed', { countBucket: '0' });
        return { ok: true, removed: 0, mediaFailures: [] };
      }
      const survivors = records.filter((entry) => !doomed.includes(entry));
      const failures = await unlinkUnreferencedCandidateMedia(
        doomed.flatMap((entry) => [entry.candidateThumbnailUri, entry.candidateImageUri]),
        survivors,
      );
      await persistCandidates(survivors);
      emitClosetCandidateEvent('closet_candidate_expired', {
        countBucket: bucketCount(doomed.length),
      });
      emitClosetCandidateEvent('closet_candidate_cleanup_completed', {
        countBucket: bucketCount(doomed.length),
        mediaFailed: failures.length > 0,
      });
      return { ok: true, removed: doomed.length, mediaFailures: failures };
    });
  } catch {
    emitClosetCandidateEvent('closet_candidate_cleanup_failed', {
      errorCode: 'candidate_cleanup_failed',
    });
    return { ok: false, errorCode: 'candidate_cleanup_failed', removed: 0 };
  }
}

/**
 * Interrupted-classification recovery, run once at controlled startup.
 *
 * A candidate still in `classifying` after a process restart did not finish — the
 * process died mid-request. First interruption requeues it. The SECOND fails it
 * permanently with `classification_interrupted_repeatedly`.
 *
 * THAT SECOND RULE IS THE CRASH-LOOP BRAKE. Without it, an image that reliably
 * kills the process is re-queued on every launch, killed again, and the app never
 * reaches a usable state. Manual retry stays available until expiration, so the
 * user is not locked out of their own candidate — the app just stops volunteering.
 */
export async function recoverInterruptedClosetCandidates(actorRequest, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, options.ownerId);
  if (!authority.ok) return { ok: false, errorCode: authority.errorCode, requeued: 0, failed: 0 };
  const nowMs = options.nowMs ?? Date.now();
  try {
    return await enqueue(async () => {
      if (!isActorRequestCurrent(actorRequest)) {
        return { ok: false, errorCode: 'candidate_actor_stale', requeued: 0, failed: 0 };
      }
      const readState = await readCandidatesForMutation();
      if (!readState.ok) {
        return { ok: false, errorCode: readState.errorCode, requeued: 0, failed: 0 };
      }
      const records = readState.records;
      let requeued = 0;
      let failed = 0;
      const updated = records.map((entry) => {
        if (!isVisibleToActor(entry, authority.ownerId)) return entry;
        if (entry.status !== 'classifying') return entry;
        if (isExpired(entry, nowMs)) return entry;

        const interruptionCount = (entry.interruptionCount ?? 0) + 1;
        const exhausted = interruptionCount >= CLOSET_CANDIDATE_MAX_INTERRUPTIONS;
        const to = exhausted ? 'failed' : 'queued';
        if (evaluateTransition(entry.status, to).kind !== 'ok') return entry;

        if (exhausted) failed += 1;
        else requeued += 1;

        return {
          ...entry,
          status: to,
          interruptionCount,
          errorCode: exhausted
            ? 'classification_interrupted_repeatedly'
            : 'classification_interrupted',
          updatedAt: new Date(nowMs).toISOString(),
        };
      });

      if (requeued === 0 && failed === 0) return { ok: true, requeued: 0, failed: 0 };
      await persistCandidates(updated);
      return { ok: true, requeued, failed };
    });
  } catch {
    return { ok: false, errorCode: 'candidate_persist_failed', requeued: 0, failed: 0 };
  }
}

/**
 * Owner-scoped purge primitive for account deletion.
 *
 * Mirrors services/closetLibrary.js#purgeLocalClosetForOwner, including being
 * DELIBERATELY UNWIRED at deletion submission: terminal purge waits for a
 * confirmed server-side purge.
 */
export async function purgeLocalClosetCandidatesForOwner(capturedOwnerId) {
  const owner =
    typeof capturedOwnerId === 'string' && capturedOwnerId.trim()
      ? capturedOwnerId.trim()
      : null;
  if (!owner) return { ok: false, removed: 0, mediaFailures: [] };
  try {
    return await enqueue(async () => {
      const readState = await readCandidatesForMutation();
      if (!readState.ok) return { ok: false, removed: 0, mediaFailures: [] };
      const records = readState.records;
      const doomed = records.filter((entry) => (entry.ownerId || null) === owner);
      if (doomed.length === 0) return { ok: true, removed: 0, mediaFailures: [] };
      const survivors = records.filter((entry) => (entry.ownerId || null) !== owner);
      const failures = await unlinkUnreferencedCandidateMedia(
        doomed.flatMap((entry) => [entry.candidateImageUri, entry.candidateThumbnailUri]),
        survivors,
      );
      await persistCandidates(survivors);
      return { ok: failures.length === 0, removed: doomed.length, mediaFailures: failures };
    });
  } catch {
    return { ok: false, removed: 0, mediaFailures: [] };
  }
}

/**
 * Collect candidate media that no surviving record references.
 *
 * The reference-driven cleanup paths can only unlink a file some record still
 * points at, so media whose record is already gone — a crash between the manifest
 * write and the unlink, an unlink failure nobody retried — is unreachable by every
 * other path. This is the only collector for it.
 *
 * Runs inside the mutation queue so it cannot observe a half-applied write, and
 * refuses to run at all on a partial read: `readCandidatesForMutation` failing
 * means some record could not be interpreted, and a sweep would treat that
 * record's media as unowned.
 */
export async function sweepOrphanedClosetCandidateMedia(actorRequest, options = {}) {
  const authority = resolveCandidateAuthority(actorRequest, options.ownerId);
  if (!authority.ok) {
    return { ok: false, errorCode: authority.errorCode, deleted: 0, failed: 0 };
  }
  try {
    return await enqueue(async () => {
      const readState = await readCandidatesForMutation();
      if (!readState.ok) {
        return { ok: false, errorCode: readState.errorCode, deleted: 0, failed: 0 };
      }
      // The reference set spans EVERY actor partition: another actor's candidate
      // media is not this actor's to collect.
      const result = await sweepOrphanedCandidateMedia(readState.records, {
        manifestComplete: true,
        nowMs: options.nowMs,
        graceMs: options.graceMs,
      });
      if (result.deleted > 0 || result.failed > 0) {
        emitClosetCandidateEvent('closet_candidate_cleanup_failed', {
          errorCode: result.failed > 0 ? 'candidate_cleanup_failed' : null,
          countBucket: bucketCount(result.deleted),
        });
      }
      return {
        ok: result.ok === true && result.failed === 0,
        skipped: result.skipped === true,
        deleted: result.deleted,
        failed: result.failed,
      };
    });
  } catch {
    return { ok: false, errorCode: 'candidate_cleanup_failed', deleted: 0, failed: 0 };
  }
}

/** Test seam only. Not used by production code. */
export const __closetCandidateInternals = {
  CANDIDATE_DIR,
  CANDIDATE_MANIFEST_PATH,
  readAllCandidates,
  readCandidatesForMutation,
  sameExactSignature,
  isSuspiciousHashCollision,
  isExpired,
  PATCHABLE_FIELDS,
};
