/**
 * BodyFrame — provider-neutral pose/body-landmark contract.
 *
 * Section 21 (P1-B2): "Do not hard-bind downstream code to MediaPipe IDs."
 * Every field maps FROM a specific pose provider's raw output INTO this
 * shape. The first implementation adapts MediaPipe Pose Landmarker output,
 * but no downstream package (body-model, asset-pipeline, evaluation, or
 * any native renderer) may import provider-specific types or landmark
 * index constants. Only an adapter in the native camera/pose layer may
 * know about the underlying provider.
 *
 * All spatial fields are normalized image-space coordinates in [0, 1]
 * (u = horizontal, v = vertical, origin top-left, front-camera mirrored
 * to match what the user sees), consistent with GarmentControlPoint's
 * (u, v) space in garment-contract so the two can be reasoned about
 * together without a third coordinate system.
 */

export interface Point2D {
  u: number;
  v: number;
}

/**
 * A landmark that may be absent (occluded, out of frame, or the provider
 * reported low confidence). Section 21: "Missing values must be
 * representable." Never substitute a guessed (0,0) or a stale value here
 * — represent absence explicitly and let consumers decide how to handle
 * it (freeze, fade, interpolate — see P2-D).
 */
export type Landmark =
  | { present: true; point: Point2D; confidence: number }
  | { present: false };

export const ABSENT_LANDMARK: Landmark = { present: false };

export interface BodyFrame {
  /** Monotonic capture timestamp in milliseconds, native clock. Required for P2-A staleness rejection and interpolation. */
  timestamp: number;

  headCenter: Landmark;
  noseOrHeadDirection: Landmark;
  neckCenter: Landmark;

  leftShoulder: Landmark;
  rightShoulder: Landmark;

  leftElbow: Landmark;
  rightElbow: Landmark;

  leftWrist: Landmark;
  rightWrist: Landmark;

  chestCenter: Landmark;
  waistCenter: Landmark;

  leftHip: Landmark;
  rightHip: Landmark;

  /** Derived, not raw-provider: midpoint of shoulder/hip landmarks. */
  torsoCenter: Landmark;
  /** Derived, normalized [0,1] image-space width. Absent if either shoulder is absent. */
  torsoWidth: number | null;
  /** Derived, normalized [0,1] image-space height. Absent if shoulder or hip midpoints are absent. */
  torsoHeight: number | null;
  /** Radians, +/- from camera-facing. Absent if insufficient landmarks. */
  torsoRotation: number | null;

  /** Overall frame-level tracking confidence in [0, 1], independent of any single landmark's confidence. */
  trackingConfidence: number;
}

export const BODY_FRAME_LANDMARK_KEYS = [
  'headCenter',
  'noseOrHeadDirection',
  'neckCenter',
  'leftShoulder',
  'rightShoulder',
  'leftElbow',
  'rightElbow',
  'leftWrist',
  'rightWrist',
  'chestCenter',
  'waistCenter',
  'leftHip',
  'rightHip',
  'torsoCenter',
] as const satisfies readonly (keyof BodyFrame)[];

export type BodyFrameLandmarkKey = (typeof BODY_FRAME_LANDMARK_KEYS)[number];

export function isLandmarkPresent(landmark: Landmark): landmark is Extract<Landmark, { present: true }> {
  return landmark.present === true;
}

/** An empty BodyFrame with every landmark absent — the NO PERSON guidance state. */
export function emptyBodyFrame(timestamp: number): BodyFrame {
  return {
    timestamp,
    headCenter: ABSENT_LANDMARK,
    noseOrHeadDirection: ABSENT_LANDMARK,
    neckCenter: ABSENT_LANDMARK,
    leftShoulder: ABSENT_LANDMARK,
    rightShoulder: ABSENT_LANDMARK,
    leftElbow: ABSENT_LANDMARK,
    rightElbow: ABSENT_LANDMARK,
    leftWrist: ABSENT_LANDMARK,
    rightWrist: ABSENT_LANDMARK,
    chestCenter: ABSENT_LANDMARK,
    waistCenter: ABSENT_LANDMARK,
    leftHip: ABSENT_LANDMARK,
    rightHip: ABSENT_LANDMARK,
    torsoCenter: ABSENT_LANDMARK,
    torsoWidth: null,
    torsoHeight: null,
    torsoRotation: null,
    trackingConfidence: 0,
  };
}
