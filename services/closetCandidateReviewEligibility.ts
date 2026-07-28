// THE ONE authoritative "may this candidate be selected for review?" predicate
// (Closet Upgrade Build 2, Phase 2).
//
// WHY THIS IS ITS OWN MODULE. Selection eligibility is asked in four places that
// must never disagree: an individual row's selection control, select-all-ready,
// selection reconciliation after any projection change, and — in the next phase —
// the promotion service's pre-check. Four copies of "is it ready and does it have
// a category" is exactly how a duplicate ends up promotable in one code path and
// blocked in another. There is one function; everything else calls it.
//
// PURE. No I/O, no persistence, no actor context module, no clock beyond what the
// caller passes in. That is what makes the whole matrix directly testable and what
// lets the same predicate run inside a render, inside a hook, and inside a service.
//
// SELECTION IS NOT AUTHORIZATION. A true result means "offer this to the user for
// review", not "this may be committed". Media bytes are revalidated, the actor is
// revalidated, and the state machine is re-consulted by the promotion service when
// that phase exists. Nothing here grants a write.

import {
  CLOSET_CANDIDATE_MAX_SUPPORTED_SCHEMA_VERSION,
  type ClosetCandidate,
  type ClosetCandidateStatus,
} from '../types/closetCandidate';
import { isClosetCandidateStatus } from './closetCandidateStateMachine';

/** The ONE status from which a candidate may be selected. */
export const CLOSET_CANDIDATE_REVIEW_READY_STATUS: ClosetCandidateStatus = 'ready_for_review';

/**
 * Why a candidate cannot be selected.
 *
 * These are INTERNAL reasons. They drive which contextual affordance a row shows;
 * they are never rendered as-is. User-facing copy comes from the status label the
 * state machine already owns.
 */
export const CLOSET_CANDIDATE_SELECTION_BLOCKED_REASONS = [
  'missing_record',
  'unsupported_schema',
  'corrupt_record',
  'foreign_actor',
  'expired',
  'duplicate_unresolved',
  'processing',
  'waiting_for_network',
  'needs_details',
  'failed',
  'terminal',
  'missing_category',
  'missing_media',
] as const;

export type ClosetCandidateSelectionBlockedReason =
  typeof CLOSET_CANDIDATE_SELECTION_BLOCKED_REASONS[number];

export type ClosetCandidateReviewEligibilityContext = {
  /** The ACTIVE actor. `null` is the signed-out device-local partition. */
  actorId: string | null;
  /** Evaluation clock. Defaults to now; passed explicitly by tests and sweeps. */
  nowMs?: number;
};

export type ClosetCandidateReviewEligibility =
  | { selectable: true; blockedReason: null }
  | { selectable: false; blockedReason: ClosetCandidateSelectionBlockedReason };

/** Statuses that mean "the system is still working on this". */
const PROCESSING_STATUSES: readonly ClosetCandidateStatus[] = [
  'queued',
  'preparing',
  'classifying',
  'saving',
];

