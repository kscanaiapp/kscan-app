/**
 * SYNTHETIC — NOT HUMAN.
 *
 * Procedural person fixtures with exactly-known BodyFrames, for validating
 * *rendering mechanics*. Section 9 of the pass brief: these must approximate
 * real human torso geometry well enough to stress attachment logic — pure
 * rectangles or triangles are not viability evidence — and every report using
 * them must say:
 *
 *   "This validates rendering mechanics given known BodyFrames. It does not
 *    validate human pose perception, body diversity, or production
 *    segmentation quality."
 *
 * No pose model runs here. The BodyFrame is an INPUT that this generator
 * emits alongside the image, because it drew the body and therefore knows
 * where every landmark is. That is precisely what makes these fixtures useful
 * for isolating renderer defects from perception defects — and precisely why
 * they say nothing about perception.
 *
 * MIRRORING CONVENTION (the single most important semantic here). Landmark
 * names are the WEARER'S anatomical side. Images are in the front-camera /
 * selfie orientation the user sees, so the wearer's left appears on the LEFT
 * of the image: `leftShoulder.u < rightShoulder.u`. The same convention binds
 * garment control points, so `leftShoulder` on a garment lands on
 * `leftShoulder` on a body with no flip anywhere in the pipeline. Every
 * mirroring bug this pipeline can have is a violation of that one sentence.
 */

import type { BodyFrame, Landmark, Point2D } from '@kscan-live-vto/contract';
import { emptyBodyFrame } from '@kscan-live-vto/contract';
import {
  createImage,
  drawLine,
  fillDisc,
  fillPolygon,
  rgba,
  setPixel,
  type Point,
  type Rgba,
  type RgbaImage,
} from '../raster';

export type ArmPose = 'beside' | 'away' | 'crossed';

export interface SyntheticPersonSpec {
  fixtureId: string;
  width: number;
  height: number;
  /** Shoulder span as a fraction of image width. */
  shoulderWidthNorm: number;
  /** Shoulder-line to hip-line distance as a fraction of image height. */
  torsoHeightNorm: number;
  /** Torso centre as a fraction of image width; 0.5 is centred. */
  centerXNorm: number;
  /** Vertical position of the shoulder line as a fraction of image height. */
  shoulderYNorm: number;
  /** Whole-body lean, radians. Positive tilts the top of the body toward +u. */
  tiltRadians: number;
  /** Extra downward offset applied to the RIGHT shoulder only, in normalized height. Real shoulders are not level. */
  shoulderAsymmetryNorm: number;
  armPose: ArmPose;
  /** Background grey level 0-255. Varying this exercises the lighting estimator. */
  backgroundLevel: number;
  skinTone: Rgba;
  /** The clothing the person is ALREADY wearing (Section 16's constraint made visible). */
  currentGarmentTone: Rgba;
  /** Pixels of ragged edge to add to the foreground mask. Real masks are not clean. */
  maskEdgeNoise: number;
  seed: number;
}

