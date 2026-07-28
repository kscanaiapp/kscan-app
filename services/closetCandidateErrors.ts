// The stable ClosetCandidate error-code registry (Build 1).
//
// ONE registry. Every code in `CLOSET_CANDIDATE_ERROR_CODES` has exactly one
// entry here, and the completeness of that mapping is asserted by test rather
// than trusted — a code with no entry would otherwise surface as an untyped
// blank message at the exact moment something has already gone wrong.
//
// A RAW BACKEND ERROR IS NEVER DISPLAYED. Provider text and transport exception
// messages can contain request content, a truncated Base64 excerpt, or provider
// output; the user-facing copy here is static and written by us.

import type {
  ClosetCandidateErrorCode,
  ClosetCandidateStatus,
} from '../types/closetCandidate';
import { CLOSET_CANDIDATE_ERROR_CODES } from '../types/closetCandidate';

/**
 * Coarse, non-identifying telemetry buckets. Deliberately few: a category exists
 * to answer "which subsystem is failing", not to re-encode the code.
 */
export const CLOSET_CANDIDATE_ERROR_CATEGORIES = [
  'capacity',
  'media',
  'duplicate',
  'lifecycle',
  'actor',
  'network',
  'classification',
  'persistence',
] as const;

export type ClosetCandidateErrorCategory =
  typeof CLOSET_CANDIDATE_ERROR_CATEGORIES[number];

/**
 * What the user can do next. The UI maps these onto affordances; it does not
 * invent its own recovery vocabulary.
 */
export const CLOSET_CANDIDATE_RECOVERY_ACTIONS = [
  'none',
  'retry',
  'retry_when_online',
  'choose_category',
  'free_up_space',
  'remove_candidates',
  'retake_photo',
  'sign_in',
  'open_existing',
  'discard',
] as const;

export type ClosetCandidateRecoveryAction =
  typeof CLOSET_CANDIDATE_RECOVERY_ACTIONS[number];

export type ClosetCandidateErrorSpec = {
  /** May an AUTOMATIC retry be scheduled for this code? */
  retryable: boolean;
  /** Static, user-safe copy. Never derived from a backend payload. */
  message: string;
  category: ClosetCandidateErrorCategory;
  /**
   * The status a candidate ends up in when this code is raised, or null when the
   * code is raised at INTAKE and no candidate record exists yet to transition.
   */
  transition: ClosetCandidateStatus | null;
  recovery: ClosetCandidateRecoveryAction;
};

/**
 * NON-RETRYABLE BY DESIGN, and each for a specific reason rather than caution:
 *
 *   invalid / unsupported media   — the bytes will not become valid on attempt 2
 *   auth failure                  — a token does not repair itself under retry
 *   actor mismatch / stale        — the write authority is gone, not delayed
 *   expired candidate             — retrying would resurrect a lapsed record
 *   schema corruption             — retrying a corrupt read re-reads corruption
 *   manual classification         — this needs a human decision, not a request
 *   storage failure               — the disk is full until the user acts
 *
 * Automatically retrying any of these spends a paid identification unit on an
 * outcome that is already determined.
 */
