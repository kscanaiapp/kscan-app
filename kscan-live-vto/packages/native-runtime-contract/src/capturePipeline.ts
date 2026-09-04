/**
 * Capture pipeline contract — P3-B amendment Sections 17-19.
 *
 * Two explicitly separate concepts (Section 17): `capturePersonFrame()` (a
 * clean camera frame -- no VTO garment, no masks, no diagnostics, no UI
 * chrome) and `capturePreview()` (the composited Live VTO image). "Never
 * feed the composited preview into generative VTO" is the whole reason
 * these are two commands, not one with a flag -- `assertCleanFrameForHandoff`
 * below is the mechanical enforcement point.
 */

import type { PhotorealIntentState } from '@kscan-live-vto/photoreal-bridge';

export const CAPTURE_COMMANDS = ['capturePersonFrame', 'capturePreview'] as const;
export type CaptureCommand = (typeof CAPTURE_COMMANDS)[number];

export const CAPTURED_FRAME_KINDS = ['PERSON_FRAME', 'PREVIEW'] as const;
export type CapturedFrameKind = (typeof CAPTURED_FRAME_KINDS)[number];

export interface CapturedFrameHandle {
  captureId: string;
  kind: CapturedFrameKind;
  /** Local-only handle, mirroring `ExplicitStillCapture`'s own convention
   *  (`@kscan-live-vto/photoreal-bridge`) -- never raw bytes crossing the
   *  command/event boundary. */
  localUri: string;
  width: number | null;
  height: number | null;
}

/** The one property this whole module exists to make structurally true: a
 *  PREVIEW-kind handle can never be accepted where a PERSON_FRAME is
 *  required for a generative handoff. */
export function assertCleanFrameForHandoff(handle: CapturedFrameHandle): void {
  if (handle.kind !== 'PERSON_FRAME') {
    throw new RangeError(
      `Generative handoff requires a PERSON_FRAME capture, got kind=${handle.kind}. `
      + 'The composited Live VTO preview must never be fed into generative VTO.',
    );
  }
}

// ─── Native capture state machine — Section 18 ─────────────────────────────

export const NATIVE_CAPTURE_STATES = [
  'LIVE_RUNNING',
  'CAPTURE_PRECHECK',
  'CAPTURE_PERSON_FRAME',
  'CAPTURE_CONFIRMATION',
  'GENERATIVE_HANDOFF_READY',
] as const;
export type NativeCaptureState = (typeof NATIVE_CAPTURE_STATES)[number];

export interface NativeCaptureTransition {
  from: NativeCaptureState;
  to: NativeCaptureState;
  requiresExplicitUserAction: true;
}

export const NATIVE_CAPTURE_TRANSITIONS: readonly NativeCaptureTransition[] = [
  { from: 'LIVE_RUNNING', to: 'CAPTURE_PRECHECK', requiresExplicitUserAction: true },
  { from: 'CAPTURE_PRECHECK', to: 'CAPTURE_PERSON_FRAME', requiresExplicitUserAction: true },
  { from: 'CAPTURE_PERSON_FRAME', to: 'CAPTURE_CONFIRMATION', requiresExplicitUserAction: true },
  { from: 'CAPTURE_CONFIRMATION', to: 'GENERATIVE_HANDOFF_READY', requiresExplicitUserAction: true },
];

const NATIVE_TRANSITION_BY_FROM: ReadonlyMap<NativeCaptureState, NativeCaptureTransition> = new Map(
  NATIVE_CAPTURE_TRANSITIONS.map((t) => [t.from, t]),
);

export type NativeCaptureAdvanceResult =
  | { ok: true; from: NativeCaptureState; to: NativeCaptureState }
  | { ok: false; reason: 'terminal_state' | 'unknown_state' };

export function advanceNativeCaptureState(current: NativeCaptureState): NativeCaptureAdvanceResult {
  const transition = NATIVE_TRANSITION_BY_FROM.get(current);
  if (transition) return { ok: true, from: transition.from, to: transition.to };
  return (NATIVE_CAPTURE_STATES as readonly string[]).includes(current)
    ? { ok: false, reason: 'terminal_state' }
    : { ok: false, reason: 'unknown_state' };
}

/** Cancellation from ANY state returns to LIVE_RUNNING -- "The Live session
 *  should survive the request," unconditionally. Mirrors
 *  `@kscan-live-vto/photoreal-bridge`'s `returnToLive()` at the coarser
 *  JS-intent layer -- same guarantee, same shape, two granularities. */
export function cancelNativeCapture(): NativeCaptureState {
  return 'LIVE_RUNNING';
}

// ─── Reconciliation with the JS-side intent machine ────────────────────────

