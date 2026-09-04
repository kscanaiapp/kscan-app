/**
 * Garment attachment — the semantic anchoring contract (Sections 11-12).
 *
 * This module decides WHERE a garment goes. Nothing downstream can repair a
 * mistake made here: "deformation cannot repair incorrect semantic
 * anchoring", which is why the rigid stop gate below runs before any MLS
 * warp is attempted.
 *
 * Two placements are produced from the same body anchors:
 *
 *   RIGID     A similarity transform (uniform scale + rotation + translation)
 *             fitted from the two shoulder correspondences alone. Deliberately
 *             cannot stretch: if the garment looks wrong under rigid
 *             placement, the anchoring contract is wrong, not the deformation.
 *
 *   TARGETS   A semantic target position per control point, which is what the
 *             affine-MLS warp consumes.
 *
 * Coordinates: BodyFrame landmarks are normalized [0,1] image space; garment
 * control points are normalized [0,1] TEXTURE space. Both are converted to
 * their own pixel spaces here, because a similarity transform between two
 * normalized spaces of different aspect ratios is not a similarity at all —
 * that shortcut is how garments silently acquire a stretch nobody ordered.
 */

import { isLandmarkPresent, type BodyFrame, type Landmark } from '@kscan-live-vto/contract';
import type { GarmentControlPointId, KsgarmentManifest } from '@kscan-live-vto/garment-contract';
import type { Point } from './raster';

export interface BodyAnchors {
  leftShoulder: Point;
  rightShoulder: Point;
  neckBase: Point;
  leftHip: Point;
  rightHip: Point;
  waist: Point;
  leftElbow: Point | null;
  rightElbow: Point | null;
  shoulderSpanPx: number;
  torsoHeightPx: number;
}

function toPixels(landmark: Landmark, width: number, height: number): Point | null {
  if (!isLandmarkPresent(landmark)) return null;
  return { x: landmark.point.u * width, y: landmark.point.v * height };
}

export type AnchorFailure = 'missing_shoulders' | 'missing_hips' | 'degenerate_shoulder_span';

export function extractBodyAnchors(
  frame: BodyFrame,
  width: number,
  height: number,
): { ok: true; anchors: BodyAnchors } | { ok: false; reason: AnchorFailure } {
  const leftShoulder = toPixels(frame.leftShoulder, width, height);
  const rightShoulder = toPixels(frame.rightShoulder, width, height);
  if (!leftShoulder || !rightShoulder) return { ok: false, reason: 'missing_shoulders' };

  const leftHip = toPixels(frame.leftHip, width, height);
  const rightHip = toPixels(frame.rightHip, width, height);
  if (!leftHip || !rightHip) return { ok: false, reason: 'missing_hips' };

  const shoulderSpanPx = Math.hypot(rightShoulder.x - leftShoulder.x, rightShoulder.y - leftShoulder.y);
  if (shoulderSpanPx < 1) return { ok: false, reason: 'degenerate_shoulder_span' };

  const shoulderMid = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
  const hipMid = { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 };

  return {
    ok: true,
    anchors: {
      leftShoulder,
      rightShoulder,
      neckBase: toPixels(frame.neckCenter, width, height) ?? { x: shoulderMid.x, y: shoulderMid.y - shoulderSpanPx * 0.12 },
      leftHip,
      rightHip,
      waist: toPixels(frame.waistCenter, width, height) ?? { x: (shoulderMid.x + hipMid.x) / 2, y: (shoulderMid.y + hipMid.y) / 2 },
      leftElbow: toPixels(frame.leftElbow, width, height),
      rightElbow: toPixels(frame.rightElbow, width, height),
      shoulderSpanPx,
      torsoHeightPx: Math.hypot(hipMid.x - shoulderMid.x, hipMid.y - shoulderMid.y),
    },
  };
}

/**
 * How far past the shoulder joint the garment's shoulder seam sits, as a
 * fraction of shoulder span. A shirt seam is outboard of the joint; mapping
 * seam directly onto joint reads as a size too small.
 */
export const SHOULDER_SEAM_OUTSET = 0.06;

/**
 * Hem drop below the hip landmark for a `hip`-length garment, as a fraction
 * of torso height.
 *
 * Calibrated against the rigid gate's first run, which is the intended way to
 * set it: at 0.12 the shoulder→hem target was only 1.18 shoulder-spans, so a
 * correctly-proportioned tee had to be squashed ~25% vertically to reach it.
 * The hip *landmark* is the joint, and a hip-length tee's hem hangs a further
 * quarter of a torso below it. 0.28 puts the shoulder→hem target at ~1.34
 * shoulder-spans, which is where a real hip-length tee's own geometry sits.
 */