const REGISTRY: Readonly<Record<ClosetCandidateErrorCode, ClosetCandidateErrorSpec>> =
  Object.freeze({
    candidate_limit_reached: {
      retryable: false,
      message:
        'You have too many photos waiting for review. Review or remove some before adding more.',
      category: 'capacity',
      transition: null,
      recovery: 'remove_candidates',
    },
    candidate_batch_limit_exceeded: {
      retryable: false,
      message: 'Choose up to 8 items at a time.',
      category: 'capacity',
      transition: null,
      recovery: 'none',
    },
    candidate_storage_insufficient: {
      retryable: false,
      message: 'There is not enough free space on this device to save this photo.',
      category: 'capacity',
      transition: null,
      recovery: 'free_up_space',
    },
    candidate_media_unreadable: {
      retryable: false,
      message: "We couldn't read that photo. Please choose it again.",
      category: 'media',
      transition: 'failed',
      recovery: 'retake_photo',
    },
    candidate_media_unsupported: {
      retryable: false,
      message: 'That image format is not supported.',
      category: 'media',
      transition: 'failed',
      recovery: 'retake_photo',
    },
    candidate_media_normalization_failed: {
      retryable: false,
      message: "We couldn't prepare that photo. Please try a different one.",
      category: 'media',
      transition: 'failed',
      recovery: 'retake_photo',
    },
    candidate_hash_failed: {
      retryable: false,
      message: "We couldn't finish preparing that photo. Please try again.",
      category: 'media',
      transition: 'failed',
      recovery: 'retake_photo',
    },
    duplicate_active_candidate: {
      retryable: false,
      message: 'This photo is already waiting for review.',
      category: 'duplicate',
      transition: null,
      recovery: 'open_existing',
    },
    already_in_closet: {
      retryable: false,
      message: 'Already in Closet',
      category: 'duplicate',
      transition: null,
      recovery: 'open_existing',
    },
    candidate_invalid_transition: {
      retryable: false,
      message: 'That action is not available right now.',
      category: 'lifecycle',
      transition: null,
      recovery: 'none',
    },
    candidate_expired: {
      retryable: false,
      message: 'This draft expired and was removed.',
      category: 'lifecycle',
      transition: null,
      recovery: 'discard',
    },
    candidate_actor_stale: {
      retryable: false,
      message: 'Your session changed. Please try again.',
      category: 'actor',
      transition: null,
      recovery: 'none',
    },
    candidate_actor_required: {
      retryable: false,
      message: 'Please sign in to add items to your Closet.',
      category: 'actor',
      transition: null,
      recovery: 'sign_in',
    },
    candidate_request_aborted: {
      retryable: false,
      message: 'That request was cancelled.',
      category: 'lifecycle',
      transition: null,
      recovery: 'retry',
    },
    candidate_offline: {
      retryable: true,
      message: "You're offline. We'll finish this when you're back online.",
      category: 'network',
      transition: 'waiting_for_network',
      recovery: 'retry_when_online',
    },
    classification_timeout: {
      retryable: true,
      message: 'That took longer than expected. Please try again.',
      category: 'classification',
      transition: 'failed',
      recovery: 'retry',
    },
    classification_rate_limited: {
      retryable: true,
      message: 'Too many requests right now. Please try again shortly.',
      category: 'classification',
      transition: 'failed',
      recovery: 'retry',
    },
    classification_quota_exhausted: {
      retryable: false,
      message: "You've used your identifications for now.",
      category: 'classification',
      transition: 'failed',
      recovery: 'none',
    },
    classification_auth_failed: {
      retryable: false,
      message: 'Please sign in to identify this item.',
      category: 'classification',
      transition: 'failed',
      recovery: 'sign_in',
    },
    classification_malformed_response: {
      retryable: true,
      message: "We couldn't read the result. Please try again.",
      category: 'classification',
      transition: 'failed',
      recovery: 'retry',
    },
    classification_provider_failed: {
      retryable: true,
      message: "We couldn't identify this item. Please try again.",
      category: 'classification',
      transition: 'failed',
      recovery: 'retry',
    },
    classification_contract_rejected: {
      // NOT retryable, and deliberately so. A backend that rejects the Closet
      // contract will keep rejecting it until it is redeployed; retrying spends
      // identification units against a certainty.
      retryable: false,
      message: 'Closet identification is not available in this build yet.',
      category: 'classification',
      transition: 'failed',
      recovery: 'none',
    },
    classification_requires_manual_category: {
      // NOT a technical failure. The request succeeded and returned a valid but
      // taxonomy-less result; the candidate needs a human category, not a retry.
      retryable: false,
      message: 'Choose a category for this item to finish adding it.',
      category: 'classification',
      transition: 'needs_manual_classification',
      recovery: 'choose_category',
    },
    classification_interrupted: {
      retryable: true,
      message: 'This was interrupted. We put it back in the queue.',
      category: 'classification',
      transition: 'queued',
      recovery: 'retry',
    },
    classification_interrupted_repeatedly: {
      // The crash-loop brake. Automatic retry here is exactly the behaviour that
      // would make an app-killing image unstartable.
      retryable: false,
      message: "This photo keeps interrupting. Try a different one.",
      category: 'classification',
      transition: 'failed',
      recovery: 'retake_photo',
    },
    candidate_store_corrupt: {
      retryable: false,
      message: 'Some drafts could not be read and were skipped.',
      category: 'persistence',
      transition: null,
      recovery: 'none',
    },
    candidate_persist_failed: {
      retryable: false,
      message: "We couldn't save that. Please try again.",
      category: 'persistence',
      transition: null,
      recovery: 'retry',
    },
    candidate_cleanup_failed: {
      retryable: false,
      message: 'Some files could not be cleaned up.',
      category: 'persistence',
      transition: null,
      recovery: 'none',
    },
    candidate_store_future_schema: {
      // A NEWER build wrote this record. Not retryable and not repairable by this
      // build: the only correct action is to leave it alone, which is why the
      // transition is null and the recovery is none.
      retryable: false,
      message: 'Some drafts were saved by a newer version of the app.',
      category: 'persistence',
      transition: null,
      recovery: 'none',
    },
    candidate_store_recovery_required: {
      // Emitted when a MUTATION is refused because the manifest could not be read
      // completely. Refusing is the repair: rewriting the manifest from a partial
      // read is what silently destroys the records the read could not interpret.
      retryable: false,
      message: 'Your drafts could not be read completely, so nothing was changed.',
      category: 'persistence',
      transition: null,
      recovery: 'none',
    },
  });

