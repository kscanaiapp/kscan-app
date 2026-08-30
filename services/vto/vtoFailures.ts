/**
 * VTO failure taxonomy → user-facing copy.
 *
 * The UI never sees a provider error string, an HTTP body, or a stack. It
 * sees one of these. Anything unrecognised degrades to 'unknown' rather than
 * leaking whatever arrived.
 */

import { VTO_FAILURE_CODES, type VtoFailure, type VtoFailureCode } from '../../types/vto';

const CODE_SET = new Set<string>(VTO_FAILURE_CODES);

interface CopyEntry {
  message: string;
  retryable: boolean;
}

/** Retryability is a promise about the NEXT attempt: it is true only where
 *  pressing "Try again" could plausibly succeed without the user changing
 *  anything but the moment. An entitlement or a disabled feature is not that. */
const COPY: Readonly<Record<VtoFailureCode, CopyEntry>> = {
  invalid_person_input: {
    message: 'Choose a clear photo of yourself and try again.',
    retryable: true,
  },
  invalid_garment_input: {
    message: "This item's photo can't be used for try-on.",
    retryable: false,
  },
  unsupported_category: {
    message: "Try-on isn't available for this item yet.",
    retryable: false,
  },
  provider_rejected_input: {
    message: "That photo didn't work for try-on. Try a clear, front-facing one.",
    retryable: true,
  },
  provider_moderation: {
    message: "That photo can't be used for try-on. Try a different one.",
    retryable: true,
  },
  provider_timeout: {
    message: 'This is taking longer than expected. Try again.',
    retryable: true,
  },
  provider_unavailable: {
    message: 'Try-on is unavailable right now. Try again shortly.',
    retryable: true,
  },
  rate_limited: {
    message: "You've reached the try-on limit for now. Try again later.",
    retryable: true,
  },
  generation_failed: {
    message: "The try-on didn't come out. Try again.",
    retryable: true,
  },
  invalid_output: {
    message: "The try-on didn't come out. Try again.",
    retryable: true,
  },
  authorization_failed: {
    message: "We couldn't verify your account. Sign in and try again.",
    retryable: false,
  },
  entitlement_required: {
    message: 'Try It On is available with K+.',
    retryable: false,
  },
  feature_disabled: {
    message: 'Try-on is temporarily unavailable.',
    retryable: false,
  },
  network_failure: {
    message: 'Check your connection and try again.',
    retryable: true,
  },
  cancelled: {
    message: 'Try-on cancelled.',
    retryable: true,
  },
  unknown: {
    message: 'Something went wrong. Try again.',
    retryable: true,
  },
};

export function isVtoFailureCode(value: unknown): value is VtoFailureCode {
  return typeof value === 'string' && CODE_SET.has(value);
}

/** Normalizes anything into a K Scan failure. Unrecognised input becomes
 *  'unknown' -- a provider string is never passed through as a message. */
export function toVtoFailure(code: unknown): VtoFailure {
  const resolved: VtoFailureCode = isVtoFailureCode(code) ? code : 'unknown';
  const entry = COPY[resolved];
  return { code: resolved, message: entry.message, retryable: entry.retryable };
}

/**
 * Copy for an item that is ineligible before any request is made.
 *
 * The eligibility vocabulary is not the failure vocabulary: two of its
 * reasons describe the item's data rather than a generation attempt, so they
 * are mapped explicitly instead of degrading to 'unknown'.
 */
const INELIGIBILITY_TO_FAILURE: Readonly<Record<string, VtoFailureCode>> = {
  missing_garment_image: 'invalid_garment_input',
  invalid_product_reference: 'invalid_garment_input',
};

export function vtoFailureForIneligibility(reason: string): VtoFailure {
  return toVtoFailure(INELIGIBILITY_TO_FAILURE[reason] ?? reason);
}
