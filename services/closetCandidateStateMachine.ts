// The ONE authoritative ClosetCandidate state-transition map (Build 1).
//
// Every transition in the candidate system goes through `evaluateTransition`.
// Components, hooks and the orchestrator do not carry their own rules — scattered
// transition logic is precisely how a state machine acquires a second, quieter
// definition that disagrees with the first, and how a candidate ends up in a
// state that no single place believes is reachable.
//
// This module is PURE. No I/O, no persistence, no actor context, no clock beyond
// what a caller passes in. That is what makes the whole matrix directly testable.

import {
  CLOSET_CANDIDATE_STATUSES,
  CLOSET_CANDIDATE_TERMINAL_STATUSES,
  type ClosetCandidateStatus,
  type ClosetCandidateStatusUIMetadata,
} from '../types/closetCandidate';

/**
 * The complete allowed-transition matrix.
 *
 * NOTES ON SPECIFIC EDGES:
 *
 * `queued` and `duplicate` are the only legal ENTRY statuses (see
 * `isLegalInitialStatus`). A committed-Closet exact-hash collision creates the
 * record directly in `duplicate` and never classifies it, so it must be an entry
 * point rather than something reached from `queued`.
 *
 * `classifying -> queued` is interrupted-classification recovery. It is bounded
 * by interruptionCount, enforced by the orchestrator, not by this matrix.
 *
 * `rejected` is reachable from every non-terminal state. That is a product
 * necessity rather than a convenience: a candidate stuck in `preparing` or
 * `waiting_for_network` still has to be discardable, and a matrix that only
 * allowed rejection from `ready_for_review` would strand exactly the records a
 * user most wants gone.
 *
 * `ready_for_review -> saving -> saved` is REPRESENTABLE but NOT REACHABLE from
 * Build 1 UI. Build 1 exposes no promotion affordance. The edges exist so Build 2
 * adds a caller, not a second state machine.
 *
 * `duplicate -> queued` is the "Add anyway" edge, likewise representable and not
 * reachable in Build 1.
 */
export const CLOSET_CANDIDATE_TRANSITIONS: Readonly<
  Record<ClosetCandidateStatus, readonly ClosetCandidateStatus[]>
> = Object.freeze({
  queued: ['preparing', 'waiting_for_network', 'classifying', 'failed', 'rejected'],
  preparing: ['classifying', 'waiting_for_network', 'failed', 'rejected'],
  waiting_for_network: ['queued', 'classifying', 'failed', 'rejected'],
  classifying: [
    'ready_for_review',
    'needs_manual_classification',
    'waiting_for_network',
    'queued',
    'failed',
    'rejected',
  ],
  needs_manual_classification: ['ready_for_review', 'failed', 'rejected'],
  ready_for_review: ['saving', 'rejected'],
  duplicate: ['queued', 'rejected'],
  failed: ['queued', 'rejected'],
  saving: ['saved', 'ready_for_review', 'failed'],
  // Terminal.
  saved: [],
  rejected: [],
});

/** Statuses a NEW candidate may be created in. */
export const CLOSET_CANDIDATE_INITIAL_STATUSES: readonly ClosetCandidateStatus[] = [
  'queued',
  'duplicate',
];

export function isClosetCandidateStatus(value: unknown): value is ClosetCandidateStatus {
  return (
    typeof value === 'string' &&
    (CLOSET_CANDIDATE_STATUSES as readonly string[]).includes(value)
  );
}

export function isLegalInitialStatus(value: unknown): boolean {
  return (
    isClosetCandidateStatus(value) &&
    (CLOSET_CANDIDATE_INITIAL_STATUSES as readonly string[]).includes(value)
  );
}

export function isTerminalStatus(value: unknown): boolean {
  return (
    isClosetCandidateStatus(value) &&
    (CLOSET_CANDIDATE_TERMINAL_STATUSES as readonly string[]).includes(value)
  );
}

