/**
 * Scan journey states — client mirror of
 * `supabase/functions/_shared/scanJourneyState.ts`.
 *
 * Duplicated rather than imported: the Edge module is Deno TypeScript with
 * `.ts` import specifiers and Deno globals, and pulling it into the Metro
 * bundle would drag a server runtime into the app. A five-member string union
 * is cheap to mirror, and `__tests__/scanJourneyContractParity.test.js` fails if
 * the two ever disagree — which is the actual risk being managed.
 */

export type ScanJourneyState =
  /** Several garments detected. The backend refuses to guess which one. */
  | 'MULTI_ITEM_SELECTION_REQUIRED'
  /** One garment identified. Product retrieval has not run or was skipped. */
  | 'FASHION_IDENTIFIED'
  /** Product candidates exist but are not enriched or tiered. */
  | 'CANDIDATES_READY'
  /** Deduped, grouped and tiered. The complete answer. */
  | 'ENRICHED'
  /** Ran to completion and found nothing defensible. Not an error. */
  | 'NO_CONFIDENT_MATCH'
  /** The request could not be completed. */
  | 'FAILED';

export const SCAN_JOURNEY_STATES: ScanJourneyState[] = [
  'MULTI_ITEM_SELECTION_REQUIRED',
  'FASHION_IDENTIFIED',
  'CANDIDATES_READY',
  'ENRICHED',
  'NO_CONFIDENT_MATCH',
  'FAILED',
];

/** Whether the journey is blocked on the user before it can continue. */
export function requiresUserAction(state: ScanJourneyState): boolean {
  return state === 'MULTI_ITEM_SELECTION_REQUIRED';
}

/** Whether the journey has finished, successfully or not. */
export function isTerminalState(state: ScanJourneyState): boolean {
  return state === 'ENRICHED' || state === 'NO_CONFIDENT_MATCH' || state === 'FAILED';
}

/**
 * Whether a state means "there is something to show the user".
 *
 * `NO_CONFIDENT_MATCH` is included: telling someone honestly that nothing
 * confident was found is a result, and hiding it leaves them looking at a
 * spinner that never resolves.
 */
export function hasPresentableResult(state: ScanJourneyState): boolean {
  return state !== 'FAILED' && state !== 'MULTI_ITEM_SELECTION_REQUIRED';
}