export const HIP_LENGTH_HEM_DROP = 0.28;

/** Sleeve end position along the shoulder→elbow vector for a short sleeve. */
export const SHORT_SLEEVE_FRACTION = 0.62;

export type ControlPointTargets = Partial<Record<GarmentControlPointId, Point>>;

/**
 * Semantic target for each control point the manifest declares.
 *
 * Every target is derived from body landmarks, never from the garment's own
 * geometry — that is what makes the garment follow the body rather than the
 * body appear to follow the garment.
 */
export function computeControlPointTargets(
  manifest: KsgarmentManifest,
  anchors: BodyAnchors,
): ControlPointTargets {
  const { leftShoulder, rightShoulder, leftHip, rightHip, waist, shoulderSpanPx, torsoHeightPx } = anchors;

  // Unit vector along the shoulder line (wearer's left → right) and the
  // body's "down" direction, so a tilted body carries the garment with it.
  const axisX = { x: (rightShoulder.x - leftShoulder.x) / shoulderSpanPx, y: (rightShoulder.y - leftShoulder.y) / shoulderSpanPx };
  const axisY = { x: -axisX.y, y: axisX.x };

  const along = (base: Point, u: number, v: number): Point => ({
    x: base.x + axisX.x * u + axisY.x * v,
    y: base.y + axisX.y * u + axisY.y * v,
  });

  const hemDrop = torsoHeightPx * HIP_LENGTH_HEM_DROP;
  const targets: ControlPointTargets = {
    leftShoulder: along(leftShoulder, -shoulderSpanPx * SHOULDER_SEAM_OUTSET, 0),
    rightShoulder: along(rightShoulder, shoulderSpanPx * SHOULDER_SEAM_OUTSET, 0),
    leftHem: along(leftHip, -shoulderSpanPx * 0.04, hemDrop),
    rightHem: along(rightHip, shoulderSpanPx * 0.04, hemDrop),
    leftTorso: {
      x: leftShoulder.x + (leftHip.x - leftShoulder.x) * 0.5 - axisX.x * shoulderSpanPx * 0.02,
      y: leftShoulder.y + (leftHip.y - leftShoulder.y) * 0.5 - axisX.y * shoulderSpanPx * 0.02,
    },
    rightTorso: {
      x: rightShoulder.x + (rightHip.x - rightShoulder.x) * 0.5 + axisX.x * shoulderSpanPx * 0.02,
      y: rightShoulder.y + (rightHip.y - rightShoulder.y) * 0.5 + axisX.y * shoulderSpanPx * 0.02,
    },
    waist,
  };

  // Sleeves follow the actual upper-arm direction when the elbow is tracked,
  // so "arms away" moves the sleeve instead of tearing it off the shoulder.
  // With no elbow, the sleeve falls straight down from the seam — a defined
  // fallback, not a guess dressed up as tracking.
  const sleeveEnd = (shoulder: Point, elbow: Point | null, outward: number): Point => {
    if (elbow) {
      return {
        x: shoulder.x + (elbow.x - shoulder.x) * SHORT_SLEEVE_FRACTION,
        y: shoulder.y + (elbow.y - shoulder.y) * SHORT_SLEEVE_FRACTION,
      };
    }
    return along(shoulder, outward * shoulderSpanPx * 0.1, shoulderSpanPx * 0.34);
  };
  targets.leftSleeve = sleeveEnd(targets.leftShoulder!, anchors.leftElbow, -1);
  targets.rightSleeve = sleeveEnd(targets.rightShoulder!, anchors.rightElbow, 1);

  const declared = new Set(manifest.controlPoints.map((cp) => cp.id));
  for (const key of Object.keys(targets) as GarmentControlPointId[]) {
    if (!declared.has(key)) delete targets[key];
  }
  return targets;
}

// ─── Rigid placement ──────────────────────────────────────────────────────────

export interface SimilarityTransform {
  scale: number;
  rotationRadians: number;
  translateX: number;
  translateY: number;
}

export function applySimilarity(t: SimilarityTransform, p: Point): Point {
  const cos = Math.cos(t.rotationRadians) * t.scale;
  const sin = Math.sin(t.rotationRadians) * t.scale;
  return {
    x: p.x * cos - p.y * sin + t.translateX,
    y: p.x * sin + p.y * cos + t.translateY,
  };
}

