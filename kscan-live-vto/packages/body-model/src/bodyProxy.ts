/**
 * Ephemeral body proxy — Section P2-B.
 *
 * "Derive normalized visual geometry... Use only for: apparent scale;
 * visual garment placement; deformation; occlusion heuristics. Do not
 * persist. Do not upload. Do not present as measurements."
 *
 * Every value here is monocular-camera-derived, 2D, and relative — there
 * is no depth sensor and no claim of physical units anywhere in this file.
 * `BodyProxy` values only ever mean something *relative to this person, in
 * this frame, at this camera distance* — never compare BodyProxy values
 * across two different people or sessions as if they were measurements,
 * and never write a BodyProxy (or any field of it) to disk, a log, a
 * crash report, or a network call. This module has no I/O of any kind —
 * that is enforced by construction, not just by convention: it imports
 * nothing outside `@kscan-live-vto/contract`.
 */

import { isLandmarkPresent, type BodyFrame, type Landmark, type Point2D } from '@kscan-live-vto/contract';

export interface Vector2D {
  dx: number;
  dy: number;
}

function point(landmark: Landmark): Point2D | null {
  return isLandmarkPresent(landmark) ? landmark.point : null;
}

function distance(a: Point2D, b: Point2D): number {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

function vectorBetween(from: Point2D, to: Point2D): Vector2D {
  return { dx: to.u - from.u, dy: to.v - from.v };
}

function midpoint(a: Point2D, b: Point2D): Point2D {
  return { u: (a.u + b.u) / 2, v: (a.v + b.v) / 2 };
}

export interface BodyProxy {
  timestamp: number;
  /** Normalized image-space distance between shoulder landmarks. This is the proxy's canonical scale reference. */
  shoulderWidth: number;
  torsoHeight: number | null;
  hipWidth: number | null;
  /** Scale reference used to normalize the arm vectors below — currently == shoulderWidth. Kept as a separate field so the normalization basis can change without renaming call sites. */
  torsoScale: number;
  leftUpperArmVector: Vector2D | null;
  rightUpperArmVector: Vector2D | null;
  leftForearmVector: Vector2D | null;
  rightForearmVector: Vector2D | null;
  /** Radians. Positive = right shoulder appears higher than left (person rotated so their left side is toward camera). 0 = shoulder line horizontal. */
  torsoOrientation: number;
  /** current torsoScale / calibration-baseline torsoScale. 1.0 at calibration distance; >1 closer, <1 farther. Only meaningful relative to a BodyProxyCalibrator that produced a baseline — see below. */
  cameraRelativeScale: number | null;
}

/**
 * Section P2-B: "Normalize against a stable calibration state." A
 * calibrator holds exactly one number — a baseline torsoScale captured
 * once tracking is stable — and is deliberately not shared or persisted
 * beyond the current Live session. Recalibrating (e.g. after tracking
 * loss and reacquisition) is a caller decision, not automatic, so a
 * temporary tracking glitch can't silently reset apparent-scale continuity.
 */
export class BodyProxyCalibrator {
  private baselineTorsoScale: number | null = null;

  calibrate(torsoScale: number): void {
    this.baselineTorsoScale = torsoScale;
  }

  get isCalibrated(): boolean {
    return this.baselineTorsoScale !== null;
  }

  relativeScaleFor(torsoScale: number): number | null {
    if (this.baselineTorsoScale === null || this.baselineTorsoScale === 0) return null;
    return torsoScale / this.baselineTorsoScale;
  }

  reset(): void {
    this.baselineTorsoScale = null;
  }
}

/**
 * Returns null when the minimum landmarks for a usable proxy (both
 * shoulders) are absent — Section 16's existing-clothing/occlusion
 * constraint means this will legitimately happen (bulky sleeves, arms
 * fully out of frame, etc.), and callers must be able to represent "no
 * proxy this frame" rather than receiving stale or fabricated geometry.
 */
export function deriveBodyProxy(frame: BodyFrame, calibrator?: BodyProxyCalibrator): BodyProxy | null {
  const leftShoulder = point(frame.leftShoulder);
  const rightShoulder = point(frame.rightShoulder);
  if (!leftShoulder || !rightShoulder) return null;

  const shoulderWidth = distance(leftShoulder, rightShoulder);
  const torsoScale = shoulderWidth;

  const leftHip = point(frame.leftHip);
  const rightHip = point(frame.rightHip);
  const hipWidth = leftHip && rightHip ? distance(leftHip, rightHip) : null;

  let torsoHeight: number | null = null;
  if (leftHip && rightHip) {
    const shoulderMid = midpoint(leftShoulder, rightShoulder);
    const hipMid = midpoint(leftHip, rightHip);
    torsoHeight = distance(shoulderMid, hipMid);
  }

  const leftElbow = point(frame.leftElbow);
  const rightElbow = point(frame.rightElbow);
  const leftWrist = point(frame.leftWrist);
  const rightWrist = point(frame.rightWrist);

  const leftUpperArmVector = leftElbow ? normalizeVec(vectorBetween(leftShoulder, leftElbow), torsoScale) : null;
  const rightUpperArmVector = rightElbow ? normalizeVec(vectorBetween(rightShoulder, rightElbow), torsoScale) : null;
  const leftForearmVector = leftElbow && leftWrist ? normalizeVec(vectorBetween(leftElbow, leftWrist), torsoScale) : null;
  const rightForearmVector = rightElbow && rightWrist ? normalizeVec(vectorBetween(rightElbow, rightWrist), torsoScale) : null;

  // Shoulder line angle vs. horizontal. Image v-axis grows downward, so a
  // right shoulder appearing higher (smaller v) than the left yields a
  // positive angle by this convention (see field doc above).
  const shoulderVector = vectorBetween(leftShoulder, rightShoulder);
  const torsoOrientation = Math.atan2(-shoulderVector.dy, shoulderVector.dx);

  return {
    timestamp: frame.timestamp,
    shoulderWidth,
    torsoHeight,
    hipWidth,
    torsoScale,
    leftUpperArmVector,
    rightUpperArmVector,
    leftForearmVector,
    rightForearmVector,
    torsoOrientation,
    cameraRelativeScale: calibrator ? calibrator.relativeScaleFor(torsoScale) : null,
  };
}

function normalizeVec(v: Vector2D, scale: number): Vector2D | null {
  if (scale === 0) return null;
  return { dx: v.dx / scale, dy: v.dy / scale };
}
