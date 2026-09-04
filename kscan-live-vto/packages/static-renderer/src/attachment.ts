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
import type { GarmentControlPoint, GarmentControlPointId, KsgarmentManifest } from '@kscan-live-vto/garment-contract';
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
export const SHOULDER_SEAM_OUTSET = 0.08;

/**
 * How far ABOVE the shoulder joint the seam sits, as a fraction of shoulder
 * span.
 *
 * Review package #1 failed partly on shoulder-cap undercoverage: the person's
 * own clothing showed through as slivers at both shoulder tops. The cause is
 * anatomical, not a rendering bug — `leftShoulder`/`rightShoulder` are joint
 * centres, which sit *inside* the body, while a real shirt's seam lies on top
 * of the deltoid, above and outboard of that centre. Placing the seam exactly
 * on the joint therefore guarantees the shoulder cap is left bare.
 */
export const SHOULDER_SEAM_RISE = 0.09;

/**
 * Longitudinal position (0 = seam line, 1 = hem) below which the garment
 * keeps its full shoulder width instead of following the body's taper.
 *
 * A tee hangs from the shoulders; it does not shrink-wrap the ribcage. Making
 * width follow the shoulder→hip taper from t=0 compressed chest content
 * horizontally, which is the other half of the logo-aspect defect. Holding
 * full width across the chest band and tapering only below it preserves chest
 * proportions while still letting the hem sit near the body.
 */
export const TORSO_WIDTH_HOLD_T = 0.55;

/**
 * How far the garment's longitudinal scale may diverge from its lateral scale
 * before the hem is allowed to sit away from the body's hem target.
 *
 * A garment is a manufactured object of a fixed size. Forcing its hem onto
 * `hips + hem drop` for every body means a long-torsoed person stretches it
 * vertically without limit — on the narrow fixture that was a 1.50x
 * longitudinal scale against a 1.06x lateral one, i.e. chest content
 * distorted 42%, which is a worse artifact than a hem sitting slightly high.
 *
 * Beyond this bound the garment keeps its own proportions and the hem lands
 * where its size puts it: a little short on a long torso, a little long on a
 * short one. That is what real garments do. Within the bound the garment
 * still adapts to the body, which is what makes it look worn rather than
 * pasted.
 */
export const MAX_LONGITUDINAL_ASPECT_DEVIATION = 0.15;

/**
 * Approximate half-width of the upper arm, as a fraction of shoulder span.
 *
 * The sleeve control point marks the sleeve's OUTER edge, not the arm's
 * centreline, so its target has to sit outboard of the arm axis by roughly
 * the arm's half-width. Without this offset the sleeve target landed inboard
 * of the armpit target while sitting outboard of it in the texture — an
 * inverted ordering, which showed up immediately as negative-determinant
 * (folded) mesh cells.
 *
 * An approximation, and labelled as one: BodyFrame carries no limb width.
 * A real width estimate (from segmentation, once that exists) should replace
 * this constant rather than tuning it further.
 */
export const UPPER_ARM_HALF_WIDTH = 0.11;

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

/**
 * REMOVED in the package-#1 topology repair. The sleeve end used to be placed
 * at a fixed fraction of the way to the elbow, which stretched the sleeve to
 * whatever length the arm happened to be — 1.24x on the neutral fixture — and
 * fed that stretch back into the chest through the warp. The sleeve now keeps
 * its own authored length and only rotates; see computeControlPointTargets.
 */

export type ControlPointTargets = Partial<Record<GarmentControlPointId, Point>>;

/**
 * Semantic target for each control point the manifest declares.
 *
 * ── The defect this replaced (review package #1, FAIL — DEFORMATION) ───────
 *
 * The previous version derived each control point's target from whichever
 * anatomical landmark had a similar-sounding name: `waist` → the body's
 * `waistCenter`, `leftTorso` → the midpoint of shoulder→hip, and so on. That
 * looks reasonable and is wrong, because a garment control point is a point
 * on the GARMENT, identified by where it sits in the garment's own geometry —
 * not a body part.
 *
 * Concretely: the fixture's `waist` control point sits at 76% of the
 * garment's shoulder→hem length, while the body's `waistCenter` landmark sits
 * at 82% of torso height, which is well ABOVE the hem. Pinning one to the
 * other dragged the middle of the garment upward, which (a) compressed
 * everything above it — the measured 0.67–0.78 vertical scale on chest
 * content — and (b) pulled the centre of the hem up between the two corner
 * hem points, producing the notch. One bad target, both symptoms.
 *
 * ── What it does now ───────────────────────────────────────────────────────
 *
 * Build a garment frame in body space and map the garment's own normalized
 * coordinates into it:
 *
 *     origin     shoulder-seam midpoint (raised above the joint line)
 *     down       towards the hem midpoint (hips + hem drop)
 *     right      along the body's shoulder line
 *     t          the control point's own longitudinal fraction, taken from
 *                the manifest: (v - v_shoulder) / (v_hem - v_shoulder)
 *     lateral    the control point's own lateral fraction, in seam-span units
 *
 * So longitudinal spacing is the garment's, distributed across the body's
 * actual shoulder→hem distance, and lateral spacing is the garment's, scaled
 * by the body's width. No control point is pinned to a same-named body part
 * any more, because the garment's shape is the garment's, not the body's.
 *
 * Sleeves are the one deliberate exception — they articulate, see below.
 */
