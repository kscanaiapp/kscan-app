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
  /**
   * LEGACY, and deliberately neutral now.
   *
   * This copy used to read "You've reached the try-on limit for now" and was
   * emitted for THREE different situations, two of which had nothing to do
   * with the customer's allowance. The server no longer sends this code; it
   * can still arrive from an older deployment, so it keeps copy that is true
   * whichever of the three it was.
   */
  rate_limited: {
    message: 'Try-on is unavailable right now. Try again shortly.',
    retryable: true,
  },
  /** The ONE place a limit may be mentioned, because here there really is one. */
  quota_exhausted: {
    message: "You've reached the try-on limit for now. Try again later.",
    retryable: true,
  },
  /**
   * The customer's try-on is already running. Not retryable on purpose: a
   * "Try again" button here asks for the duplicate submission idempotency
   * just prevented.
   */
  request_in_flight: {
    message: 'This try-on is already running. Give it a moment.',
    retryable: false,
  },
  /** K Scan is being throttled, not the customer. Says so, and names no
   *  vendor, status code or provider identity. */
  provider_busy: {
    message: 'Photo try-on is temporarily busy. Try again shortly.',
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

/**
 * Client copy of the server's Retry-After window
 * (supabase/functions/vto-generate/vtoContract.ts, VTO_RETRY_AFTER_{MIN,MAX}_SECONDS).
 * Re-declared rather than imported because the server module is Deno source;
 * `__tests__/vtoDecisionLoop.test.js` pins the two copies equal.
 */
export const VTO_CLIENT_RETRY_AFTER_MIN_SECONDS = 1;
export const VTO_CLIENT_RETRY_AFTER_MAX_SECONDS = 3600;

/**
 * Accepts only a whole number of seconds inside the server's window. The
 * server already validated it; this is the client refusing to trust the wire
 * blindly. Anything else is "no guidance" -- discarded, never clamped, for the
 * same reason the server discards: a clamped wait is a wait nobody promised.
 */
export function normalizeVtoRetryAfterSeconds(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined;
  if (value < VTO_CLIENT_RETRY_AFTER_MIN_SECONDS || value > VTO_CLIENT_RETRY_AFTER_MAX_SECONDS) {
    return undefined;
  }
  return value;
}

/** Normalizes anything into a K Scan failure. Unrecognised input becomes
 *  'unknown' -- a provider string is never passed through as a message. */
export function toVtoFailure(
  code: unknown,
  guidance?: { retryAfterSeconds?: unknown },
): VtoFailure {
  const resolved: VtoFailureCode = isVtoFailureCode(code) ? code : 'unknown';
  const entry = COPY[resolved];
  const failure: VtoFailure = { code: resolved, message: entry.message, retryable: entry.retryable };
  // Guidance only means something where a retry is honest in the first place.
  const retryAfterSeconds = entry.retryable
    ? normalizeVtoRetryAfterSeconds(guidance?.retryAfterSeconds)
    : undefined;
  if (retryAfterSeconds !== undefined) failure.retryAfterSeconds = retryAfterSeconds;
  return failure;
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
