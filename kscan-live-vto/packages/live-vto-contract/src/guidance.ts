/**
 * User guidance states — Section 21 (P1-B3) and Section 26 (P2-A1 diagnostics
 * reuse the same BodyFrame that drives these).
 *
 * "Do not overwhelm the user with simultaneous messages. Prioritize the
 * single highest-value correction." The type is a closed union (one active
 * state at a time) specifically so no caller can accidentally render two
 * guidance messages at once — that constraint is enforced by the type, not
 * just a comment.
 */
export type GuidanceState =
  | 'NO_PERSON'
  | 'MOVE_BACK'
  | 'MOVE_CLOSER'
  | 'CENTER_YOUR_BODY'
  | 'SHOW_BOTH_SHOULDERS'
  | 'MOVE_ARMS_SLIGHTLY_AWAY'
  | 'MORE_LIGHT'
  | 'BACKLIGHT_DETECTED'
  | 'HOLD_STILL'
  | 'READY';

/**
 * Priority order, highest first. The guidance selector picks the first
 * state in this list whose trigger condition is currently true; READY is
 * last because it only holds when nothing else applies.
 *
 * NO_PERSON necessarily outranks everything else (no landmarks to reason
 * about). Framing (too close/far, off-center, shoulders) outranks pose
 * refinement (arms) which outranks lighting, matching the plan's ordering
 * in Section 21. HOLD_STILL is deliberately last-before-READY: it only
 * fires once framing/pose/lighting are already acceptable and the system
 * is waiting out a stability window before capture.
 */
export const GUIDANCE_PRIORITY: readonly GuidanceState[] = [
  'NO_PERSON',
  'MOVE_BACK',
  'MOVE_CLOSER',
  'CENTER_YOUR_BODY',
  'SHOW_BOTH_SHOULDERS',
  'MOVE_ARMS_SLIGHTLY_AWAY',
  'BACKLIGHT_DETECTED',
  'MORE_LIGHT',
  'HOLD_STILL',
  'READY',
];

export interface GuidanceTriggers {
  personDetected: boolean;
  /** Normalized [0,1] torso width; null when personDetected is false. */
  torsoWidthNormalized: number | null;
  /** Normalized [-1,1] horizontal offset of torso center from frame center; null when absent. */
  horizontalOffsetNormalized: number | null;
  bothShouldersVisible: boolean;
  armsOverlappingTorso: boolean;
  meanLuminance: number | null; // [0,1], null until a light sample exists
  backlightDetected: boolean;
  /** True once framing/pose/lighting have all held steady for the required window. */
  stableForCapture: boolean;
}

export interface GuidanceThresholds {
  minTorsoWidthNormalized: number;
  maxTorsoWidthNormalized: number;
  maxHorizontalOffsetNormalized: number;
  minMeanLuminance: number;
}

/**
 * Section 29: "Do not fabricate fixed universal FPS/thermal thresholds
 * before baselines exist... recommend thresholds for human approval."
 * These defaults are placeholders pending the P1-B calibration pass —
 * every field is named explicitly so a reviewer can see and challenge each
 * one individually rather than tuning an opaque blob.
 */
export const DEFAULT_GUIDANCE_THRESHOLDS: GuidanceThresholds = {
  minTorsoWidthNormalized: 0.22,
  maxTorsoWidthNormalized: 0.62,
  maxHorizontalOffsetNormalized: 0.18,
  minMeanLuminance: 0.28,
};

export function selectGuidanceState(
  triggers: GuidanceTriggers,
  thresholds: GuidanceThresholds = DEFAULT_GUIDANCE_THRESHOLDS,
): GuidanceState {
  if (!triggers.personDetected) return 'NO_PERSON';

  if (
    triggers.torsoWidthNormalized !== null &&
    triggers.torsoWidthNormalized > thresholds.maxTorsoWidthNormalized
  ) {
    return 'MOVE_BACK';
  }

  if (
    triggers.torsoWidthNormalized !== null &&
    triggers.torsoWidthNormalized < thresholds.minTorsoWidthNormalized
  ) {
    return 'MOVE_CLOSER';
  }

  if (
    triggers.horizontalOffsetNormalized !== null &&
    Math.abs(triggers.horizontalOffsetNormalized) > thresholds.maxHorizontalOffsetNormalized
  ) {
    return 'CENTER_YOUR_BODY';
  }

  if (!triggers.bothShouldersVisible) return 'SHOW_BOTH_SHOULDERS';

  if (triggers.armsOverlappingTorso) return 'MOVE_ARMS_SLIGHTLY_AWAY';

  if (triggers.backlightDetected) return 'BACKLIGHT_DETECTED';

  if (triggers.meanLuminance !== null && triggers.meanLuminance < thresholds.minMeanLuminance) {
    return 'MORE_LIGHT';
  }

  if (!triggers.stableForCapture) return 'HOLD_STILL';

  return 'READY';
}
