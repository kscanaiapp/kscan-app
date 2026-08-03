/**
 * Scan journey application states — shared vocabulary.
 *
 * WHY A SHARED MODULE
 *
 * `scan-identify` and `product-match` both describe where a scan has got to,
 * and before this they described it differently: the scanner used
 * `status: 'completed' | 'failed' | 'non_fashion'` plus a V2 `outcome`, and
 * product-match used `tier` plus `emptyReason`. A client had to join three
 * vocabularies to answer one question — "what do I show right now?" — and the
 * multi-item case was answerable only by INFERENCE (`detectedGarments.length > 0`
 * with a top-level identification that was actually just the first garment).
 *
 * These states are the single answer to that question.
 *
 * NOT A STREAMING PROTOCOL
 *
 * Progressive HTTP streaming is deliberately deferred: there is not enough
 * traffic to justify the transport complexity or the operating cost. These are
 * ordinary response states. A client reaches a later state by making another
 * request, refreshing, or transitioning its own application state — the same
 * way it already handles selected-item follow-ups. Nothing here requires SSE,
 * chunked transfer, or a live connection, and nothing here should be taken as
 * a commitment to add one later.
 */

export type ScanJourneyState =
  /**
   * The image contains more than one garment and the BACKEND WILL NOT GUESS
   * which one the user meant. Terminal for this request: the client must
   * present the candidates and send a selected-item request.
   */
  | 'MULTI_ITEM_SELECTION_REQUIRED'
  /** A single garment is identified. Product retrieval has not run or was skipped. */
  | 'FASHION_IDENTIFIED'
  /** Product candidates exist but have not been enriched or tiered. */
  | 'CANDIDATES_READY'
  /** Candidates are deduped, grouped and tiered. The complete answer. */
  | 'ENRICHED'
  /** Ran to completion and found nothing defensible. Not an error. */
  | 'NO_CONFIDENT_MATCH'
  /** The request could not be completed. */
  | 'FAILED';

export const SCAN_JOURNEY_STATES: readonly ScanJourneyState[] = [
  'MULTI_ITEM_SELECTION_REQUIRED',
  'FASHION_IDENTIFIED',
  'CANDIDATES_READY',
  'ENRICHED',
  'NO_CONFIDENT_MATCH',
  'FAILED',
] as const;

export function isScanJourneyState(value: unknown): value is ScanJourneyState {
  return typeof value === 'string' && (SCAN_JOURNEY_STATES as readonly string[]).includes(value);
}

/**
 * Whether the state requires something from the user before the journey can
 * continue.
 *
 * Only selection qualifies today. `NO_CONFIDENT_MATCH` does not: the user may
 * choose to rescan, but nothing is BLOCKED on them, and conflating "you must
 * act" with "you may act" is how a dead end gets presented as a prompt.
 */
export function requiresUserAction(state: ScanJourneyState): boolean {
  return state === 'MULTI_ITEM_SELECTION_REQUIRED';
}

/** Whether the journey has finished, successfully or not. */
export function isTerminalState(state: ScanJourneyState): boolean {
  return state === 'ENRICHED' || state === 'NO_CONFIDENT_MATCH' || state === 'FAILED';
}

/**
 * Derives the state from what a response actually contains.
 *
 * Deliberately ordered: selection outranks everything, because a multi-item
 * image has no single correct identification to report and any state below
 * would imply one. Failure outranks the rest for the same reason in reverse.
 */
export function deriveScanJourneyState(input: {
  failed?: boolean;
  selectionRequired?: boolean;
  identified?: boolean;
  candidateCount?: number;
  enriched?: boolean;
  confidentMatch?: boolean;
}): ScanJourneyState {
  if (input.failed) return 'FAILED';
  if (input.selectionRequired) return 'MULTI_ITEM_SELECTION_REQUIRED';
  if (input.enriched) {
    return input.confidentMatch ? 'ENRICHED' : 'NO_CONFIDENT_MATCH';
  }
  if ((input.candidateCount ?? 0) > 0) return 'CANDIDATES_READY';
  if (input.identified) return 'FASHION_IDENTIFIED';
  return 'NO_CONFIDENT_MATCH';
}