export function computeControlPointTargets(
  manifest: KsgarmentManifest,
  anchors: BodyAnchors,
  textureWidth: number,
  textureHeight: number,
): ControlPointTargets {
  const { leftShoulder, rightShoulder, leftHip, rightHip, shoulderSpanPx, torsoHeightPx } = anchors;

  const cp = (id: GarmentControlPointId) => manifest.controlPoints.find((c) => c.id === id);
  const cpLeftShoulder = cp('leftShoulder');
  const cpRightShoulder = cp('rightShoulder');
  const cpLeftHem = cp('leftHem');
  const cpRightHem = cp('rightHem');
  if (!cpLeftShoulder || !cpRightShoulder || !cpLeftHem || !cpRightHem) return {};

  // Unit vector along the shoulder line (wearer's left → right), so a tilted
  // body carries the garment with it.
  const rightDir = {
    x: (rightShoulder.x - leftShoulder.x) / shoulderSpanPx,
    y: (rightShoulder.y - leftShoulder.y) / shoulderSpanPx,
  };
  const upDir = { x: rightDir.y, y: -rightDir.x };

  // Frame origin: the seam midpoint, above the joint line (see SHOULDER_SEAM_RISE).
  const jointMid = { x: (leftShoulder.x + rightShoulder.x) / 2, y: (leftShoulder.y + rightShoulder.y) / 2 };
  const rise = shoulderSpanPx * SHOULDER_SEAM_RISE;
  const shoulderMid = { x: jointMid.x + upDir.x * rise, y: jointMid.y + upDir.y * rise };

  // Frame end: the hem midpoint, below the hip line.
  const hipMid = { x: (leftHip.x + rightHip.x) / 2, y: (leftHip.y + rightHip.y) / 2 };
  const downFromHip = { x: -upDir.x, y: -upDir.y };
  const hemDrop = torsoHeightPx * HIP_LENGTH_HEM_DROP;
  const hemMid = { x: hipMid.x + downFromHip.x * hemDrop, y: hipMid.y + downFromHip.y * hemDrop };

  const bodyAxisLength = Math.hypot(hemMid.x - shoulderMid.x, hemMid.y - shoulderMid.y);
  if (bodyAxisLength < 1) return {};
  const downDir = { x: (hemMid.x - shoulderMid.x) / bodyAxisLength, y: (hemMid.y - shoulderMid.y) / bodyAxisLength };

  // Garment's own normalized coordinates.
  const vShoulder = (cpLeftShoulder.v + cpRightShoulder.v) / 2;
  const vHem = (cpLeftHem.v + cpRightHem.v) / 2;
  const vSpan = vHem - vShoulder;
  const uSpan = cpRightShoulder.u - cpLeftShoulder.u;
  if (vSpan <= 0 || uSpan <= 0) return {};

  const longitudinalOf = (v: number) => (v - vShoulder) / vSpan;
  const lateralOf = (u: number) => (u - 0.5) / uSpan;

  // Width profile. Full seam width across the chest band, tapering below it
  // so the hem sits near the body — see TORSO_WIDTH_HOLD_T.
  const seamSpanTarget = shoulderSpanPx * (1 + 2 * SHOULDER_SEAM_OUTSET);

  // Longitudinal scale, bounded against the lateral scale so no body can
  // stretch or squash chest content without limit — see
  // MAX_LONGITUDINAL_ASPECT_DEVIATION.
  const textureSeamSpanPx = uSpan * textureWidth;
  const textureLengthPx = vSpan * textureHeight;
  const lateralScaleForLength = seamSpanTarget / textureSeamSpanPx;
  const fittedLongitudinalScale = bodyAxisLength / textureLengthPx;
  const maxRatio = 1 + MAX_LONGITUDINAL_ASPECT_DEVIATION;
  const boundedLongitudinalScale = Math.min(
    lateralScaleForLength * maxRatio,
    Math.max(lateralScaleForLength / maxRatio, fittedLongitudinalScale),
  );
  const axisLength = boundedLongitudinalScale * textureLengthPx;
  const hipHalfWidth = Math.hypot(rightHip.x - leftHip.x, rightHip.y - leftHip.y) / 2;
  const hemHalfWidthIntended = hipHalfWidth + shoulderSpanPx * 0.04;
  const hemLateralUnits = Math.abs(lateralOf(cpLeftHem.u));
  const widthAtHem = hemLateralUnits > 0 ? hemHalfWidthIntended / hemLateralUnits : seamSpanTarget;

  const widthAt = (t: number): number => {
    if (t <= TORSO_WIDTH_HOLD_T) return seamSpanTarget;
    const k = Math.min(1, (t - TORSO_WIDTH_HOLD_T) / (1 - TORSO_WIDTH_HOLD_T));
    return seamSpanTarget + (widthAtHem - seamSpanTarget) * k;
  };

  const place = (u: number, v: number): Point => {
    const t = longitudinalOf(v);
    const lateral = lateralOf(u) * widthAt(t);
    const down = t * axisLength;
    return {
      x: shoulderMid.x + downDir.x * down + rightDir.x * lateral,
      y: shoulderMid.y + downDir.y * down + rightDir.y * lateral,
    };
  };

  const targets: ControlPointTargets = {};
  for (const point of manifest.controlPoints) {
    if (point.id === 'leftSleeve' || point.id === 'rightSleeve') continue;
    targets[point.id] = place(point.u, point.v);
  }

  // ── Sleeves articulate ─────────────────────────────────────────────────────
  //
  // The sleeve is the one place the garment must follow a limb rather than the
  // torso frame, so it is placed along the actual upper-arm direction. It
  // ROTATES but does not STRETCH: the sleeve keeps its own authored length,
  // scaled by the same factor as the rest of the garment. The previous version
  // placed it at a fixed fraction of the way to the elbow, which stretched the
  // sleeve by ~1.24x on the neutral fixture and pushed that stretch back into
  // the chest through the warp.
  const lateralScale = lateralScaleForLength;
  const sleeveTarget = (
    which: 'leftSleeve' | 'rightSleeve',
    seamCp: GarmentControlPoint,
    seamTargetPoint: Point | undefined,
    joint: Point,
    elbow: Point | null,
    outward: number,
  ): Point | undefined => {
    const sleeveCp = cp(which);
    if (!sleeveCp || !seamTargetPoint) return undefined;

    const sleeveLengthTexture = Math.hypot(
      (sleeveCp.u - seamCp.u) * textureWidth,
      (sleeveCp.v - seamCp.v) * textureHeight,
    );
    const reach = sleeveLengthTexture * lateralScale;

    // Direction: down the upper arm when the elbow is tracked. With no elbow,
    // a defined fallback (down and slightly outward) rather than a guess
    // dressed up as tracking.
    let dirX: number;
    let dirY: number;
    if (elbow) {
      const dx = elbow.x - joint.x;
      const dy = elbow.y - joint.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) return undefined;
      dirX = dx / len;
      dirY = dy / len;
    } else {
      const fx = -upDir.x + rightDir.x * outward * 0.35;
      const fy = -upDir.y + rightDir.y * outward * 0.35;
      const len = Math.hypot(fx, fy);
      dirX = fx / len;
      dirY = fy / len;
    }

    // Step outboard by the arm's half-width, so the sleeve's outer edge lands
    // on the arm's outer edge rather than on its axis — see
    // UPPER_ARM_HALF_WIDTH. Of the two perpendiculars, take the one pointing
    // away from the body's midline.
    const candidate = { x: dirY, y: -dirX };
    const awayX = seamTargetPoint.x - shoulderMid.x;
    const awayY = seamTargetPoint.y - shoulderMid.y;
    const sign = candidate.x * awayX + candidate.y * awayY >= 0 ? 1 : -1;
    const normalX = candidate.x * sign;
    const normalY = candidate.y * sign;
    const armOffset = shoulderSpanPx * UPPER_ARM_HALF_WIDTH;

    return {
      x: seamTargetPoint.x + dirX * reach + normalX * armOffset,
      y: seamTargetPoint.y + dirY * reach + normalY * armOffset,
    };
  };

  const leftSleeve = sleeveTarget('leftSleeve', cpLeftShoulder, targets.leftShoulder, leftShoulder, anchors.leftElbow, -1);
  const rightSleeve = sleeveTarget('rightSleeve', cpRightShoulder, targets.rightShoulder, rightShoulder, anchors.rightElbow, 1);
  if (leftSleeve) targets.leftSleeve = leftSleeve;
  if (rightSleeve) targets.rightSleeve = rightSleeve;

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
