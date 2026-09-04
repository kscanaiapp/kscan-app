/**
 * Photoreal intent contract — Phase 3 Section 21.
 *
 * `requestPhotorealCapture()`'s effect, expressed as a pure state machine.
 * The user must explicitly initiate it; there is no automatic live-frame
 * upload.
 *
 * This refines, rather than replaces, the existing Phase 1-2 cloud
 * transition boundary in `@kscan-live-vto/contract`'s `privacy.ts`
 * (`LiveVTOPrivacyPhase`, `AI_PHOTO_TRANSITION`): that contract already
 * fences `'live'` from `'aiPhotoRequested'`/`'aiPhotoInFlight'` behind an
 * explicit user action. Phase 3 adds the missing middle step Phase 1-2's own
 * `docs/vto-integration-candidate.md` called for — an explicit
 * STILL_CAPTURED state between "the user asked for Photoreal" and "a request
 * is ready to hand to the existing governed VTO" — because the bridge (see
 * `bridgePayload.ts`) needs a captured, confirmed still to exist as a
 * distinct, inspectable artifact before any handoff, not just an intent
 * flag.
 */

import type { LiveVTOPrivacyPhase } from '@kscan-live-vto/contract';

export const PHOTOREAL_INTENT_STATES = [
  'LIVE_LOCAL',
  'CAPTURE_CONSENT',
  'STILL_CAPTURED',
  'GENERATIVE_HANDOFF_READY',
] as const;
export type PhotorealIntentState = (typeof PHOTOREAL_INTENT_STATES)[number];

/**
 * Correspondence with the existing `LiveVTOPrivacyPhase`, documented rather
 * than silently duplicated: LIVE_LOCAL is 'live'; CAPTURE_CONSENT and
 * STILL_CAPTURED both fall under 'aiPhotoRequested' (the user has committed
 * to Photoreal but no network call has happened yet -- consent and capture
 * are both still fully local); GENERATIVE_HANDOFF_READY is the point at
 * which a caller may legitimately drive the existing contract to
 * 'aiPhotoInFlight' by actually invoking the bridge (outside this module's
 * scope -- see `mockBridgeAdapter.ts`, which is deliberately test-only and
 * performs no such invocation).
 */
export const PHOTOREAL_STATE_TO_PRIVACY_PHASE: Readonly<Record<PhotorealIntentState, LiveVTOPrivacyPhase>> = {
  LIVE_LOCAL: 'live',
  CAPTURE_CONSENT: 'aiPhotoRequested',
  STILL_CAPTURED: 'aiPhotoRequested',
  GENERATIVE_HANDOFF_READY: 'aiPhotoRequested',
};

export interface PhotorealIntentTransition {
  from: PhotorealIntentState;
  to: PhotorealIntentState;
  /** Always true today, mirroring `PrivacyPhaseTransition.requiresExplicitUserAction`
   *  in the Phase 1-2 contract -- kept explicit rather than assumed so a
   *  future transition cannot silently become automatic without this field
   *  being touched. */
  requiresExplicitUserAction: true;
}

export const PHOTOREAL_INTENT_TRANSITIONS: readonly PhotorealIntentTransition[] = [
  { from: 'LIVE_LOCAL', to: 'CAPTURE_CONSENT', requiresExplicitUserAction: true },
  { from: 'CAPTURE_CONSENT', to: 'STILL_CAPTURED', requiresExplicitUserAction: true },
  { from: 'STILL_CAPTURED', to: 'GENERATIVE_HANDOFF_READY', requiresExplicitUserAction: true },
];

const TRANSITION_BY_FROM: ReadonlyMap<PhotorealIntentState, PhotorealIntentTransition> = new Map(
  PHOTOREAL_INTENT_TRANSITIONS.map((t) => [t.from, t]),
);

export type PhotorealIntentAdvanceResult =
  | { ok: true; from: PhotorealIntentState; to: PhotorealIntentState }
  | { ok: false; reason: 'terminal_state' | 'unknown_state' };

/**
 * The one legitimate way to advance this state machine. Every call
 * represents one explicit user action (a tap), never a timer or a
 * perception/tracking event: "a background timer or tracking event must
 * never trigger cloud upload" is enforced here simply by this function
 * taking no such input -- there is nothing a timer could call that would do
 * anything, because the only argument is the machine's own current state,
 * and the only effect is returning what the next state WOULD be. Nothing in
 * this file performs I/O, and nothing auto-invokes this function.
 */
export function requestPhotorealCapture(current: PhotorealIntentState): PhotorealIntentAdvanceResult {
  const transition = TRANSITION_BY_FROM.get(current);
  if (transition) return { ok: true, from: transition.from, to: transition.to };
  return (PHOTOREAL_INTENT_STATES as readonly string[]).includes(current)
    ? { ok: false, reason: 'terminal_state' }
    : { ok: false, reason: 'unknown_state' };
}

/** Returns the Live session to its starting point. Every defined Photoreal
 *  failure resolves here (see `failureModes.ts`) -- the machine never stays
 *  stranded mid-transition. */
export function returnToLive(): PhotorealIntentState {
  return 'LIVE_LOCAL';
}