export function isClosetCandidateErrorCode(
  value: unknown,
): value is ClosetCandidateErrorCode {
  return (
    typeof value === 'string' &&
    (CLOSET_CANDIDATE_ERROR_CODES as readonly string[]).includes(value)
  );
}

/**
 * Registry lookup. Returns null for an unknown code rather than a plausible
 * default — a fabricated spec would let an unregistered code silently acquire
 * retry behaviour it was never reviewed for.
 */
export function closetCandidateErrorSpec(
  code: unknown,
): ClosetCandidateErrorSpec | null {
  if (!isClosetCandidateErrorCode(code)) return null;
  return REGISTRY[code];
}

/** Generic copy for an unmapped code. Never blames the user's photo. */
export const CLOSET_CANDIDATE_GENERIC_MESSAGE =
  'Something went wrong. Please try again.';

export function closetCandidateErrorMessage(code: unknown): string {
  return closetCandidateErrorSpec(code)?.message ?? CLOSET_CANDIDATE_GENERIC_MESSAGE;
}

/** True only for codes an AUTOMATIC retry may be scheduled for. */
export function isAutomaticallyRetryable(code: unknown): boolean {
  return closetCandidateErrorSpec(code)?.retryable === true;
}

/**
 * Should a "Try again" affordance be OFFERED for this failure?
 *
 * Broader than `isAutomaticallyRetryable` — a user may retry things we will not
 * retry on their behalf (an offline park, a rate limit they can wait out) — but
 * narrower than "the status is failed". Offering retry for a
 * `classification_contract_rejected` or an exhausted quota invites the user to
 * spend effort on an outcome that is already determined, which reads as the app
 * being broken rather than as a boundary being explained.
 *
 * Derived from the registry's recovery action so the two cannot drift.
 */
export function isUserRetryable(code: unknown): boolean {
  const recovery = closetCandidateErrorSpec(code)?.recovery;
  return recovery === 'retry' || recovery === 'retry_when_online';
}

/** Test/telemetry seam: the registry as data, never mutated at runtime. */
export const __closetCandidateErrorRegistry = REGISTRY;
