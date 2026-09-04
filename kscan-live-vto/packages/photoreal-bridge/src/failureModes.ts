/**
 * Photoreal failure modes — Phase 3 Section 26.
 *
 * "Live Preview must remain usable where possible. A Photoreal failure must
 * not corrupt the local Live session." Enforced structurally: every defined
 * failure code maps to the exact same recovery outcome
 * (`returnToLive()` / `LIVE_LOCAL`, session still usable), so there is no
 * code path where a failure could leave the machine in an undefined or
 * stranded state -- there is only one `PhotorealFailureOutcome` shape and
 * one function that produces it, for every failure code.
 */

import { returnToLive, type PhotorealIntentState } from './photorealIntent';

export const PHOTOREAL_FAILURE_CODES = [
  'capture_cancelled',
  'no_usable_still',
  'garment_not_eligible',
  'bridge_contract_mismatch',
  'feature_disabled',
  'entitlement_missing',
  'provider_unavailable',
  'generation_failed',
] as const;
export type PhotorealFailureCode = (typeof PHOTOREAL_FAILURE_CODES)[number];

export interface PhotorealFailureOutcome {
  code: PhotorealFailureCode;
  resultingState: PhotorealIntentState;
  liveSessionRemainsUsable: true;
}

/**
 * The one handler every Photoreal failure passes through. There is
 * deliberately no per-code branching that could special-case one failure
 * into a different (implicitly worse) outcome -- see the module header.
 */
export function handlePhotorealFailure(code: PhotorealFailureCode): PhotorealFailureOutcome {
  return {
    code,
    resultingState: returnToLive(),
    liveSessionRemainsUsable: true,
  };
}
