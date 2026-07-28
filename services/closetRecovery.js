/**
 * CLOSET RECOVERY AND MEDIA LIFECYCLE CONVERGENCE (Build 2, Phase 4).
 *
 * THE PROBLEM THIS MODULE OWNS. Promotion is a sequence of durable local steps,
 * not a transaction:
 *
 *   candidate exists
 *     -> committed media copy
 *     -> committed record write
 *     -> committed read-back
 *     -> candidate `saved` finalization
 *     -> candidate-media cleanup
 *     -> eventual tombstone retirement
 *
 * A process death between any two of those leaves the device in a state that is
 * CORRECT but INCOMPLETE. Phase 3 chose that deliberately — finalization happens
 * after durability, so a crash leaves a committed item and a still-reviewable
 * candidate rather than a promoted candidate and nothing. This module is the other
 * half of that bargain: the thing that notices and converges.
 *
 * RECONSTRUCTIVE, NOT JOURNALLED. Truth is inferred from state that is already
 * authoritative — the candidate manifest, the committed manifest, the
 * `sourceCandidateId` provenance link, and the bytes on disk. No operation log is
 * introduced, and nothing here becomes a third source of truth: every decision is
 * re-derived on every pass, so losing whatever this module knows costs one extra
 * pass and nothing else.
 *
 * WHAT IT WILL NEVER DO, and each of these is a lock, not a preference:
 *   - it never creates a committed Closet item. `createClosetItem` is not imported
 *     and no code path reaches it. Startup that promoted a candidate the user had
 *     merely selected would be the app spending their Closet on their behalf.
 *   - it never writes either manifest itself. Both stores keep their own
 *     serialized queue, their own actor check and their own atomic replacement.
 *   - it never deletes a file it has not proven ownership of. Candidate cleanup
 *     goes through the candidate store (which re-checks the candidate root);
 *     committed cleanup goes through the committed store (which re-checks the
 *     committed root). Neither function can be handed the other's root.
 *   - it never reintroduces a durable `saving` status. "Adding to Closet" stays an
 *     in-memory overlay, which is exactly why a crash needs no sweep to release.
 *   - it never touches the network, the backend, Recent Scan, Elise, or commerce.
 *
 * FAIL-CLOSED IS THE DEFAULT EVERYWHERE. Uncertainty retains. A manifest that
 * could not be read completely refuses destructive work outright rather than
 * treating what it could not interpret as absent.
 */

import { isActorRequestCurrent } from './actorContext';
import {
  closetPromotionMediaPaths,
  findClosetItemBySourceCandidate,
  isClosetOwnedMediaPath,
  repairClosetItemTaxonomy,
  sweepOrphanedClosetMedia,
  verifyClosetItemMedia,
} from './closetLibrary';
import {
  finalizeClosetCandidatePromotion,
  listClosetCandidatesForRecovery,
  releasePromotedCandidateMedia,
  retirePromotedClosetCandidate,
} from './closetCandidateLibrary';
import { isCandidateOwnedPath } from './closetCandidateMedia';
import {
  buildClosetPromotionDraft,
  closetPromotionTaxonomyGaps,
  closetPromotionTaxonomyMismatches,
  getActiveClosetPromotion,
} from './closetCandidatePromotion';
import { isUnresolvedStatus } from './closetCandidateStateMachine';
import { emitClosetCandidateEvent } from './closetTelemetry';

// ── Bounds ───────────────────────────────────────────────────────────────────

/**
 * Candidates examined per pass, across every stage.
 *
 * Startup housekeeping competes with the screen the user is actually waiting for,
 * so a pass stops at a fixed budget and the next foreground resumes. Nothing is
 * lost by stopping: every stage is idempotent and re-derives its own decisions.
 */
export const CLOSET_RECOVERY_MAX_UNITS = 60;

/** Units between cooperative yields, so the JS thread is never held hostage. */
export const CLOSET_RECOVERY_YIELD_EVERY = 4;

/** Completed-pass keys retained, so the memo cannot grow without bound. */
const RECOVERY_MEMO_LIMIT = 8;

// ── Result vocabulary ────────────────────────────────────────────────────────

/**
 * Why a unit of recovery work did not converge.
 *
 * CATEGORIES, NOT MESSAGES. Every value is a fixed identifier from this list; no
 * path, filename, title, taxonomy value or exception text is ever carried in a
 * recovery result, and the result is never handed to telemetry as free text.
 */
