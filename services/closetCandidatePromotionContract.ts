// The PURE promotion vocabulary: per-item outcomes, progress shape, user-facing
// copy, and the injectable per-candidate deadline (Build 2, Phase 3).
//
// WHY A SEPARATE MODULE FROM THE COORDINATOR. The coordinator owns filesystem
// work, the candidate store and the committed Closet; none of that is needed to
// answer "what does this outcome mean" or "what does the user read". Keeping the
// vocabulary pure is what lets the projection, the review surface and the tests
// share one set of names without any of them acquiring a persistence import.
//
// NO RAW EXCEPTION TEXT EVER REACHES A USER. Every message here is static and
// written by us, exactly like the candidate error registry it defers to.

import type { ClosetCandidateErrorCode } from '../types/closetCandidate';
import type { ClosetCandidatePromotionBlockedReason } from './closetCandidateReviewEligibility';

/**
 * The complete per-item outcome vocabulary.
 *
 *   promoted                      a committed item was created and read back
 *   already_promoted              provenance found an existing committed item
 *   duplicate                     a DIFFERENT candidate's content is committed
 *   ineligible                    commit-time eligibility refused it
 *   missing_media                 the candidate's own media is gone or foreign
 *   storage_failed                the committed copy could not be stored
 *   actor_changed                 the actor or epoch moved before the write
 *   aborted                       lifecycle stop; nothing was committed
 *   not_attempted_backgrounded    never started: the app went to background
 *   not_attempted_storage_blocked never started: storage already failed
 *   failed                        anything else, always with an error code
 *
 * `already_promoted` and `duplicate` are SUCCESSFUL, IDEMPOTENT answers, not
 * failures — the Closet ends up in exactly the state the user asked for.
 */
export const CLOSET_PROMOTION_ITEM_STATUSES = [
  'promoted',
  'already_promoted',
  'duplicate',
  'ineligible',
  'missing_media',
  'storage_failed',
  'actor_changed',
  'aborted',
  'not_attempted_backgrounded',
  'not_attempted_storage_blocked',
  'failed',
] as const;

export type ClosetPromotionItemStatus = typeof CLOSET_PROMOTION_ITEM_STATUSES[number];

/** Outcomes that mean the item IS in the committed Closet. */
export const CLOSET_PROMOTION_SUCCESS_STATUSES: readonly ClosetPromotionItemStatus[] = [
  'promoted',
  'already_promoted',
];

/**
 * Outcomes where the candidate was never touched.
 *
 * These must never be persisted as a candidate failure: the record is unchanged,
 * still reviewable, and still promotable on the next user-initiated attempt.
 */
export const CLOSET_PROMOTION_NOT_ATTEMPTED_STATUSES: readonly ClosetPromotionItemStatus[] = [
  'not_attempted_backgrounded',
  'not_attempted_storage_blocked',
];

export type ClosetPromotionItemResult = {
  candidateId: string;
  batchPosition: number | null;
  status: ClosetPromotionItemStatus;
  /** Present only on a successful outcome. */
  committedClosetItemId: string | null;
  /** Registry code for a failure. Never a raw exception message. */
  errorCode: ClosetCandidateErrorCode | null;
};

export type ClosetPromotionProgress = {
  operationId: string;
  batchId: string | null;
  requestedCount: number;
  completedCount: number;
  promotedCount: number;
  alreadyPromotedCount: number;
  failedCount: number;
  /** The candidate whose result this event carries. */
  currentCandidateId: string | null;
  currentBatchPosition: number | null;
  latestResult: ClosetPromotionItemResult | null;
  resultsSoFar: readonly ClosetPromotionItemResult[];
  /** The candidate now being worked on, or null once the operation is done. */
  activeCandidateId: string | null;
  done: boolean;
};

export type ClosetPromotionOperationResult = {
  ok: boolean;
  operationId: string | null;
  batchId: string | null;
  requestedCount: number;
  promotedCount: number;
  alreadyPromotedCount: number;
  failedCount: number;
  notAttemptedCount: number;
  results: readonly ClosetPromotionItemResult[];
  /** Set only when the whole operation was refused before any item ran. */
  errorCode: ClosetCandidateErrorCode | null;
};

