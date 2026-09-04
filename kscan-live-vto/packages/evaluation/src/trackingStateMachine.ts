/**
 * Tracking lifecycle reference state machine — emulator-native validation
 * lane, Section 9.
 *
 * `LiveVTOEventName` in `@kscan-live-vto/contract` declares four tracking
 * events (`trackingAcquired`, `trackingWeak`, `trackingLost`,
 * `trackingRecovered`) but nothing before this file decided the transition
 * logic between them. This is that logic, expressed once in TypeScript so it
 * can be tested against the same golden sequences the rest of Section 17
 * already uses, and so the Swift/Kotlin native code has an exact reference
 * to port rather than a free-form re-derivation — the same relationship
 * `packages/asset-pipeline`'s `affineMlsDeformation.ts` already has to its
 * eventual native port.
 *
 * This module has never run inside a native runtime. It is a portable
 * reference tested against synthetic confidence series in Node, not a
 * substitute for on-device validation.
 */

import { isLandmarkPresent, type BodyFrame } from '@kscan-live-vto/contract';

export type TrackingLifecycleState = 'notAcquired' | 'tracking' | 'weak' | 'lost';

export interface TrackingLifecycleThresholds {
  /** Below this, tracking is considered fully lost. */
  lossThreshold: number;
  /** Below this (and at/above lossThreshold), tracking is held but degraded. */
  weakThreshold: number;
  /** At/above this, tracking counts as acquired or recovered. */
  reacquireThreshold: number;
}

/**
 * Same loss/reacquire values as `detectTrackingEvents`'s defaults
 * (metrics.ts), so the two stay comparable on the same sequence.
 * `weakThreshold` sits between them: a confidence dip that stays above
 * `lossThreshold` but has clearly stopped being confident.
 */
export const DEFAULT_TRACKING_LIFECYCLE_THRESHOLDS: TrackingLifecycleThresholds = {
  lossThreshold: 0.3,
  weakThreshold: 0.5,
  reacquireThreshold: 0.6,
};

/**
 * The exact fields this state machine is entitled to emit for each
 * transition. Deliberately a strict subset of `LiveVTOEventPayloads`:
 *
 * - `trackingAcquired` / `trackingRecovered` carry only `confidence`, which
 *   is all this machine knows.
 * - `trackingWeak`'s real payload also needs `guidance: GuidanceState`,
 *   which is a UI-framing concern this machine does not own (see
 *   `packages/live-vto-contract/src/guidance.ts`). The caller merges it in;
 *   this machine cannot construct a wrong one because it never has the key.
 * - `trackingLost` carries no fields — `Record<string, never>` in the
 *   contract — so this machine emits an empty payload for it, not a
 *   `confidence` value that would violate the contract shape.
 *
 * No transition here can produce a key from `FORBIDDEN_EVENT_PAYLOAD_KEYS`:
 * the type only has room for a single float. See
 * `__tests__/trackingStateMachine.test.ts`'s boundary test for the
 * mechanical proof.
 */
export type TrackingLifecycleTransition =
  | { emits: 'trackingAcquired'; timestamp: number; payload: { confidence: number } }
  | { emits: 'trackingWeak'; timestamp: number; payload: { confidence: number } }
  | { emits: 'trackingLost'; timestamp: number; payload: Record<string, never> }
  | { emits: 'trackingRecovered'; timestamp: number; payload: { confidence: number } }
  | { emits: null; timestamp: number; payload: null };

export interface TrackingLifecycleStep {
  state: TrackingLifecycleState;
  transition: TrackingLifecycleTransition;
}

/** A transition that actually emits an event — excludes the null-emit case. */
export type EmittedTrackingLifecycleTransition = Exclude<TrackingLifecycleTransition, { emits: null }>;

function isEmitted(t: TrackingLifecycleTransition): t is EmittedTrackingLifecycleTransition {
  return t.emits !== null;
}

/**
 * One step of the state machine. Pure function of (previous state,
 * confidence, timestamp) — no hidden mutable state, so a native port can
 * run it per-frame without needing to reconstruct history.
 */
export function stepTrackingLifecycle(
  previous: TrackingLifecycleState,
  confidence: number,
  timestamp: number,
  thresholds: TrackingLifecycleThresholds = DEFAULT_TRACKING_LIFECYCLE_THRESHOLDS,
): TrackingLifecycleStep {
  const none = (state: TrackingLifecycleState): TrackingLifecycleStep => ({
    state,
    transition: { emits: null, timestamp, payload: null },
  });

  switch (previous) {
    case 'notAcquired':
      if (confidence >= thresholds.reacquireThreshold) {
        return { state: 'tracking', transition: { emits: 'trackingAcquired', timestamp, payload: { confidence } } };
      }
      return none('notAcquired');

    case 'tracking':
      if (confidence < thresholds.lossThreshold) {
        return { state: 'lost', transition: { emits: 'trackingLost', timestamp, payload: {} } };
      }
      if (confidence < thresholds.weakThreshold) {
        return { state: 'weak', transition: { emits: 'trackingWeak', timestamp, payload: { confidence } } };
      }
      return none('tracking');

    case 'weak':
      if (confidence < thresholds.lossThreshold) {
        return { state: 'lost', transition: { emits: 'trackingLost', timestamp, payload: {} } };
      }
      if (confidence >= thresholds.weakThreshold) {
        // Recovered from weak back to full tracking without a full loss —
        // there is no "no longer weak" event in the contract, so this is
        // silent, matching the same restraint as guidance.ts's "do not
        // overwhelm the user with simultaneous messages".
        return none('tracking');
      }
      return none('weak');

    case 'lost':
      if (confidence >= thresholds.reacquireThreshold) {
        return { state: 'tracking', transition: { emits: 'trackingRecovered', timestamp, payload: { confidence } } };
      }
      return none('lost');
  }
}

/**
 * Runs the state machine across a full `BodyFrame` series, exactly the
 * input shape `runGoldenSequence` (goldenRunner.ts) already consumes — so
 * the same three synthetic golden sequences from `syntheticFixtures.ts`
 * exercise both the metrics report and this lifecycle log in one pass.
 */
export function runTrackingLifecycle(
  series: readonly BodyFrame[],
  thresholds: TrackingLifecycleThresholds = DEFAULT_TRACKING_LIFECYCLE_THRESHOLDS,
): EmittedTrackingLifecycleTransition[] {
  let state: TrackingLifecycleState = 'notAcquired';
  const emitted: EmittedTrackingLifecycleTransition[] = [];
  for (const frame of series) {
    const step = stepTrackingLifecycle(state, frame.trackingConfidence, frame.timestamp, thresholds);
    state = step.state;
    if (isEmitted(step.transition)) emitted.push(step.transition);
  }
  return emitted;
}

/**
 * Whether a BodyFrame carries enough landmarks to be worth feeding to the
 * lifecycle machine at all — distinct from `trackingConfidence`, since a
 * provider could in principle report a confidence value with every core
 * landmark absent. Used by the native-replay-fixture harness to catch a
 * malformed fixture before it silently produces a misleading lifecycle log.
 */
export function hasMinimalPose(frame: BodyFrame): boolean {
  return (
    isLandmarkPresent(frame.leftShoulder) &&
    isLandmarkPresent(frame.rightShoulder) &&
    (isLandmarkPresent(frame.leftHip) || isLandmarkPresent(frame.rightHip))
  );
}