export function invertSimilarity(t: SimilarityTransform): SimilarityTransform {
  const invScale = 1 / t.scale;
  const invRotation = -t.rotationRadians;
  const cos = Math.cos(invRotation) * invScale;
  const sin = Math.sin(invRotation) * invScale;
  return {
    scale: invScale,
    rotationRadians: invRotation,
    translateX: -(t.translateX * cos - t.translateY * sin),
    translateY: -(t.translateX * sin + t.translateY * cos),
  };
}

/**
 * Fits the exact similarity carrying the garment's two shoulder control
 * points (in texture pixel space) onto the body's two shoulder targets.
 * Two correspondences determine a similarity uniquely — no least squares,
 * no ambiguity, and critically no reflection: a similarity fitted this way
 * cannot mirror the garment, which removes an entire class of bug from the
 * rigid stage by construction.
 *
 * A consequence worth knowing when reading the gate below: because the
 * transform is fitted from these two points, mislabeling the GARMENT's own
 * control points produces a 180° rotation (reported as `upside_down`), not a
 * mirror. The `left_right_inversion` finding therefore catches the inversion
 * that can really happen — a swapped TARGET assignment, i.e. the garment's
 * left shoulder aimed at the body's right one.
 */
export function fitRigidPlacement(
  manifest: KsgarmentManifest,
  textureWidth: number,
  textureHeight: number,
  targets: ControlPointTargets,
): { ok: true; transform: SimilarityTransform } | { ok: false; reason: 'missing_shoulder_control_points' } {
  const cpLeft = manifest.controlPoints.find((cp) => cp.id === 'leftShoulder');
  const cpRight = manifest.controlPoints.find((cp) => cp.id === 'rightShoulder');
  const tLeft = targets.leftShoulder;
  const tRight = targets.rightShoulder;
  if (!cpLeft || !cpRight || !tLeft || !tRight) return { ok: false, reason: 'missing_shoulder_control_points' };

  const src = {
    left: { x: cpLeft.u * textureWidth, y: cpLeft.v * textureHeight },
    right: { x: cpRight.u * textureWidth, y: cpRight.v * textureHeight },
  };

  const srcDx = src.right.x - src.left.x;
  const srcDy = src.right.y - src.left.y;
  const dstDx = tRight.x - tLeft.x;
  const dstDy = tRight.y - tLeft.y;

  const srcLen = Math.hypot(srcDx, srcDy);
  const dstLen = Math.hypot(dstDx, dstDy);
  const scale = dstLen / srcLen;
  const rotationRadians = Math.atan2(dstDy, dstDx) - Math.atan2(srcDy, srcDx);

  const cos = Math.cos(rotationRadians) * scale;
  const sin = Math.sin(rotationRadians) * scale;
  return {
    ok: true,
    transform: {
      scale,
      rotationRadians,
      translateX: tLeft.x - (src.left.x * cos - src.left.y * sin),
      translateY: tLeft.y - (src.left.x * sin + src.left.y * cos),
    },
  };
}

// ─── Rigid attachment stop gate (Section 12) ─────────────────────────────────

export type RigidGateFinding =
  | 'left_right_inversion'
  | 'upside_down'
  | 'gross_scale_error'
  | 'neckline_outside_upper_torso'
  | 'garment_largely_outside_torso';

export interface RigidGateResult {
  passed: boolean;
  findings: RigidGateFinding[];
  measurements: {
    garmentShoulderSpanPx: number;
    bodyShoulderSpanPx: number;
    scaleRatio: number;
    hemBelowShoulderPx: number;
    necklineToNeckBasePx: number;
    necklineToleranceP: number;
    garmentCentroidToTorsoCentroidPx: number;
    torsoDiagonalPx: number;
  };
}

/**
 * Gross-error detector, not a quality judgement. It answers one question:
 * is the garment semantically attached to this body at all? Everything it
 * flags is the kind of defect that no amount of deformation, compositing or
 * lighting could fix.
 */