function normalizeId(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function hasText(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

function isExpiredAt(candidate: { expiresAt?: unknown }, nowMs: number): boolean {
  const at = Date.parse(typeof candidate?.expiresAt === 'string' ? candidate.expiresAt : '');
  // An unparseable expiry is treated as EXPIRED, matching the store's read filter.
  // Failing the other way would make a record with a corrupt lifetime immortal.
  if (!Number.isFinite(at)) return true;
  return at <= nowMs;
}

/**
 * The single decision point.
 *
 * The checks run in a fixed order so the reported reason is deterministic for a
 * candidate that fails several of them at once — a duplicate that is ALSO expired
 * reports `expired`, because that is the one the user can do least about.
 */
export function getClosetCandidateReviewEligibility(
  candidate: Partial<ClosetCandidate> | null | undefined,
  context: ClosetCandidateReviewEligibilityContext,
): ClosetCandidateReviewEligibility {
  const blocked = (
    blockedReason: ClosetCandidateSelectionBlockedReason,
  ): ClosetCandidateReviewEligibility => ({ selectable: false, blockedReason });

  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    return blocked('missing_record');
  }

  // A record written by a NEWER build is not corrupt and must not be treated as
  // such. It is simply not interpretable here, so it is never selectable.
  const schemaVersion = candidate.schemaVersion;
  if (
    typeof schemaVersion !== 'number' ||
    !Number.isFinite(schemaVersion) ||
    schemaVersion > CLOSET_CANDIDATE_MAX_SUPPORTED_SCHEMA_VERSION
  ) {
    return blocked('unsupported_schema');
  }

  // Identity and a status this build recognises are the minimum for a record to
  // be addressable at all.
  if (!normalizeId(candidate.candidateId) || !normalizeId(candidate.batchId)) {
    return blocked('corrupt_record');
  }
  if (!isClosetCandidateStatus(candidate.status)) return blocked('corrupt_record');

  // Ownership. `ownerId: null` is the durable signed-out partition, not an error,
  // so the comparison is against the ACTIVE actor rather than against emptiness.
  const ownerId = normalizeId(candidate.ownerId);
  const actorId = normalizeId(context?.actorId);
  if (ownerId !== actorId) return blocked('foreign_actor');

  const nowMs = typeof context?.nowMs === 'number' ? context.nowMs : Date.now();
  if (isExpiredAt(candidate, nowMs)) return blocked('expired');

  const status = candidate.status;
  if (status === 'duplicate') return blocked('duplicate_unresolved');
  if (PROCESSING_STATUSES.includes(status)) return blocked('processing');
  if (status === 'waiting_for_network') return blocked('waiting_for_network');
  if (status === 'needs_manual_classification') return blocked('needs_details');
  if (status === 'failed') return blocked('failed');
  if (status !== CLOSET_CANDIDATE_REVIEW_READY_STATUS) return blocked('terminal');

  // Taxonomy: a category is the one field the manual editor insists on, so it is
  // the one field a reviewable candidate cannot be missing.
  if (!hasText(candidate.category)) return blocked('missing_category');

  // A live reference to candidate-owned media. Path OWNERSHIP is enforced at the
  // write boundary (only derived candidate paths are ever persisted; the picker's
  // original is nulled), and byte READABILITY is revalidated by promotion. What
  // matters here is that a reference exists to revalidate at all.
  if (!hasText(candidate.candidateImageUri)) return blocked('missing_media');

  return { selectable: true, blockedReason: null };
}

/** Convenience wrapper. Delegates — it does not re-implement anything. */
export function isClosetCandidateSelectable(
  candidate: Partial<ClosetCandidate> | null | undefined,
  context: ClosetCandidateReviewEligibilityContext,
): boolean {
  return getClosetCandidateReviewEligibility(candidate, context).selectable === true;
}

// ── Promotion eligibility (Build 2, Phase 3) ─────────────────────────────────
//
// SELECTION IS A LIGHTER PRE-CHECK; THIS IS THE COMMIT-TIME AUTHORITY. Both live
// here, and this one DELEGATES to the one above rather than restating it, so a
// rule can never hold on one surface and not the other. Everything it adds is a
// question selection has no business answering: does this candidate belong to the
// batch that was actually submitted, and has its media been verified — not merely
// referenced — right now.
//
// STILL PURE. The two media facts are resolved by the coordinator (which owns the
// filesystem) and passed in as booleans, so the whole matrix stays directly
// testable and the predicate keeps its no-I/O lock.

export const CLOSET_CANDIDATE_PROMOTION_BLOCKED_REASONS = [
  'missing_record',
  'unsupported_schema',
  'corrupt_record',
  'foreign_actor',
  'foreign_batch',
  'expired',
  'duplicate_unresolved',
  'processing',
  'waiting_for_network',
  'needs_details',
  'failed',
  'terminal',
  'missing_category',
  'missing_media',
  'foreign_media',
] as const;

export type ClosetCandidatePromotionBlockedReason =
  typeof CLOSET_CANDIDATE_PROMOTION_BLOCKED_REASONS[number];

export type ClosetCandidatePromotionEligibilityContext =
  ClosetCandidateReviewEligibilityContext & {
    /** The batch actually submitted. A candidate outside it is never promoted. */
    batchId?: string | null;
    /** Verified: the media reference points inside the candidate media roots. */
    mediaOwned?: boolean | null;
    /** Verified: the referenced bytes exist and could be read, just now. */
    mediaReadable?: boolean | null;
  };

export type ClosetCandidatePromotionEligibility =
  | { promotable: true; blockedReason: null }
  | { promotable: false; blockedReason: ClosetCandidatePromotionBlockedReason };

/**
 * The single commit-time decision point.
 *
 * FAILS CLOSED ON UNVERIFIED MEDIA. `mediaOwned` and `mediaReadable` must be
 * explicit booleans: a caller that has not checked gets `missing_media` rather
 * than the benefit of the doubt, because the alternative is a committed item
 * whose media turned out not to exist.
 */
export function getClosetCandidatePromotionEligibility(
  candidate: Partial<ClosetCandidate> | null | undefined,
  context: ClosetCandidatePromotionEligibilityContext,
): ClosetCandidatePromotionEligibility {
  const blocked = (
    blockedReason: ClosetCandidatePromotionBlockedReason,
  ): ClosetCandidatePromotionEligibility => ({ promotable: false, blockedReason });

  // Everything selection already decides, decided once, in the same order.
  const selection = getClosetCandidateReviewEligibility(candidate, context);
  if (!selection.selectable) return blocked(selection.blockedReason);

  const record = candidate as Partial<ClosetCandidate>;

  // Batch scope. The submitted snapshot names one batch; an id from another one
  // reaching the coordinator means the surface and the operation disagree, and a
  // promotion spanning two unrelated intakes is never what the user asked for.
  const requestedBatchId = normalizeId(context?.batchId);
  if (requestedBatchId && normalizeId(record.batchId) !== requestedBatchId) {
    return blocked('foreign_batch');
  }

  if (context?.mediaOwned !== true) {
    // A reference that does not resolve inside the candidate media roots is
    // either a picker URI that should never have been persisted or a path from
    // another domain. Neither may become the source of a committed copy.
    return blocked(context?.mediaOwned === false ? 'foreign_media' : 'missing_media');
  }
  if (context?.mediaReadable !== true) return blocked('missing_media');

  return { promotable: true, blockedReason: null };
}
