/**
 * BodyFrame mapping contract — P3-B amendment Section 10-11.
 *
 * "MediaPipe Pose Landmarker is an authorized candidate for investigation."
 * This module is pure math: it maps an ALREADY-COMPUTED landmark array
 * (produced by a real model, a replay, or a synthetic test) onto the
 * existing `BodyFrame` contract. It does not run, load, or bundle any
 * model -- no inference happens anywhere in this file, so it is safely
 * compiler-independent and directly testable against synthetic landmark
 * arrays, the same "prove the math before the runtime exists" pattern
 * Phase 1-2 already used for `nativeBridgeCompat.test.ts`.
 *
 * PROVENANCE HONESTY: producing correct BodyFrame values from this function
 * given synthetic input proves the ARITHMETIC is right. It proves nothing
 * about MediaPipe's actual accuracy, and calling this function is not
 * "REAL_MODEL provenance" by itself -- see `frameSource.ts`'s
 * `assertRealModelProvenanceIsEarned`, which this function's caller must
 * still satisfy once a real model actually runs.
 */

import type { BodyFrame, Landmark, Point2D } from '@kscan-live-vto/contract';
import { emptyBodyFrame } from '@kscan-live-vto/contract';

/**
 * MediaPipe Pose Landmarker's published 33-point BlazePose topology
 * (indices 0-32; only the subset `BodyFrame` needs is used below, the rest
 * are recorded for completeness so a future extension doesn't have to
 * re-derive the table). This is public model documentation, not a
 * measurement made in this session -- no model has run here to confirm it.
 */
export const MEDIAPIPE_POSE_LANDMARK_INDEX = {
  nose: 0,
  leftEyeInner: 1, leftEye: 2, leftEyeOuter: 3,
  rightEyeInner: 4, rightEye: 5, rightEyeOuter: 6,
  leftEar: 7, rightEar: 8,
  mouthLeft: 9, mouthRight: 10,
  leftShoulder: 11, rightShoulder: 12,
  leftElbow: 13, rightElbow: 14,
  leftWrist: 15, rightWrist: 16,
  leftPinky: 17, rightPinky: 18,
  leftIndex: 19, rightIndex: 20,
  leftThumb: 21, rightThumb: 22,
  leftHip: 23, rightHip: 24,
  leftKnee: 25, rightKnee: 26,
  leftAnkle: 27, rightAnkle: 28,
  leftHeel: 29, rightHeel: 30,
  leftFootIndex: 31, rightFootIndex: 32,
} as const;

export interface MediaPipePoseLandmark {
  /** Normalized [0,1] image-space, origin top-left -- MediaPipe's own
   *  documented convention, matching BodyFrame's before any mirroring
   *  consideration (see CameraBufferConvention below). */
  x: number;
  y: number;
  /** Depth, relative to the hips; unused by BodyFrame (2D-only contract)
   *  but accepted so a caller can pass MediaPipe's real output shape
   *  unchanged. */
  z: number;
  /** MediaPipe reports two related confidence-like values (visibility:
   *  likelihood the landmark is visible vs. occluded; presence: likelihood
   *  it exists in the frame at all). This mapping uses whichever the caller
   *  provides, min'd together when both are given -- BodyFrame has only one
   *  confidence field per landmark, and understating confidence is the
   *  safe direction. */
  visibility?: number;
  presence?: number;
}

/**
 * Whether the landmark buffer this function receives was inferred against
 * the RAW front-camera sensor frame or a DISPLAY-MIRRORED (selfie-flipped)
 * frame. This is a REAL, UNRESOLVED implementation decision -- Section 21
 * of the Phase 1 plan and this program's own established convention is
 * that `BodyFrame`'s `u` axis has the wearer's own anatomical left at
 * LOWER `u` (mirrored/selfie convention; confirmed against
 * `@kscan-live-vto/static-renderer`'s own fixture test: "person fixture
 * puts the wearer's left shoulder at lower u"). A raw, unmirrored
 * front-camera frame has the OPPOSITE arrangement (the subject faces the
 * sensor, so anatomical left appears at the HIGHER-x side of the raw
 * buffer -- the same geometry as another person facing you, or your own
 * mirror reflection). Passing the wrong value here silently reverses every
 * left/right label. This has NOT been verified against a real front
 * camera in this or any prior session -- it must be confirmed on first
 * real device capture, per `docs/vto-native-device-handoff.md` Section 3's
 * "raise the wearer's left hand and confirm it appears at lower u."
 */
export type CameraBufferConvention = 'raw' | 'already-mirrored';

export interface BodyFrameMappingOptions {
  cameraBufferConvention: CameraBufferConvention;
  /** Below this confidence, a landmark is reported absent rather than a
   *  low-confidence present value -- PROVISIONAL, REVALIDATE ON REAL DEVICE
   *  OUTPUT, same status as every other unmeasured threshold in this
   *  program. */
  presenceThreshold?: number;
}

const DEFAULT_PRESENCE_THRESHOLD = 0.5;

function mirrorU(x: number, convention: CameraBufferConvention): number {
  return convention === 'raw' ? 1 - x : x;
}