export function evaluateRigidGate(
  manifest: KsgarmentManifest,
  transform: SimilarityTransform,
  textureWidth: number,
  textureHeight: number,
  anchors: BodyAnchors,
): RigidGateResult {
  const findings: RigidGateFinding[] = [];
  const place = (id: GarmentControlPointId): Point | null => {
    const cp = manifest.controlPoints.find((c) => c.id === id);
    if (!cp) return null;
    return applySimilarity(transform, { x: cp.u * textureWidth, y: cp.v * textureHeight });
  };

  const gLeftShoulder = place('leftShoulder')!;
  const gRightShoulder = place('rightShoulder')!;
  const gLeftHem = place('leftHem');
  const gRightHem = place('rightHem');

  // 1. Left/right inversion — compare the sign of the garment's shoulder
  //    axis against the body's along the body's own left→right direction.
  const bodyAxisX = anchors.rightShoulder.x - anchors.leftShoulder.x;
  const bodyAxisY = anchors.rightShoulder.y - anchors.leftShoulder.y;
  const garmentAxisX = gRightShoulder.x - gLeftShoulder.x;
  const garmentAxisY = gRightShoulder.y - gLeftShoulder.y;
  if (bodyAxisX * garmentAxisX + bodyAxisY * garmentAxisY <= 0) findings.push('left_right_inversion');

  const garmentShoulderSpanPx = Math.hypot(garmentAxisX, garmentAxisY);
  const scaleRatio = garmentShoulderSpanPx / anchors.shoulderSpanPx;

  // 2. Upside down — the hem must sit below the shoulders along the body's
  //    down axis, not merely lower in raw image y (a leaning body rotates it).
  const downX = -bodyAxisY / anchors.shoulderSpanPx;
  const downY = bodyAxisX / anchors.shoulderSpanPx;
  const shoulderMid = { x: (gLeftShoulder.x + gRightShoulder.x) / 2, y: (gLeftShoulder.y + gRightShoulder.y) / 2 };
  let hemBelowShoulderPx = 0;
  if (gLeftHem && gRightHem) {
    const hemMid = { x: (gLeftHem.x + gRightHem.x) / 2, y: (gLeftHem.y + gRightHem.y) / 2 };
    hemBelowShoulderPx = (hemMid.x - shoulderMid.x) * downX + (hemMid.y - shoulderMid.y) * downY;
    if (hemBelowShoulderPx <= 0) findings.push('upside_down');
  }

  // 3. Gross scale error — roughly half or double is the threshold the brief
  //    names. Anything inside that band is deformation's problem, not the gate's.
  if (scaleRatio < 0.55 || scaleRatio > 1.8) findings.push('gross_scale_error');

  // 4. Neckline placement — the garment neckline must land in the upper-torso
  //    region near the neck base, tolerance scaled to the body, not the canvas.
  const necklineToleranceP = anchors.shoulderSpanPx * 0.55;
  const necklineToNeckBasePx = Math.hypot(shoulderMid.x - anchors.neckBase.x, shoulderMid.y - anchors.neckBase.y);
  if (necklineToNeckBasePx > necklineToleranceP) findings.push('neckline_outside_upper_torso');

  // 5. Garment largely outside the torso — compare centroids against the
  //    torso's own diagonal.
  const torsoCentroid = {
    x: (anchors.leftShoulder.x + anchors.rightShoulder.x + anchors.leftHip.x + anchors.rightHip.x) / 4,
    y: (anchors.leftShoulder.y + anchors.rightShoulder.y + anchors.leftHip.y + anchors.rightHip.y) / 4,
  };
  const garmentPoints = [gLeftShoulder, gRightShoulder, gLeftHem, gRightHem].filter((p): p is Point => p !== null);
  const garmentCentroid = {
    x: garmentPoints.reduce((s, p) => s + p.x, 0) / garmentPoints.length,
    y: garmentPoints.reduce((s, p) => s + p.y, 0) / garmentPoints.length,
  };
  const torsoDiagonalPx = Math.hypot(anchors.shoulderSpanPx, anchors.torsoHeightPx);
  const garmentCentroidToTorsoCentroidPx = Math.hypot(
    garmentCentroid.x - torsoCentroid.x,
    garmentCentroid.y - torsoCentroid.y,
  );
  if (garmentCentroidToTorsoCentroidPx > torsoDiagonalPx * 0.5) findings.push('garment_largely_outside_torso');

  return {
    passed: findings.length === 0,
    findings,
    measurements: {
      garmentShoulderSpanPx,
      bodyShoulderSpanPx: anchors.shoulderSpanPx,
      scaleRatio,
      hemBelowShoulderPx,
      necklineToNeckBasePx,
      necklineToleranceP,
      garmentCentroidToTorsoCentroidPx,
      torsoDiagonalPx,
    },
  };
}
