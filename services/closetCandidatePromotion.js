/**
 * SERIALIZED, IDEMPOTENT CANDIDATE PROMOTION (Closet Upgrade Build 2, Phase 3).
 *
 * THE ONE PLACE a staged ClosetCandidate becomes a committed Closet item.
 *
 *   selected ready candidates
 *     -> commit-time eligibility
 *     -> immutable promotion payload
 *     -> stable promotion identity (owner + candidate)
 *     -> provenance lookup in the committed Closet
 *     -> committed-media storage preflight
 *     -> committed write through services/closetLibrary.js
 *     -> read-back verification
 *     -> candidate promoted terminal state
 *     -> per-item outcome
 *
 * WHAT THIS MODULE DOES NOT DO, and each is load-bearing:
 *   - it never writes either manifest itself. The committed item is written by
 *     closetLibrary.js and the candidate tombstone by closetCandidateLibrary.js,
 *     each behind its own serialized mutation queue and its own actor check.
 *   - it never copies committed media. The stable destination is derived INSIDE
 *     the committed store from the promotion identity, so no caller — this one
 *     included — can choose a filename.
 *   - it never touches candidate media. Phase 3 leaves the candidate's own image
 *     exactly where it is; the promoted tombstone keeps referencing it, which is
 *     what keeps the orphan collector away from it until Phase 4 owns cleanup.
 *   - it never creates a Recent Scan, updates Elise, or calls anything with a
 *     retailer, price or SKU in it. The Closet carries zero commerce.
 *
 * CONCURRENCY IS ONE. Not two, which is the classification queue's cap and is
 * correct for read-only network work. Two concurrent promotions would race the
 * committed manifest, race the stable-destination reservation, and make "item 4
 * failed" mean nothing about whether item 5 had already started.
 */

import {
  createActorRequest,
  isActorRequestCurrent,
} from './actorContext';
import {
  CLOSET_ITEM_TAXONOMY_FIELDS,
  createClosetItem,
  findClosetItemBySourceCandidate,
  isAbsentClosetTaxonomyValue,
  repairClosetItemTaxonomy,
  verifyClosetItemMedia,
} from './closetLibrary';
import {
  finalizeClosetCandidatePromotion,
  getClosetCandidate,
  listClosetCandidates,
} from './closetCandidateLibrary';
import {
  isCandidateOwnedPath,
  preflightCandidateStorage,
} from './closetCandidateMedia';
import { getClosetCandidatePromotionEligibility } from './closetCandidateReviewEligibility';
import { compareClosetBatchOrder } from './closetBatchReview';
import {
  CLOSET_PROMOTION_ITEM_TIMEOUT_MS,
  closetPromotionErrorCodeForBlockedReason,
  closetPromotionStatusForBlockedReason,
} from './closetCandidatePromotionContract';

/** Promotion concurrency. Declared as a constant so a test can assert it. */
export const CLOSET_PROMOTION_MAX_CONCURRENCY = 1;

/**
 * The serialized promotion chain and the single active operation.
 *
 * Module-scoped rather than hook state for the same reason the actor context is:
 * a second mounted surface, a re-render, or an unmount must not be able to start
 * a second queue, and an unmounted screen's in-flight work must still complete
 * safely rather than being abandoned half-committed.
 */
let promotionChain = Promise.resolve();
let activeOperation = null;
let operationCounter = 0;