/**
 * `@kscan-live-vto/photoreal-bridge`'s `PhotorealIntentState`
 * (`LIVE_LOCAL`/`CAPTURE_CONSENT`/`STILL_CAPTURED`/`GENERATIVE_HANDOFF_READY`)
 * is the JS-side intent surface a UI reasons about. `NativeCaptureState`
 * above is the more granular NATIVE-side realization of the same journey --
 * CAPTURE_CONSENT alone doesn't distinguish "showing a pre-flight quality
 * check" from "a person frame was just grabbed" from "the user is
 * confirming that specific frame," and the native runtime needs all three
 * as distinct states even though JS only needs to know "still mid-flow."
 * This is a documented many-to-one mapping, not a silent rename -- pinned
 * by a contract test so the two can never silently drift apart.
 */
export const NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT: Readonly<Record<NativeCaptureState, PhotorealIntentState>> = {
  LIVE_RUNNING: 'LIVE_LOCAL',
  CAPTURE_PRECHECK: 'CAPTURE_CONSENT',
  CAPTURE_PERSON_FRAME: 'CAPTURE_CONSENT',
  CAPTURE_CONFIRMATION: 'STILL_CAPTURED',
  GENERATIVE_HANDOFF_READY: 'GENERATIVE_HANDOFF_READY',
};

// ─── Capture quality gate — Section 19 ──────────────────────────────────────

export interface CaptureQualityMeasurements {
  /** Provider-neutral blur estimate (e.g. a normalized Laplacian-variance
   *  style score). Higher = sharper. Exact method is native-implementation-
   *  defined; this contract only fixes the shape every implementation must
   *  produce. */
  sharpnessScore: number;
  meanLuminance: number; // [0,1]
  /** Fraction of the frame the detected torso occupies, [0,1]; null if no
   *  torso was detected at all. */
  torsoFrameFraction: number | null;
  /** null when tracking is not relevant/available for this measurement. */
  trackingConfidence: number | null;
}

export interface CaptureQualityThresholds {
  minSharpnessScore: number;
  minMeanLuminance: number;
  maxMeanLuminance: number;
  minTorsoFrameFraction: number;
  minTrackingConfidence: number;
}

/**
 * PROVISIONAL — REVALIDATE ON REAL DEVICE OUTPUT. Nothing in this program
 * has ever measured a real sharpness/luminance/framing distribution; these
 * are placeholders that make the gate's SHAPE testable, not production-
 * calibrated values. Do not hard-code these into a shipped build without
 * device evidence — see amendment Section 19's identical instruction.
 */
export const PROVISIONAL_CAPTURE_QUALITY_THRESHOLDS: CaptureQualityThresholds = {
  minSharpnessScore: 0.3,
  minMeanLuminance: 0.12,
  maxMeanLuminance: 0.92,
  minTorsoFrameFraction: 0.15,
  minTrackingConfidence: 0.5,
};

export const CAPTURE_QUALITY_FAILURE_REASONS = [
  'severe_blur',
  'severe_underexposure',
  'severe_overexposure',
  'torso_not_framed',
  'tracking_unavailable',
] as const;
export type CaptureQualityFailureReason = (typeof CAPTURE_QUALITY_FAILURE_REASONS)[number];

export type CaptureQualityGateResult =
  | { ok: true }
  | { ok: false; reasons: readonly CaptureQualityFailureReason[] };

/**
 * Collects EVERY failing measurement rather than stopping at the first
 * ("Collect measurements," not "collect the first problem") so a retry UI
 * can address more than one issue per attempt. Failure per Section 19's own
 * contract: NO CLOUD HANDOFF -> RETRY -> LIVE RESUMES -- this function only
 * reports; the retry/resume behavior lives in the capture state machine
 * above (`cancelNativeCapture`).
 */
export function evaluateCaptureQualityGate(
  measurements: CaptureQualityMeasurements,
  thresholds: CaptureQualityThresholds = PROVISIONAL_CAPTURE_QUALITY_THRESHOLDS,
): CaptureQualityGateResult {
  const reasons: CaptureQualityFailureReason[] = [];
  if (measurements.sharpnessScore < thresholds.minSharpnessScore) reasons.push('severe_blur');
  if (measurements.meanLuminance < thresholds.minMeanLuminance) reasons.push('severe_underexposure');
  if (measurements.meanLuminance > thresholds.maxMeanLuminance) reasons.push('severe_overexposure');
  if (
    measurements.torsoFrameFraction === null
    || measurements.torsoFrameFraction < thresholds.minTorsoFrameFraction
  ) {
    reasons.push('torso_not_framed');
  }
  if (
    measurements.trackingConfidence !== null
    && measurements.trackingConfidence < thresholds.minTrackingConfidence
  ) {
    reasons.push('tracking_unavailable');
  }
  return reasons.length === 0 ? { ok: true } : { ok: false, reasons };
}