/** Unresolved = counts against the per-actor cap. */
export function isUnresolvedStatus(value: unknown): boolean {
  return isClosetCandidateStatus(value) && !isTerminalStatus(value);
}

export type TransitionEvaluation =
  | { kind: 'ok'; from: ClosetCandidateStatus; to: ClosetCandidateStatus }
  | { kind: 'rejected'; reason: 'candidate_invalid_transition' };

/**
 * The single decision point.
 *
 * A self-transition (`from === to`) is REJECTED rather than treated as a no-op.
 * Silently accepting one would let a duplicated event look like progress and
 * would make `attemptCount` bookkeeping in the orchestrator unreliable.
 */
export function evaluateTransition(
  from: unknown,
  to: unknown,
): TransitionEvaluation {
  if (!isClosetCandidateStatus(from) || !isClosetCandidateStatus(to)) {
    return { kind: 'rejected', reason: 'candidate_invalid_transition' };
  }
  const allowed = CLOSET_CANDIDATE_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    return { kind: 'rejected', reason: 'candidate_invalid_transition' };
  }
  return { kind: 'ok', from, to };
}

export function canTransition(from: unknown, to: unknown): boolean {
  return evaluateTransition(from, to).kind === 'ok';
}

// ── UI metadata ──────────────────────────────────────────────────────────────

const UI_METADATA: Readonly<Record<ClosetCandidateStatus, ClosetCandidateStatusUIMetadata>> =
  Object.freeze({
    queued: {
      progressLabel: 'Waiting to start',
      isActionable: false,
      canRetry: false,
      canEditMetadata: false,
      canReject: true,
    },
    preparing: {
      progressLabel: 'Preparing photo',
      isActionable: false,
      canRetry: false,
      canEditMetadata: false,
      canReject: true,
    },
    waiting_for_network: {
      progressLabel: 'Waiting for a connection',
      isActionable: false,
      // Manual retry is offered here: the user may know they are back online
      // before anything the app can observe tells it so.
      canRetry: true,
      canEditMetadata: false,
      canReject: true,
    },
    classifying: {
      progressLabel: 'Identifying',
      isActionable: false,
      canRetry: false,
      canEditMetadata: false,
      canReject: true,
    },
    needs_manual_classification: {
      progressLabel: 'Needs a category',
      isActionable: true,
      canRetry: true,
      canEditMetadata: true,
      canReject: true,
    },
    ready_for_review: {
      progressLabel: 'Ready to review',
      isActionable: true,
      canRetry: false,
      canEditMetadata: true,
      canReject: true,
    },
    duplicate: {
      progressLabel: 'Already in your Closet',
      isActionable: true,
      canRetry: false,
      canEditMetadata: false,
      canReject: true,
    },
    failed: {
      progressLabel: "Couldn't identify this",
      isActionable: true,
      canRetry: true,
      canEditMetadata: false,
      canReject: true,
    },
    saving: {
      progressLabel: 'Saving to Closet',
      isActionable: false,
      canRetry: false,
      canEditMetadata: false,
      canReject: false,
    },
    saved: {
      progressLabel: 'Saved',
      isActionable: false,
      canRetry: false,
      canEditMetadata: false,
      canReject: false,
    },
    rejected: {
      progressLabel: 'Removed',
      isActionable: false,
      canRetry: false,
      canEditMetadata: false,
      canReject: false,
    },
  });

const UNKNOWN_UI_METADATA: ClosetCandidateStatusUIMetadata = Object.freeze({
  progressLabel: 'Unavailable',
  isActionable: false,
  canRetry: false,
  canEditMetadata: false,
  canReject: true,
});

/**
 * Presentation for a status. Derived on read, never stored on the record.
 *
 * Fails closed on an unrecognised status: a record written by a newer build must
 * render as inert-but-removable rather than acquiring affordances this build
 * cannot honour.
 */
export function statusUIMetadata(status: unknown): ClosetCandidateStatusUIMetadata {
  if (!isClosetCandidateStatus(status)) return UNKNOWN_UI_METADATA;
  return UI_METADATA[status];
}