// ── Blocked reason → outcome ─────────────────────────────────────────────────

/**
 * Map a commit-time eligibility refusal onto a per-item outcome.
 *
 * Deliberately NOT one-to-one: the user-visible difference between "we could not
 * find the photo" and "this is not ready yet" matters, and the difference between
 * `needs_details` and `processing` does not — both are simply "not eligible", and
 * the row already says which through its own status label.
 */
export function closetPromotionStatusForBlockedReason(
  reason: ClosetCandidatePromotionBlockedReason | null | undefined,
): ClosetPromotionItemStatus {
  switch (reason) {
    case 'missing_media':
    case 'foreign_media':
      return 'missing_media';
    case 'duplicate_unresolved':
      return 'duplicate';
    case 'foreign_actor':
      return 'actor_changed';
    default:
      return 'ineligible';
  }
}

/**
 * The candidate-registry code an eligibility refusal is recorded under.
 *
 * Reuses the established vocabulary rather than minting a promotion-only one: an
 * expired candidate is `candidate_expired` wherever it is refused, and a second
 * name for it would make the same condition look like two different faults.
 */
export function closetPromotionErrorCodeForBlockedReason(
  reason: ClosetCandidatePromotionBlockedReason | null | undefined,
): ClosetCandidateErrorCode {
  switch (reason) {
    case 'expired':
      return 'candidate_expired';
    case 'foreign_actor':
      return 'candidate_actor_stale';
    case 'missing_media':
    case 'foreign_media':
      return 'candidate_media_unreadable';
    case 'duplicate_unresolved':
      return 'already_in_closet';
    case 'unsupported_schema':
      return 'candidate_store_future_schema';
    case 'corrupt_record':
    case 'missing_record':
      return 'candidate_store_corrupt';
    default:
      return 'candidate_invalid_transition';
  }
}

// ── User-facing copy ─────────────────────────────────────────────────────────

/** The production action. One name, used by the surface and asserted by test. */
export const CLOSET_PROMOTION_ACTION_LABEL = 'Add selected to Closet';

/** The transient per-card state while this candidate is the active one. */
export const CLOSET_PROMOTION_ACTIVE_LABEL = 'Adding to Closet';

/** The terminal per-card state. Matches the state machine's `saved` label. */
export const CLOSET_PROMOTION_DONE_LABEL = 'Added to Closet';

/** A submitted candidate that has not had its turn yet. Never "saving". */
export const CLOSET_PROMOTION_PENDING_LABEL = 'Waiting to be added';

/**
 * Aggregate progress copy.
 *
 * Counts COMPLETED items, so the first line the user sees is "Adding 1 of 8"
 * only once one has actually finished — a counter that starts at 1 of 8 before
 * anything has been committed is a claim the operation has not earned.
 */
export function describeClosetPromotionProgress(progress: {
  completedCount?: number | null;
  requestedCount?: number | null;
}): string {
  const total =
    typeof progress?.requestedCount === 'number' && progress.requestedCount > 0
      ? progress.requestedCount
      : 0;
  const done =
    typeof progress?.completedCount === 'number' && progress.completedCount > 0
      ? Math.min(progress.completedCount, total || progress.completedCount)
      : 0;
  if (!total) return CLOSET_PROMOTION_ACTIVE_LABEL;
  return `Adding ${Math.min(done + 1, total)} of ${total}`;
}

/**
 * The per-candidate deadline.
 *
 * INJECTABLE, AND PER CANDIDATE — never one budget for a whole eight-item batch,
 * which would make the last item's allowance depend on how slow the first seven
 * were. The value is a bound on the promotion SEQUENCE, evaluated at the same
 * safe checkpoints as cancellation; it is deliberately not a race that could
 * settle while an atomic manifest replacement is still running, because there is
 * no way to interrupt one of those without leaving exactly the torn state the
 * store's write-verify-swap exists to prevent.
 *
 * The production value remains provisional until physical-device evidence and
 * the Phase 4 audit; it is generous on purpose, because expiring a promotion
 * that would have succeeded costs more than waiting.
 */
export const CLOSET_PROMOTION_ITEM_TIMEOUT_MS = 90 * 1000;