export const CLOSET_RECOVERY_ISSUES = Object.freeze([
  /** A committed record exists but its media is missing or not Closet-owned. */
  'committed_media_invalid',
  /** Provenance names one committed item; the lookup found another. */
  'provenance_conflict',
  /** A tombstone with no committed item behind it. Retained, never rebuilt. */
  'committed_missing',
  /** The committed record holds a DIFFERENT value for a field the candidate has. */
  'taxonomy_conflict',
  /** Taxonomy the candidate carries is still absent from the committed record. */
  'taxonomy_unverified',
  /** The in-place taxonomy backfill did not land or did not verify. */
  'repair_failed',
  /** The candidate store refused the finalization write. */
  'finalize_failed',
  /** A running promotion still references this candidate. */
  'active_operation',
  /** Candidate media could not be unlinked. Retried on a later pass. */
  'cleanup_failed',
  /** The committed item's owner is not the recovering actor. */
  'actor_mismatch',
]);

/** Why a whole pass did not run, or did not finish. */
export const CLOSET_RECOVERY_STOP_REASONS = Object.freeze([
  'actor_stale',
  'already_complete',
  'store_unreadable',
  'backgrounded',
  'budget_exhausted',
]);

function emptyResult(stopReason, extra = {}) {
  return {
    ok: extra.ok === true,
    passId: null,
    complete: false,
    stopReason: stopReason ?? null,
    finalizedCount: 0,
    repairedCount: 0,
    cleanedCount: 0,
    retiredCount: 0,
    committedOrphansDeleted: 0,
    committedSweepSkipped: true,
    issues: [],
    ...extra,
  };
}

// ── Single-flight state ──────────────────────────────────────────────────────

/**
 * Module-scoped for the same reason the promotion coordinator's is: a second
 * mounted surface, a remount, or a focus event must not be able to start a second
 * pass, and a pass already inside a write must be allowed to settle safely rather
 * than being abandoned by an unmount.
 */
let recoveryChain = Promise.resolve();
let inFlightKey = null;
let inFlightPromise = null;
let passCounter = 0;
const completedKeys = [];

function recoveryKey(actorRequest) {
  return `${actorRequest?.actorId ?? 'device-local'}|${actorRequest?.epoch}`;
}

function rememberCompleted(key) {
  if (completedKeys.includes(key)) return;
  completedKeys.push(key);
  while (completedKeys.length > RECOVERY_MEMO_LIMIT) completedKeys.shift();
}