/** Serialize one candidate's whole promotion sequence. Never runs two at once. */
function enqueuePromotion(operation) {
  const result = promotionChain.then(operation, operation);
  promotionChain = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/**
 * The running operation, or null. Read by the surface to disable a second
 * submission and by tests to prove only one candidate is ever active.
 */
export function getActiveClosetPromotion() {
  if (!activeOperation) return null;
  return {
    operationId: activeOperation.operationId,
    actorId: activeOperation.actorId,
    actorEpoch: activeOperation.actorEpoch,
    batchId: activeOperation.batchId,
    candidateIds: [...activeOperation.candidateIds],
    activeCandidateId: activeOperation.activeCandidateId,
    completedCount: activeOperation.completedCount,
    requestedCount: activeOperation.candidateIds.length,
  };
}

// ── Payload ──────────────────────────────────────────────────────────────────

function text(value, max = 200) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function textList(value, max = 60, limit = 8) {
  if (!Array.isArray(value)) return [];
  const out = [];
  const seen = new Set();
  for (const entry of value) {
    const item = text(entry, max);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * THE CANONICAL TAXONOMY MAPPING, candidate -> committed Closet.
 *
 * One field to one field, named explicitly on both sides. The candidate is never
 * spread: a taxonomy concept that exists on a candidate and has no committed home
 * must be visible as a missing line HERE, not as a value that quietly evaporates
 * in the store's allowlist.
 *
 * ABSENT STAYS ABSENT. A missing brand is null, never "Unknown"; a missing colour
 * is never read off the material list; and nothing is ever recovered by parsing
 * the title, which is a display string and not a record of anything.
 */
export function buildClosetPromotionTaxonomy(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const category = text(candidate.category, 80);
  if (!category) return null;
  return {
    category,
    clothingType: text(candidate.clothingType, 80),
    subtype: text(candidate.subtype, 80),
    brand: text(candidate.brand, 120),
    primaryColor: text(candidate.primaryColor, 60),
    secondaryColors: textList(candidate.secondaryColors, 60, 8),
    material: textList(candidate.material, 60, 8),
    size: text(candidate.size, 40),
  };
}

/**
 * EXPLICIT ALLOWLIST MAPPER, candidate -> committed Closet draft.
 *
 * The candidate is never spread. Everything the committed record has no field for
 * is dropped here rather than carried and silently discarded by the store's own
 * allowlist, so the boundary is visible in one place.
 *
 * DELIBERATELY NOT PROMOTED: the retry ledger, the attempt counters, the expiry,
 * the actor epoch, the candidate status, the error code, the content hash, the
 * duplicate match, the classification confidence, the batch selection, and every
 * commerce field — none of which exist on a committed record and none of which
 * describe an owned garment.
 *
 * THE TITLE IS A DISPLAY LABEL, NOT STORAGE. It is still composed from brand and
 * descriptor because that is what the Closet card shows, but every part of it now
 * also exists as its own structured field. Nothing may parse it back.
 */
export function buildClosetPromotionDraft(candidate, options = {}) {
  if (!candidate || typeof candidate !== 'object') return null;
  const candidateId = text(candidate.candidateId, 120);
  if (!candidateId) return null;

  const taxonomy = buildClosetPromotionTaxonomy(candidate);
  if (!taxonomy) return null;

  const descriptor = taxonomy.subtype ?? taxonomy.clothingType ?? taxonomy.category;
  const title = [taxonomy.brand, descriptor].filter(Boolean).join(' ') || taxonomy.category;

  return {
    title,
    ...taxonomy,
    notes: text(candidate.notes, 500),
    origin: 'direct_intake',
    sourceCandidateId: candidateId,
    clientRequestId: text(options.clientRequestId, 300),
  };
}

// ── Taxonomy verification ────────────────────────────────────────────────────

function sameTaxonomyValue(expected, actual) {
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((entry, index) => actual[index] === entry);
  }
  return actual === expected;
}

/**
 * Taxonomy the payload carried that the committed record does NOT match.
 *
 * A field the payload left empty is not checked: an absent brand is a legitimate
 * outcome, and demanding equality on it would fail a promotion for the crime of
 * not knowing something.
 */
function taxonomyMismatches(item, payload) {
  const mismatched = [];
  for (const field of CLOSET_ITEM_TAXONOMY_FIELDS) {
    const expected = payload?.[field];
    if (isAbsentClosetTaxonomyValue(expected)) continue;
    if (!sameTaxonomyValue(expected, item?.[field])) mismatched.push(field);
  }
  return mismatched;
}

/**
 * Taxonomy the payload carried that the committed record is simply MISSING.
 *
 * Strictly narrower than a mismatch, and that is the point. An item promoted by
 * Phase 3 — before the committed schema could store taxonomy — is missing fields
 * and is repairable. An item whose brand the user later changed is not missing
 * anything, and a retry must leave that edit alone.
 */
function taxonomyGaps(item, payload) {
  const gaps = [];
  for (const field of CLOSET_ITEM_TAXONOMY_FIELDS) {
    const expected = payload?.[field];
    if (isAbsentClosetTaxonomyValue(expected)) continue;
    if (isAbsentClosetTaxonomyValue(item?.[field])) gaps.push(field);
  }
  return gaps;
}

// ── Per-item outcome helpers ─────────────────────────────────────────────────

function itemResult(entry, status, extra = {}) {
  return {
    candidateId: entry.candidateId,
    batchPosition: entry.batchPosition ?? null,
    status,
    committedClosetItemId: extra.committedClosetItemId ?? null,
    errorCode: extra.errorCode ?? null,
  };
}

/**
 * Committed-store rejection -> per-item outcome.
 *
 * Every branch names a registry code. A raw reason string from the store is never
 * surfaced, and an unrecognised one fails to the generic persistence code rather
 * than being passed through.
 */
function resultForCommitReason(entry, reason) {
  switch (reason) {
    case 'stale_actor_context':
    case 'missing_actor_context':
    case 'owner_mismatch':
    case 'ownerless_context_declared_owner':
      return itemResult(entry, 'actor_changed', { errorCode: 'candidate_actor_stale' });
    case 'android_requires_authenticated_actor':
      return itemResult(entry, 'ineligible', { errorCode: 'candidate_actor_required' });
    case 'missing_source_media':
      return itemResult(entry, 'missing_media', { errorCode: 'candidate_media_unreadable' });
    default:
      return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
  }
}

// ── One candidate ────────────────────────────────────────────────────────────

/**
 * Promote exactly one candidate, or explain precisely why not.
 *
 * ORDERING IS THE CONTRACT, not an implementation detail:
 *
 *   provenance BEFORE content       an already-promoted candidate must resolve to
 *                                   its own item, never be re-judged as a content
 *                                   duplicate of it
 *   preflight BEFORE the copy       a write that cannot fit must not half-happen
 *   revalidate BEFORE the write     the actor may have changed during media work
 *   read back BEFORE finalizing     the candidate is only marked promoted once the
 *                                   committed item has been read back and its
 *                                   media verified as Closet-owned and present
 *   finalize AFTER durability       so a crash between the two leaves a committed
 *                                   item and a reviewable candidate — recoverable
 *                                   — rather than a promoted candidate and nothing
 */
async function promoteOneClosetCandidate(actorRequest, entry, context) {
  const { batchId, nowMs, deadlineMs, shouldContinue } = context;

  const aborted = () => shouldContinue() !== true;
  const expired = () => typeof deadlineMs === 'number' && context.now() > deadlineMs;

  if (aborted()) return itemResult(entry, 'aborted');
  if (!isActorRequestCurrent(actorRequest)) {
    return itemResult(entry, 'actor_changed', { errorCode: 'candidate_actor_stale' });
  }

  // LOADING IS NOT JUDGING. The store's read filters expired records out, so
  // reading with the real clock would report a lapsed candidate as missing —
  // `candidate_store_corrupt` — which is both wrong and unactionable. It is read
  // with a permissive clock and judged below with the real one, so an expired
  // candidate is refused as expired and a genuinely absent one as absent.
  const loaded = await getClosetCandidate(actorRequest, entry.candidateId, { nowMs: 0 });
  if (!loaded.ok) {
    return itemResult(entry, 'ineligible', { errorCode: loaded.errorCode });
  }
  const candidate = loaded.candidate;

  if (aborted()) return itemResult(entry, 'aborted');
  if (expired()) {
    return itemResult(entry, 'failed', { errorCode: 'candidate_request_aborted' });
  }

  // ONE preflight, two answers. It stats the candidate's own media (readability,
  // which eligibility needs) and inspects free space (which the committed copy
  // needs). The storage answer is deliberately NOT acted on yet: an already
  // promoted candidate costs no space, and refusing it for a full disk would be
  // wrong.
  const preflight = await preflightCandidateStorage(candidate.candidateImageUri);
  const mediaReadable =
    preflight.ok === true || preflight.errorCode === 'candidate_storage_insufficient';

  const eligibility = getClosetCandidatePromotionEligibility(candidate, {
    actorId: actorRequest.actorId ?? null,
    batchId,
    nowMs,
    mediaOwned: isCandidateOwnedPath(candidate.candidateImageUri),
    mediaReadable,
  });
  if (!eligibility.promotable) {
    return itemResult(entry, closetPromotionStatusForBlockedReason(eligibility.blockedReason), {
      errorCode: closetPromotionErrorCodeForBlockedReason(eligibility.blockedReason),
    });
  }

  const draft = buildClosetPromotionDraft(candidate, {
    clientRequestId: actorRequest.requestId,
  });
  if (!draft) {
    return itemResult(entry, 'ineligible', { errorCode: 'candidate_invalid_transition' });
  }

  // PROVENANCE FIRST. `already_promoted` is a success, and it is the answer that
  // makes a repeated tap, a retry after a crash, and a resumed batch all resolve
  // to the same committed item.
  const promoted = await findClosetItemBySourceCandidate(
    candidate.candidateId,
    actorRequest.actorId ?? null,
  );
  if (promoted) {
    const verified = await verifyClosetItemMedia(promoted);
    if (!verified) {
      // The manifest says promoted; the bytes disagree. Finalizing on that would
      // record a promotion the Closet cannot show. Repair is Phase 4's; refusing
      // is this phase's.
      return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
    }

    // IN-PLACE TAXONOMY REPAIR for an item promoted before the committed schema
    // could carry any. Only genuinely MISSING fields are filled, so the item id,
    // its media, its provenance and anything the user has since edited are all
    // left exactly as they are — and no second item is ever created.
    const gaps = taxonomyGaps(promoted, draft);
    let current = promoted;
    if (gaps.length > 0) {
      const repair = await repairClosetItemTaxonomy(promoted.id, draft, {
        actorRequest,
        ownerId: actorRequest.actorId ?? null,
      });
      if (!repair.ok) {
        // The committed item is intact; only the backfill failed. The candidate
        // is deliberately left unfinalized so the next attempt tries again.
        return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
      }
      current = await findClosetItemBySourceCandidate(
        candidate.candidateId,
        actorRequest.actorId ?? null,
      );
      if (!current || current.id !== promoted.id || taxonomyGaps(current, draft).length > 0) {
        return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
      }
    }

    const repaired = await finalizeClosetCandidatePromotion(actorRequest, candidate.candidateId, {
      closetItemId: current.id,
      nowMs,
    });
    return itemResult(entry, 'already_promoted', {
      committedClosetItemId: current.id,
      errorCode: repaired.ok ? null : repaired.errorCode,
    });
  }

  if (aborted()) return itemResult(entry, 'aborted');

  // The storage answer, applied here rather than earlier.
  if (!preflight.ok) {
    if (preflight.errorCode === 'candidate_storage_insufficient') {
      return itemResult(entry, 'storage_failed', { errorCode: preflight.errorCode });
    }
    return itemResult(entry, 'missing_media', { errorCode: preflight.errorCode });
  }

  if (expired()) {
    return itemResult(entry, 'failed', { errorCode: 'candidate_request_aborted' });
  }
  if (!isActorRequestCurrent(actorRequest)) {
    return itemResult(entry, 'actor_changed', { errorCode: 'candidate_actor_stale' });
  }

  // THE CRITICAL SECTION BEGINS HERE. Past this point the item runs to a terminal
  // outcome: the committed store owns its own atomic write, and abandoning a
  // verified committed item without finalizing the candidate is exactly the state
  // this sequence exists to avoid.
  const committed = await createClosetItem({
    sourceUri: candidate.candidateImageUri,
    draft,
    actorRequest,
    ownerId: actorRequest.actorId ?? null,
  });
  if (!committed.ok) return resultForCommitReason(entry, committed.reason);

  // READ BACK, through the same provenance lookup a retry would use. Trusting the
  // create result alone would report success for a record no later attempt could
  // find, which is precisely the case idempotency depends on.
  const readBack = await findClosetItemBySourceCandidate(
    candidate.candidateId,
    actorRequest.actorId ?? null,
  );
  if (!readBack || readBack.id !== committed.item.id) {
    return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
  }
  if ((readBack.ownerId ?? null) !== (actorRequest.actorId ?? null)) {
    return itemResult(entry, 'actor_changed', { errorCode: 'candidate_actor_stale' });
  }
  if (!(await verifyClosetItemMedia(readBack))) {
    return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
  }
  // TAXONOMY IS VERIFIED, NOT ASSUMED. A write that stored the item but dropped
  // its subtype is a silent loss, and reporting it as a promotion is exactly how
  // this phase's defect reached production-shaped code in the first place. Every
  // field the payload actually carried must be readable back; a field the payload
  // left empty is not demanded.
  if (taxonomyMismatches(readBack, draft).length > 0) {
    return itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
  }

  const finalized = await finalizeClosetCandidatePromotion(actorRequest, candidate.candidateId, {
    closetItemId: readBack.id,
    nowMs,
  });

  // A finalization failure is NOT reported as a promotion failure. The committed
  // item exists, is owned by this actor, and its media has been verified — that is
  // the truth about the user's Closet. The candidate stays reviewable and the next
  // attempt repairs it through the provenance path above, returning
  // `already_promoted` rather than creating a second item.
  return itemResult(entry, 'promoted', {
    committedClosetItemId: readBack.id,
    errorCode: finalized.ok ? null : finalized.errorCode,
  });
}

// ── Batch coordinator ────────────────────────────────────────────────────────

function normalizeIds(candidateIds) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(candidateIds) ? candidateIds : []) {
    const id = text(raw, 120);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function emptyOperationResult(requestedCount, errorCode, extra = {}) {
  return {
    ok: false,
    operationId: null,
    batchId: extra.batchId ?? null,
    requestedCount,
    promotedCount: 0,
    alreadyPromotedCount: 0,
    failedCount: 0,
    notAttemptedCount: 0,
    results: [],
    errorCode,
    alreadyRunning: extra.alreadyRunning === true,
  };
}

/** Let React commit between candidates. Injectable so tests do not need timers. */
function defaultYield() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

/**
 * Promote the submitted selection, one candidate at a time, in batch order.
 *
 * THE SUBMITTED SNAPSHOT IS IMMUTABLE. Ids are normalized, deduplicated and
 * ordered once, at submission; a selection change afterwards cannot add to it,
 * remove from it, or reorder it. The UI is an observer of this operation, never
 * its source of truth.
 *
 * PARTIAL SUCCESS IS THE MODEL, not an error path. This is a sequence of durable
 * local operations, not a transaction: an earlier committed item is never rolled
 * back because a later one failed, because the user does own that item now.
 *
 * @param {object} input
 * @param {string|null} [input.actorId]      the actor the surface believes is live
 * @param {number|null} [input.actorEpoch]   the epoch it believes is live
 * @param {string|null} [input.batchId]      the batch the selection came from
 * @param {string[]} input.candidateIds      the submitted selection
 * @param {(progress: object) => void} [input.onProgress]
 * @param {() => boolean} [input.shouldContinue] cooperative cancellation
 */
export async function promoteSelectedClosetCandidates(input = {}) {
  const candidateIds = normalizeIds(input.candidateIds);
  const batchId = text(input.batchId, 120);

  if (candidateIds.length === 0) {
    return emptyOperationResult(0, 'candidate_invalid_transition', { batchId });
  }

  // ONE OPERATION AT A TIME, per actor context. A second submission is REFUSED,
  // not queued: queueing it would let a double tap promote the same selection
  // twice in a row, and the surface has no way to explain a second pass the user
  // did not ask for.
  if (activeOperation) {
    return emptyOperationResult(candidateIds.length, 'candidate_invalid_transition', {
      batchId,
      alreadyRunning: true,
    });
  }

  const actorRequest = createActorRequest();
  const declaredActorId = input.actorId === undefined ? undefined : text(input.actorId, 120);
  if (
    (declaredActorId !== undefined && declaredActorId !== (actorRequest.actorId ?? null)) ||
    (typeof input.actorEpoch === 'number' && input.actorEpoch !== actorRequest.epoch)
  ) {
    // The surface submitted against an actor context that is already gone.
    return emptyOperationResult(candidateIds.length, 'candidate_actor_stale', { batchId });
  }

  const now = typeof input.now === 'function' ? input.now : () => Date.now();
  const nowMs = typeof input.nowMs === 'number' ? input.nowMs : now();
  const itemTimeoutMs =
    typeof input.itemTimeoutMs === 'number' && Number.isFinite(input.itemTimeoutMs)
      ? input.itemTimeoutMs
      : CLOSET_PROMOTION_ITEM_TIMEOUT_MS;
  const yieldToUi = typeof input.yieldToUi === 'function' ? input.yieldToUi : defaultYield;
  const shouldContinue =
    typeof input.shouldContinue === 'function'
      ? () => {
        try {
          return input.shouldContinue() !== false;
        } catch {
          // A consumer whose cancellation predicate throws must not be able to
          // abandon a promotion midway; treat it as "keep going" and let the
          // actor checks remain the real gate.
          return true;
        }
      }
      : () => true;

  // Resolve batch positions ONCE, from the store, so the promotion order is the
  // review order rather than whatever order the selection set happened to be in.
  let ordered = candidateIds.map((candidateId) => ({ candidateId, batchPosition: null }));
  try {
    const listed = await listClosetCandidates(actorRequest, { nowMs });
    if (listed.ok) {
      const byId = new Map(listed.candidates.map((entry) => [entry.candidateId, entry]));
      ordered = candidateIds
        .map((candidateId) => {
          const record = byId.get(candidateId);
          return {
            candidateId,
            batchPosition: record?.batchPosition ?? null,
            createdAt: record?.createdAt ?? '',
          };
        })
        .sort(compareClosetBatchOrder);
    }
  } catch {
    // An unreadable listing costs ORDER, not correctness: every candidate is
    // still loaded, revalidated and promoted individually below.
  }

  operationCounter += 1;
  const operationId = `promo_${actorRequest.epoch}_${operationCounter}`;
  activeOperation = {
    operationId,
    actorId: actorRequest.actorId ?? null,
    actorEpoch: actorRequest.epoch,
    batchId,
    candidateIds: ordered.map((entry) => entry.candidateId),
    activeCandidateId: null,
    completedCount: 0,
  };

  const results = [];
  let promotedCount = 0;
  let alreadyPromotedCount = 0;
  let failedCount = 0;
  let notAttemptedCount = 0;
  let storageBlocked = false;
  let actorLost = false;

  const publish = async (result, activeCandidateId) => {
    results.push(result);
    activeOperation.completedCount = results.length;
    if (typeof input.onProgress !== 'function') return;
    const event = {
      operationId,
      batchId,
      requestedCount: ordered.length,
      completedCount: results.length,
      promotedCount,
      alreadyPromotedCount,
      failedCount,
      currentCandidateId: result.candidateId,
      currentBatchPosition: result.batchPosition,
      latestResult: result,
      resultsSoFar: results.slice(),
      activeCandidateId: activeCandidateId ?? null,
      done: results.length >= ordered.length,
    };
    try {
      // OBSERVATIONAL ONLY. A consumer that throws, or one that has unmounted,
      // must never be able to abort or corrupt a promotion that is mid-flight.
      await Promise.resolve(input.onProgress(event));
    } catch {
      /* progress delivery never propagates */
    }
  };

  try {
    for (let index = 0; index < ordered.length; index += 1) {
      const entry = ordered[index];

      if (actorLost) {
        const result = itemResult(entry, 'actor_changed', {
          errorCode: 'candidate_actor_stale',
        });
        notAttemptedCount += 1;
        await publish(result, null);
        continue;
      }

      // A CONFIRMED INSUFFICIENT-STORAGE RESULT STOPS THE DEQUEUE. Every later
      // copy is the same size on the same full disk; attempting them would only
      // produce seven more identical failures and seven more partial writes to
      // clean up. They are reported as NOT ATTEMPTED, never as failures, and the
      // records are left untouched and retryable.
      if (storageBlocked) {
        const result = itemResult(entry, 'not_attempted_storage_blocked', {
          errorCode: 'candidate_storage_insufficient',
        });
        notAttemptedCount += 1;
        await publish(result, null);
        continue;
      }

      // BACKGROUNDING STOPS THE DEQUEUE TOO, at the same safe boundary. A
      // candidate that never started is not a failure and is never persisted as
      // one — it is simply still waiting for the user to ask again.
      if (!shouldContinue()) {
        const result = itemResult(entry, 'not_attempted_backgrounded');
        notAttemptedCount += 1;
        await publish(result, null);
        continue;
      }

      if (!isActorRequestCurrent(actorRequest)) {
        actorLost = true;
        const result = itemResult(entry, 'actor_changed', {
          errorCode: 'candidate_actor_stale',
        });
        notAttemptedCount += 1;
        await publish(result, null);
        continue;
      }

      activeOperation.activeCandidateId = entry.candidateId;
      let result;
      try {
        result = await enqueuePromotion(() =>
          promoteOneClosetCandidate(actorRequest, entry, {
            batchId,
            nowMs,
            now,
            deadlineMs: now() + itemTimeoutMs,
            shouldContinue,
          }),
        );
      } catch {
        // The per-candidate sequence handles its own failures; an escape means an
        // unexpected fault, and the queue must not be left holding this item.
        result = itemResult(entry, 'failed', { errorCode: 'candidate_persist_failed' });
      }
      activeOperation.activeCandidateId = null;

      if (result.status === 'promoted') promotedCount += 1;
      else if (result.status === 'already_promoted') alreadyPromotedCount += 1;
      else if (result.status === 'aborted') notAttemptedCount += 1;
      else failedCount += 1;

      if (result.status === 'storage_failed') storageBlocked = true;
      if (result.status === 'actor_changed') actorLost = true;

      // The next candidate is named in the event so the surface never has to guess
      // which card to show as active — a guess that would drift the moment the
      // submitted order and the batch order disagreed.
      await publish(result, ordered[index + 1]?.candidateId ?? null);

      // YIELD. Serial execution with a gap the JS event loop can use is what makes
      // per-item progress observable in the UI; parallelism would make it feel
      // responsive by breaking the one invariant this module exists for.
      if (index < ordered.length - 1) {
        try {
          await yieldToUi();
        } catch {
          /* a scheduling hiccup is not a reason to stop promoting */
        }
      }
    }
  } finally {
    activeOperation = null;
  }

  return {
    ok: true,
    operationId,
    batchId,
    requestedCount: ordered.length,
    promotedCount,
    alreadyPromotedCount,
    failedCount,
    notAttemptedCount,
    results,
    errorCode: null,
    alreadyRunning: false,
  };
}

/** Test seam only. Not used by production code. */
export const __closetPromotionInternals = {
  normalizeIds,
  itemResult,
  resultForCommitReason,
  resetForTests() {
    promotionChain = Promise.resolve();
    activeOperation = null;
    operationCounter = 0;
  },
};