function toLandmark(
  raw: MediaPipePoseLandmark | undefined,
  convention: CameraBufferConvention,
  presenceThreshold: number,
): Landmark {
  if (!raw) return { present: false };
  const confidence = Math.min(raw.visibility ?? 1, raw.presence ?? 1);
  if (confidence < presenceThreshold) return { present: false };
  const point: Point2D = { u: mirrorU(raw.x, convention), v: raw.y };
  return { present: true, point, confidence };
}

function midpoint(a: Landmark, b: Landmark): Landmark {
  if (!a.present || !b.present) return { present: false };
  return {
    present: true,
    point: { u: (a.point.u + b.point.u) / 2, v: (a.point.v + b.point.v) / 2 },
    confidence: Math.min(a.confidence, b.confidence),
  };
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

/**
 * Maps a MediaPipe Pose Landmarker output array (indexed per
 * `MEDIAPIPE_POSE_LANDMARK_INDEX`) onto `BodyFrame`. `chestCenter` and
 * `waistCenter` have no direct MediaPipe equivalent and are DERIVED
 * (shoulder midpoint and hip midpoint respectively) -- an approximation,
 * not a MediaPipe-native measurement, exactly like `torsoWidth`/
 * `torsoHeight`/`torsoRotation` below. None of these derivations have been
 * checked against a real body; they follow the same shoulder/hip-midpoint
 * geometry `@kscan-live-vto/static-renderer`'s own synthetic fixtures use
 * for consistency with the existing reference renderer, not because it is
 * known correct for real anatomy.
 */
export function mapMediaPipeLandmarksToBodyFrame(
  landmarks: readonly (MediaPipePoseLandmark | undefined)[],
  timestamp: number,
  options: BodyFrameMappingOptions,
): BodyFrame {
  const { cameraBufferConvention } = options;
  const presenceThreshold = options.presenceThreshold ?? DEFAULT_PRESENCE_THRESHOLD;
  const at = (index: number): Landmark => toLandmark(landmarks[index], cameraBufferConvention, presenceThreshold);

  // Mirroring swaps which raw index feeds which BodyFrame label when the
  // buffer is RAW (see CameraBufferConvention doc above): MediaPipe's own
  // "left_shoulder" is always the subject's true anatomical left, so under
  // a raw (unmirrored) buffer, BodyFrame's leftShoulder must still read
  // from MediaPipe's leftShoulder index -- only the U COORDINATE is
  // flipped (by mirrorU above), never the anatomical label pairing itself.
  const leftShoulder = at(MEDIAPIPE_POSE_LANDMARK_INDEX.leftShoulder);
  const rightShoulder = at(MEDIAPIPE_POSE_LANDMARK_INDEX.rightShoulder);
  const leftHip = at(MEDIAPIPE_POSE_LANDMARK_INDEX.leftHip);
  const rightHip = at(MEDIAPIPE_POSE_LANDMARK_INDEX.rightHip);
  const neckCenter = midpoint(leftShoulder, rightShoulder);
  const chestCenter = neckCenter; // shoulder-midpoint approximation; see header
  const waistCenter = midpoint(leftHip, rightHip);
  const torsoCenter = midpoint(chestCenter, waistCenter);

  const torsoWidth = leftShoulder.present && rightShoulder.present
    ? distance(leftShoulder.point, rightShoulder.point)
    : null;
  const torsoHeight = neckCenter.present && waistCenter.present
    ? distance(neckCenter.point, waistCenter.point)
    : null;
  const torsoRotation = leftShoulder.present && rightShoulder.present
    ? Math.atan2(rightShoulder.point.v - leftShoulder.point.v, rightShoulder.point.u - leftShoulder.point.u)
    : null;

  const allConfidences = [leftShoulder, rightShoulder, leftHip, rightHip]
    .filter((l): l is Extract<Landmark, { present: true }> => l.present)
    .map((l) => l.confidence);
  const trackingConfidence = allConfidences.length > 0
    ? allConfidences.reduce((a, b) => a + b, 0) / allConfidences.length
    : 0;

  return {
    ...emptyBodyFrame(timestamp),
    headCenter: at(MEDIAPIPE_POSE_LANDMARK_INDEX.nose),
    noseOrHeadDirection: at(MEDIAPIPE_POSE_LANDMARK_INDEX.nose),
    neckCenter,
    leftShoulder,
    rightShoulder,
    leftElbow: at(MEDIAPIPE_POSE_LANDMARK_INDEX.leftElbow),
    rightElbow: at(MEDIAPIPE_POSE_LANDMARK_INDEX.rightElbow),
    leftWrist: at(MEDIAPIPE_POSE_LANDMARK_INDEX.leftWrist),
    rightWrist: at(MEDIAPIPE_POSE_LANDMARK_INDEX.rightWrist),
    chestCenter,
    waistCenter,
    leftHip,
    rightHip,
    torsoCenter,
    torsoWidth,
    torsoHeight,
    torsoRotation,
    trackingConfidence,
  };
}