function defaultYield() {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
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

// ── Verification ─────────────────────────────────────────────────────────────

/**
 * Is this candidate's committed item real, owned, intact and independent?
 *
 * THE FOUR THINGS THAT MUST ALL HOLD before any candidate-owned file is deleted or
 * any tombstone is retired, and the reason each is checked separately:
 *
 *   provenance   the committed item this actor holds for this candidate, and the
 *                item the tombstone already names, must be the SAME item. A
 *                disagreement is a conflict to report, never one to resolve by
 *                picking a side.
 *   ownership    the item's owner must be the recovering actor. The manifest is
 *                one file shared by every actor partition, so the pair is the
 *                identity — never the provenance string alone.
 *   independence the committed media must live under the COMMITTED root and must
 *                not be a candidate-owned path. This is what makes "delete the
 *                candidate's copy" safe: if the committed record were pointing at
 *                the candidate's own file, cleaning up would blank the Closet.
 *   bytes        the file must actually be there. A manifest entry is not media.
 *
 * Taxonomy is verified by GAPS, not by equality. A field the user has since edited
 * is a legitimately different value and must not block cleanup forever; a field
 * the candidate carried and the committed record simply does not have is evidence
 * the promotion did not finish preserving it.
 */
async function verifyPromotedCandidate(actorRequest, candidate) {
  const actorId = actorRequest.actorId ?? null;

  const recordedItemId =
    typeof candidate.promotedClosetItemId === 'string' && candidate.promotedClosetItemId.trim()
      ? candidate.promotedClosetItemId.trim()
      : null;
  if (!recordedItemId) return { ok: false, issue: 'committed_missing' };

  const committed = await findClosetItemBySourceCandidate(candidate.candidateId, actorId);
  if (!committed) return { ok: false, issue: 'committed_missing' };
  if (committed.id !== recordedItemId) return { ok: false, issue: 'provenance_conflict' };
  if ((committed.ownerId ?? null) !== actorId) return { ok: false, issue: 'actor_mismatch' };

  if (!isClosetOwnedMediaPath(committed.imageUri)) {
    return { ok: false, issue: 'committed_media_invalid' };
  }
  if (
    isCandidateOwnedPath(committed.imageUri) ||
    isCandidateOwnedPath(committed.thumbnailUri)
  ) {
    return { ok: false, issue: 'committed_media_invalid' };
  }
  if (!(await verifyClosetItemMedia(committed))) {
    return { ok: false, issue: 'committed_media_invalid' };
  }

  // A candidate with no category cannot produce a draft, so there is nothing to
  // compare and nothing to demand. That is vacuous verification, not a pass by
  // omission: the committed record cannot be missing what was never identified.
  const draft = buildClosetPromotionDraft(candidate, { clientRequestId: actorRequest.requestId });
  if (draft && closetPromotionTaxonomyGaps(committed, draft).length > 0) {
    return { ok: false, issue: 'taxonomy_unverified' };
  }

  return { ok: true, item: committed };
}

/** True when a running promotion operation still names this candidate. */
function isReferencedByActiveOperation(candidateId) {
  const active = getActiveClosetPromotion();
  if (!active) return false;
  if (active.activeCandidateId === candidateId) return true;
  return Array.isArray(active.candidateIds) && active.candidateIds.includes(candidateId);
}

// ── Stage 1: finalization recovery ───────────────────────────────────────────

/**
 * Reconcile ONE unfinalized candidate against the committed Closet.
 *
 * Cases A through D of the recovery matrix, in the order they can be decided:
 *
 *   no committed item          leave it alone. The user selected it, or did not;
 *                              either way an unpromoted candidate stays exactly as
 *                              recoverable and as selectable as it already was,
 *                              and startup does not commit it on their behalf.
 *   committed, media invalid   do NOT finalize, do NOT delete anything, report.
 *                              Pointing the record back at the candidate's own
 *                              media to "fix" it would destroy the independence
 *                              the whole media-root separation exists for.
 *   committed, taxonomy gaps   repair in place through the Phase 3.5 backfill,
 *                              re-read, and finalize only if the gaps are gone.
 *                              The item id, its media and its provenance are all
 *                              preserved; no second item is ever created.
 *   committed, taxonomy differs fail closed. A committed value that disagrees with
 *                              the candidate is a user edit, and recovery is not a
 *                              licence to overwrite one.
 */
async function recoverOneUnfinalizedCandidate(actorRequest, candidate, nowMs) {
  const actorId = actorRequest.actorId ?? null;

  const committed = await findClosetItemBySourceCandidate(candidate.candidateId, actorId);
  // CASE A. Nothing was ever committed for this candidate.
  if (!committed) return { outcome: 'left_recoverable' };

  if ((committed.ownerId ?? null) !== actorId) {
    return { outcome: 'blocked', issue: 'actor_mismatch' };
  }
  // CASE D. The manifest says committed; the bytes disagree.
  if (!isClosetOwnedMediaPath(committed.imageUri) || isCandidateOwnedPath(committed.imageUri)) {
    return { outcome: 'blocked', issue: 'committed_media_invalid' };
  }
  if (!(await verifyClosetItemMedia(committed))) {
    return { outcome: 'blocked', issue: 'committed_media_invalid' };
  }

  const draft = buildClosetPromotionDraft(candidate, { clientRequestId: actorRequest.requestId });
  if (!draft) {
    // Without a category there is no payload to verify a promotion against, so
    // there is nothing this pass can honestly certify. Left recoverable.
    return { outcome: 'left_recoverable' };
  }

  let current = committed;
  let repaired = false;

  const gaps = closetPromotionTaxonomyGaps(current, draft);
  const conflicts = closetPromotionTaxonomyMismatches(current, draft).filter(
    (field) => !gaps.includes(field),
  );
  // CASE C, the refusal half.
  if (conflicts.length > 0) return { outcome: 'blocked', issue: 'taxonomy_conflict' };

  // CASE C, the repair half.
  if (gaps.length > 0) {
    const repair = await repairClosetItemTaxonomy(current.id, draft, {
      actorRequest,
      ownerId: actorId,
    });
    if (!repair.ok) return { outcome: 'blocked', issue: 'repair_failed' };

    const reread = await findClosetItemBySourceCandidate(candidate.candidateId, actorId);
    if (
      !reread ||
      reread.id !== current.id ||
      closetPromotionTaxonomyGaps(reread, draft).length > 0
    ) {
      return { outcome: 'blocked', issue: 'repair_failed' };
    }
    current = reread;
    repaired = true;
  }

  // CASE B. Finalize LAST, and only against an item that has been read back and
  // verified — the same ordering the promotion coordinator uses, for the same
  // reason: a tombstone must never claim a promotion the Closet cannot show.
  const finalized = await finalizeClosetCandidatePromotion(actorRequest, candidate.candidateId, {
    closetItemId: current.id,
    nowMs,
  });
  if (!finalized.ok) return { outcome: 'blocked', issue: 'finalize_failed' };

  return { outcome: repaired ? 'repaired' : 'finalized', closetItemId: current.id };
}

// ── Stage 2: candidate-media cleanup ─────────────────────────────────────────

/**
 * Release ONE promoted candidate's own media, once everything is proven.
 *
 * Cases E and F. `saved` is the trigger, never the authorization: the committed
 * item is re-resolved, re-owned, re-verified and re-taxonomy-checked on every
 * pass, and only then is the store asked to clear the references and unlink.
 * A tombstone whose committed item is missing or corrupt keeps its media.
 */
async function cleanupOnePromotedCandidate(actorRequest, candidate) {
  if (isReferencedByActiveOperation(candidate.candidateId)) {
    return { outcome: 'blocked', issue: 'active_operation' };
  }

  const verified = await verifyPromotedCandidate(actorRequest, candidate);
  if (!verified.ok) return { outcome: 'blocked', issue: verified.issue };

  const released = await releasePromotedCandidateMedia(actorRequest, candidate.candidateId, {
    closetItemId: verified.item.id,
  });
  if (released.alreadyClean === true) return { outcome: 'already_clean' };
  if (!released.ok) return { outcome: 'blocked', issue: 'cleanup_failed' };
  return { outcome: 'cleaned' };
}

// ── Stage 4: tombstone retirement ────────────────────────────────────────────

/**
 * Retire ONE fully converged tombstone.
 *
 * AGE IS THE LAST GATE, NOT THE FIRST. Everything the cleanup stage proves is
 * proven again here, plus two continuity rules:
 *
 *   no active operation may name the candidate; and
 *   the candidate's BATCH must contain no unresolved sibling.
 *
 * The second is what keeps a review session intact. A batch with anything still
 * queued, classifying, awaiting details or ready is a batch the user is still
 * working through, and removing a promoted card out from under it would reflow the
 * group they are looking at. A batch whose every member is resolved is history.
 *
 * The store primitive re-checks status, provenance, media absence and the
 * retention window inside its own serialized section, so nothing decided here can
 * be relied upon to have stayed true.
 */
async function retireOneTombstone(actorRequest, candidate, context) {
  if (isReferencedByActiveOperation(candidate.candidateId)) {
    return { outcome: 'blocked', issue: 'active_operation' };
  }
  if (candidate.candidateImageUri || candidate.candidateThumbnailUri) {
    return { outcome: 'retention_pending' };
  }
  if (context.batchesWithUnresolved.has(candidate.batchId)) {
    return { outcome: 'retention_pending' };
  }

  const verified = await verifyPromotedCandidate(actorRequest, candidate);
  if (!verified.ok) return { outcome: 'blocked', issue: verified.issue };

  const retired = await retirePromotedClosetCandidate(actorRequest, candidate.candidateId, {
    closetItemId: verified.item.id,
    nowMs: context.nowMs,
  });
  // A refusal here is overwhelmingly the retention window, which is not a fault.
  if (!retired.ok) return { outcome: 'retention_pending' };
  return { outcome: 'retired' };
}

// ── The coordinator ──────────────────────────────────────────────────────────

async function runRecoveryPass(actorRequest, options) {
  if (!isActorRequestCurrent(actorRequest)) return emptyResult('actor_stale');

  const nowMs = typeof options.nowMs === 'number' ? options.nowMs : Date.now();
  const yieldToUi = typeof options.yieldToUi === 'function' ? options.yieldToUi : defaultYield;
  const maxUnits =
    typeof options.maxUnits === 'number' && Number.isFinite(options.maxUnits) && options.maxUnits > 0
      ? Math.floor(options.maxUnits)
      : CLOSET_RECOVERY_MAX_UNITS;
  const shouldContinue =
    typeof options.shouldContinue === 'function'
      ? () => {
        try {
          return options.shouldContinue() !== false;
        } catch {
          // A consumer whose predicate throws must not be able to abandon a pass
          // midway. The actor checks remain the real gate.
          return true;
        }
      }
      : () => true;

  passCounter += 1;
  const passId = `closetrec_${actorRequest.epoch}_${passCounter}`;

  const issues = [];
  const noteIssue = (issue) => {
    if (issue && !issues.includes(issue)) issues.push(issue);
  };

  let finalizedCount = 0;
  let repairedCount = 0;
  let cleanedCount = 0;
  let retiredCount = 0;
  let committedOrphansDeleted = 0;
  let committedSweepSkipped = true;
  let complete = true;
  let stopReason = null;
  let units = 0;

  /**
   * One bounded unit of work has been spent. Returns false when the pass must
   * stop — actor gone, backgrounded, or budget exhausted — and yields on a fixed
   * cadence so React can commit between units.
   */
  const spendUnit = async () => {
    units += 1;
    if (units % CLOSET_RECOVERY_YIELD_EVERY === 0) {
      try {
        await yieldToUi();
      } catch {
        /* a scheduling hiccup is not a reason to stop recovering */
      }
    }
    if (!isActorRequestCurrent(actorRequest)) {
      complete = false;
      stopReason = 'actor_stale';
      return false;
    }
    if (!shouldContinue()) {
      complete = false;
      stopReason = 'backgrounded';
      return false;
    }
    if (units >= maxUnits) {
      complete = false;
      stopReason = 'budget_exhausted';
      return false;
    }
    return true;
  };

  const finish = () => {
    if (complete) rememberCompleted(recoveryKey(actorRequest));
    emitClosetCandidateEvent('closet_candidate_cleanup_completed', {
      scope: 'closet_recovery',
      countBucket: bucketCount(cleanedCount + retiredCount + committedOrphansDeleted),
      aborted: complete !== true,
    });
    if (issues.length > 0) {
      emitClosetCandidateEvent('closet_candidate_cleanup_failed', {
        scope: 'closet_recovery',
        countBucket: bucketCount(issues.length),
      });
    }
    return {
      ok: true,
      passId,
      complete,
      stopReason,
      finalizedCount,
      repairedCount,
      cleanedCount,
      retiredCount,
      committedOrphansDeleted,
      committedSweepSkipped,
      issues,
    };
  };

  // THE FAIL-CLOSED READ. Every stage below is potentially destructive, and a
  // manifest that could not be read completely would make an uninterpretable
  // record's media look unowned. Refusing the whole pass is the correct answer.
  const listed = await listClosetCandidatesForRecovery(actorRequest, { nowMs });
  if (!listed.ok) {
    return emptyResult('store_unreadable', { ok: false, passId, issues: [] });
  }
  const candidates = listed.candidates;

  // Batch continuity, computed once from the same records the projection groups by.
  const batchesWithUnresolved = new Set();
  for (const record of candidates) {
    if (isUnresolvedStatus(record.status)) batchesWithUnresolved.add(record.batchId);
  }

  // ── Stage 1: finalize what a crash left committed but unrecorded ──────────
  for (const candidate of candidates) {
    if (candidate.status === 'saved' || candidate.status === 'rejected') continue;
    const result = await recoverOneUnfinalizedCandidate(actorRequest, candidate, nowMs);
    if (result.outcome === 'finalized') finalizedCount += 1;
    else if (result.outcome === 'repaired') repairedCount += 1;
    else if (result.outcome === 'blocked') noteIssue(result.issue);
    if (!(await spendUnit())) return finish();
  }

  // ── Stage 2: release candidate media a verified promotion no longer needs ──
  for (const candidate of candidates) {
    if (candidate.status !== 'saved') continue;
    if (!candidate.candidateImageUri && !candidate.candidateThumbnailUri) continue;
    const result = await cleanupOnePromotedCandidate(actorRequest, candidate);
    if (result.outcome === 'cleaned') cleanedCount += 1;
    else if (result.outcome === 'blocked') noteIssue(result.issue);
    if (!(await spendUnit())) return finish();
  }

  // ── Stage 3: collect committed media nothing references ───────────────────
  //
  // Deterministic destinations reserved by a running promotion are handed to the
  // sweep explicitly. The operation may be between its media write and its
  // manifest write, in which case the file is real, owned, and not yet referenced
  // by anything the sweep can see.
  const active = getActiveClosetPromotion();
  const protectedPaths = [];
  if (active) {
    for (const candidateId of active.candidateIds) {
      const paths = closetPromotionMediaPaths(active.actorId ?? null, candidateId);
      if (paths) protectedPaths.push(paths.imageUri, paths.thumbnailUri);
    }
  }
  const swept = await sweepOrphanedClosetMedia({
    nowMs,
    protectedPaths,
    graceMs: options.graceMs,
    maxFiles: options.maxSweepFiles,
  });
  committedOrphansDeleted = swept.deleted ?? 0;
  committedSweepSkipped = swept.skipped === true;
  if ((swept.failed ?? 0) > 0) noteIssue('cleanup_failed');
  if (!(await spendUnit())) return finish();

  // ── Stage 4: retire tombstones that have converged and aged out ────────────
  for (const candidate of candidates) {
    if (candidate.status !== 'saved') continue;
    const result = await retireOneTombstone(actorRequest, candidate, {
      nowMs,
      batchesWithUnresolved,
    });
    if (result.outcome === 'retired') retiredCount += 1;
    else if (result.outcome === 'blocked') noteIssue(result.issue);
    if (!(await spendUnit())) return finish();
  }

  return finish();
}

/**
 * THE ONE STARTUP / FOREGROUND RECOVERY ENTRY POINT.
 *
 * SINGLE-FLIGHT PER ACTOR EPOCH. Two concurrent calls for the same epoch resolve
 * to the SAME promise rather than running twice; a call for a different epoch
 * QUEUES behind the current pass rather than overlapping it. A pass that already
 * completed for an epoch is skipped, so a focus event that fires four times in a
 * second costs one pass.
 *
 * AN INCOMPLETE PASS IS NOT MEMOIZED. Backgrounding, a budget exhaustion or an
 * actor change all leave `complete: false`, and the next foreground retries. That
 * is what makes "relaunch resumes incomplete cleanup" true without any durable
 * progress marker.
 *
 * IT NEVER RESUMES A USER-SELECTED PROMOTION. Recovery reconciles what already
 * happened; asking for a promotion remains something only the user does.
 *
 * NO BACKGROUND TASK, NO NETWORK, NO BACKEND. Never throws.
 */
export async function runClosetStartupRecovery(actorRequest, options = {}) {
  if (!isActorRequestCurrent(actorRequest)) return emptyResult('actor_stale');

  const key = recoveryKey(actorRequest);
  // Collapse concurrent starts for the same epoch onto the running pass.
  if (inFlightPromise && inFlightKey === key) return inFlightPromise;
  if (completedKeys.includes(key) && options.force !== true) {
    return emptyResult('already_complete', { ok: true, complete: true });
  }

  const run = async () => {
    try {
      return await runRecoveryPass(actorRequest, options);
    } catch {
      // A cleanup exception must never be able to crash app initialization.
      return emptyResult('store_unreadable', { ok: false });
    }
  };

  const chained = recoveryChain.then(run, run);
  recoveryChain = chained.then(
    () => undefined,
    () => undefined,
  );

  inFlightKey = key;
  inFlightPromise = chained.then(
    (result) => {
      if (inFlightKey === key) {
        inFlightKey = null;
        inFlightPromise = null;
      }
      return result;
    },
    () => {
      if (inFlightKey === key) {
        inFlightKey = null;
        inFlightPromise = null;
      }
      return emptyResult('store_unreadable', { ok: false });
    },
  );
  return inFlightPromise;
}

/** True while a pass is running. Read by tests and by the surface, never written. */
export function isClosetRecoveryRunning() {
  return inFlightPromise !== null;
}

/** Test seam only. Not used by production code. */
export const __closetRecoveryInternals = {
  recoveryKey,
  verifyPromotedCandidate,
  isReferencedByActiveOperation,
  resetForTests() {
    recoveryChain = Promise.resolve();
    inFlightKey = null;
    inFlightPromise = null;
    passCounter = 0;
    completedKeys.length = 0;
  },
};