export interface SyntheticPersonFixture {
  spec: SyntheticPersonSpec;
  image: RgbaImage;
  bodyFrame: BodyFrame;
  /**
   * Foreground regions that must composite IN FRONT of a virtual garment
   * (Section 17). Alpha channel only is meaningful: 255 = foreground.
   *
   * PRECOMPUTED, NOT GENERATED. No segmentation model produced this — the
   * generator knows which pixels are arm because it drew them. Every manifest
   * built from this fixture reports maskProvenance 'precomputed'.
   */
  foregroundMask: RgbaImage;
  /** True when the pose puts a forearm across the torso, i.e. occlusion matters. */
  hasForegroundOverTorso: boolean;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function present(p: Point2D, confidence = 0.97): Landmark {
  return { present: true, point: p, confidence };
}

function shade(color: Rgba, factor: number): Rgba {
  return rgba(color.r * factor, color.g * factor, color.b * factor, color.a);
}

export const NEUTRAL_PERSON: SyntheticPersonSpec = {
  fixtureId: 'synthetic-person-neutral',
  width: 720,
  height: 960,
  shoulderWidthNorm: 0.34,
  torsoHeightNorm: 0.3,
  centerXNorm: 0.5,
  shoulderYNorm: 0.3,
  tiltRadians: 0.0,
  shoulderAsymmetryNorm: 0.008,
  armPose: 'beside',
  backgroundLevel: 176,
  skinTone: rgba(198, 156, 124, 255),
  currentGarmentTone: rgba(84, 92, 104, 255),
  maskEdgeNoise: 1.5,
  seed: 11,
};

/** Anatomy the generator computes once and then both draws and reports. */
interface Anatomy {
  leftShoulder: Point;
  rightShoulder: Point;
  neckBase: Point;
  headCenter: Point;
  chestCenter: Point;
  waistCenter: Point;
  leftHip: Point;
  rightHip: Point;
  leftElbow: Point;
  rightElbow: Point;
  leftWrist: Point;
  rightWrist: Point;
  torsoCenter: Point;
  limbThickness: number;
}

function buildAnatomy(spec: SyntheticPersonSpec): Anatomy {
  const { width: W, height: H } = spec;
  const cx = spec.centerXNorm * W;
  const shoulderY = spec.shoulderYNorm * H;
  const halfSpan = (spec.shoulderWidthNorm * W) / 2;
  const torsoH = spec.torsoHeightNorm * H;
  const cos = Math.cos(spec.tiltRadians);
  const sin = Math.sin(spec.tiltRadians);

  // Rotate about the mid-hip so a lean pivots at the waist, as a body does.
  const pivot: Point = { x: cx, y: shoulderY + torsoH };
  const rot = (p: Point): Point => ({
    x: pivot.x + (p.x - pivot.x) * cos - (p.y - pivot.y) * sin,
    y: pivot.y + (p.x - pivot.x) * sin + (p.y - pivot.y) * cos,
  });

  // Wearer's LEFT is image-left (lower x) — see the mirroring note in the
  // module header. The asymmetry is applied to the right shoulder only.
  const leftShoulder = rot({ x: cx - halfSpan, y: shoulderY });
  const rightShoulder = rot({ x: cx + halfSpan, y: shoulderY + spec.shoulderAsymmetryNorm * H });
  const neckBase = rot({ x: cx, y: shoulderY - 0.012 * H });
  const headCenter = rot({ x: cx, y: shoulderY - 0.13 * H });

  const hipHalfSpan = halfSpan * 0.78;
  const leftHip = rot({ x: cx - hipHalfSpan, y: shoulderY + torsoH });
  const rightHip = rot({ x: cx + hipHalfSpan, y: shoulderY + torsoH });
  const chestCenter = rot({ x: cx, y: shoulderY + torsoH * 0.34 });
  const waistCenter = rot({ x: cx, y: shoulderY + torsoH * 0.82 });
  const torsoCenter = rot({ x: cx, y: shoulderY + torsoH * 0.5 });

  const upperArm = torsoH * 0.55;
  const foreArm = torsoH * 0.5;
  let leftElbow: Point;
  let rightElbow: Point;
  let leftWrist: Point;
  let rightWrist: Point;

  if (spec.armPose === 'beside') {
    leftElbow = rot({ x: cx - halfSpan - upperArm * 0.16, y: shoulderY + upperArm });
    rightElbow = rot({ x: cx + halfSpan + upperArm * 0.16, y: shoulderY + upperArm });
    leftWrist = rot({ x: cx - halfSpan - upperArm * 0.22, y: shoulderY + upperArm + foreArm });
    rightWrist = rot({ x: cx + halfSpan + upperArm * 0.22, y: shoulderY + upperArm + foreArm });
  } else if (spec.armPose === 'away') {
    leftElbow = rot({ x: cx - halfSpan - upperArm * 0.72, y: shoulderY + upperArm * 0.72 });
    rightElbow = rot({ x: cx + halfSpan + upperArm * 0.72, y: shoulderY + upperArm * 0.72 });
    leftWrist = rot({ x: cx - halfSpan - upperArm * 0.72 - foreArm * 0.66, y: shoulderY + upperArm * 0.4 });
    rightWrist = rot({ x: cx + halfSpan + upperArm * 0.72 + foreArm * 0.66, y: shoulderY + upperArm * 0.4 });
  } else {
    // Crossed: both forearms travel ACROSS the torso, which is the case
    // Section 17 cares about — the arm must end up in front of the garment.
    leftElbow = rot({ x: cx - halfSpan - upperArm * 0.1, y: shoulderY + upperArm });
    rightElbow = rot({ x: cx + halfSpan + upperArm * 0.1, y: shoulderY + upperArm });
    leftWrist = rot({ x: cx + halfSpan * 0.52, y: shoulderY + torsoH * 0.62 });
    rightWrist = rot({ x: cx - halfSpan * 0.52, y: shoulderY + torsoH * 0.74 });
  }

  return {
    leftShoulder,
    rightShoulder,
    neckBase,
    headCenter,
    chestCenter,
    waistCenter,
    leftHip,
    rightHip,
    leftElbow,
    rightElbow,
    leftWrist,
    rightWrist,
    torsoCenter,
    limbThickness: halfSpan * 0.42,
  };
}

function torsoPolygon(a: Anatomy): Point[] {
  // Slight outward bow at the chest and inward pinch at the waist: a straight
  // shoulder-to-hip trapezoid reads as furniture, not a body, and would not
  // stress the garment's side control points.
  const mid = (p: Point, q: Point, t: number): Point => ({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
  const leftChest = mid(a.leftShoulder, a.leftHip, 0.3);
  const rightChest = mid(a.rightShoulder, a.rightHip, 0.3);
  const leftWaist = mid(a.leftShoulder, a.leftHip, 0.72);
  const rightWaist = mid(a.rightShoulder, a.rightHip, 0.72);
  const bow = (p: Point, dir: number, amount: number): Point => ({ x: p.x + dir * amount, y: p.y });
  const span = Math.hypot(a.rightShoulder.x - a.leftShoulder.x, a.rightShoulder.y - a.leftShoulder.y);

  return [
    a.leftShoulder,
    bow(leftChest, -1, span * 0.03),
    bow(leftWaist, 1, span * 0.035),
    a.leftHip,
    a.rightHip,
    bow(rightWaist, -1, span * 0.035),
    bow(rightChest, 1, span * 0.03),
    a.rightShoulder,
    a.neckBase,
  ];
}

export function generateSyntheticPerson(spec: SyntheticPersonSpec): SyntheticPersonFixture {
  const a = buildAnatomy(spec);
  const rand = mulberry32(spec.seed);
  const bg = rgba(spec.backgroundLevel, spec.backgroundLevel, spec.backgroundLevel + 6, 255);
  const image = createImage(spec.width, spec.height, bg);

  // A soft vertical gradient so the lighting estimator has something real to
  // measure rather than one flat value.
  for (let y = 0; y < spec.height; y++) {
    const t = y / spec.height;
    const level = spec.backgroundLevel * (1 - 0.18 * t);
    for (let x = 0; x < spec.width; x++) {
      setPixel(image, x, y, rgba(level, level, level + 6, 255));
    }
  }

  // Head and neck.
  const headRadius = spec.shoulderWidthNorm * spec.width * 0.29;
  fillDisc(image, a.headCenter.x, a.headCenter.y, headRadius, spec.skinTone);
  drawLine(image, a.headCenter, a.neckBase, headRadius * 0.62, shade(spec.skinTone, 0.94));

  // Torso, wearing its own garment (Section 16: the camera sees existing clothing).
  fillPolygon(image, torsoPolygon(a), spec.currentGarmentTone);

  // Arms. Drawn in the same tone as the current garment down to the elbow
  // (sleeve) and skin below it, so a forearm crossing the torso is visually
  // distinct from the shirt it crosses.
  const drawArm = (shoulder: Point, elbow: Point, wrist: Point) => {
    drawLine(image, shoulder, elbow, a.limbThickness, shade(spec.currentGarmentTone, 0.92));
    drawLine(image, elbow, wrist, a.limbThickness * 0.86, shade(spec.skinTone, 0.97));
    fillDisc(image, wrist.x, wrist.y, a.limbThickness * 0.44, shade(spec.skinTone, 0.93));
  };
  drawArm(a.leftShoulder, a.leftElbow, a.leftWrist);
  drawArm(a.rightShoulder, a.rightElbow, a.rightWrist);

  // ── Foreground mask ───────────────────────────────────────────────────────
  // Only the forearms (and hands) are foreground: they are the parts that can
  // cross in front of a garment. Upper arms/shoulders are not, because a
  // real shirt covers them.
  const foregroundMask = createImage(spec.width, spec.height, rgba(0, 0, 0, 0));
  const maskInk = rgba(255, 255, 255, 255);
  drawLine(foregroundMask, a.leftElbow, a.leftWrist, a.limbThickness * 0.86, maskInk);
  drawLine(foregroundMask, a.rightElbow, a.rightWrist, a.limbThickness * 0.86, maskInk);
  fillDisc(foregroundMask, a.leftWrist.x, a.leftWrist.y, a.limbThickness * 0.44, maskInk);
  fillDisc(foregroundMask, a.rightWrist.x, a.rightWrist.y, a.limbThickness * 0.44, maskInk);

  // Ragged edges. A production mask is never clean, and a compositor that
  // only ever meets perfect masks hides its own edge handling.
  if (spec.maskEdgeNoise > 0) {
    const noise = Math.round(spec.maskEdgeNoise);
    for (let y = 1; y < spec.height - 1; y++) {
      for (let x = 1; x < spec.width - 1; x++) {
        const here = foregroundMask.data[(y * spec.width + x) * 4 + 3]!;
        const right = foregroundMask.data[(y * spec.width + x + 1) * 4 + 3]!;
        const below = foregroundMask.data[((y + 1) * spec.width + x) * 4 + 3]!;
        const isEdge = here !== right || here !== below;
        if (isEdge && rand() < 0.45) {
          const dx = Math.round((rand() - 0.5) * 2 * noise);
          const dy = Math.round((rand() - 0.5) * 2 * noise);
          const tx = x + dx;
          const ty = y + dy;
          if (tx > 0 && ty > 0 && tx < spec.width && ty < spec.height) {
            const idx = (ty * spec.width + tx) * 4 + 3;
            foregroundMask.data[idx] = here > 127 ? 255 : 0;
          }
        }
      }
    }
  }

  const toNorm = (p: Point): Point2D => ({ u: p.x / spec.width, v: p.y / spec.height });
  const shoulderSpan = Math.hypot(a.rightShoulder.x - a.leftShoulder.x, a.rightShoulder.y - a.leftShoulder.y);
  const torsoSpan = Math.hypot(
    (a.leftHip.x + a.rightHip.x) / 2 - (a.leftShoulder.x + a.rightShoulder.x) / 2,
    (a.leftHip.y + a.rightHip.y) / 2 - (a.leftShoulder.y + a.rightShoulder.y) / 2,
  );

  const bodyFrame: BodyFrame = {
    ...emptyBodyFrame(0),
    headCenter: present(toNorm(a.headCenter)),
    noseOrHeadDirection: present(toNorm({ x: a.headCenter.x, y: a.headCenter.y + headRadius * 0.2 })),
    neckCenter: present(toNorm(a.neckBase)),
    leftShoulder: present(toNorm(a.leftShoulder)),
    rightShoulder: present(toNorm(a.rightShoulder)),
    leftElbow: present(toNorm(a.leftElbow), 0.93),
    rightElbow: present(toNorm(a.rightElbow), 0.93),
    leftWrist: present(toNorm(a.leftWrist), 0.9),
    rightWrist: present(toNorm(a.rightWrist), 0.9),
    chestCenter: present(toNorm(a.chestCenter), 0.9),
    waistCenter: present(toNorm(a.waistCenter), 0.88),
    leftHip: present(toNorm(a.leftHip), 0.9),
    rightHip: present(toNorm(a.rightHip), 0.9),
    torsoCenter: present(toNorm(a.torsoCenter), 0.94),
    torsoWidth: shoulderSpan / spec.width,
    torsoHeight: torsoSpan / spec.height,
    torsoRotation: spec.tiltRadians,
    trackingConfidence: 0.95,
  };

  return {
    spec,
    image,
    bodyFrame,
    foregroundMask,
    hasForegroundOverTorso: spec.armPose === 'crossed',
  };
}
