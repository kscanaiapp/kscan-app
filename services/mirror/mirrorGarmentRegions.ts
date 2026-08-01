// Geometric garment-region derivation (Build 2.5 Step 3).
//
// ── WHAT THIS IS, STATED PLAINLY ────────────────────────────────────────────
//
// This is NOT fashion segmentation. It does not know what a jacket is. It takes
// a person's bounding box, their body landmarks and — where the platform
// supplies one — a person mask, and cuts the figure into anatomical bands.
//
// It CAN produce: shoulders-to-hip, hip-to-ankle, the whole figure, each foot.
// It CANNOT produce: a jacket separated from the shirt under it, a coat from a
// sweater, a scarf, a bag, or any true garment contour.
//
// Every region is therefore named for the BODY, never for a garment, and every
// region that plausibly spans more than one garment is marked `review` so the
// user sees it before it goes anywhere. `full_length` is marked `review`
// unconditionally, because a whole-figure crop always contains several
// garments unless the subject is wearing a single dress — and geometry cannot
// tell those two cases apart.
//
// ── PLATFORM PARITY ─────────────────────────────────────────────────────────
//
// ML Kit pose detection does not produce a segmentation mask; Apple Vision
// does. That asymmetry is contained deliberately: `maskCoverage` may only
// DEMOTE a region's confidence bucket, never promote one, and its ABSENCE
// never demotes. So the two platforms emit the SAME regions, in the SAME order,
// with the SAME crop geometry; iOS may additionally flag a region for review
// that Android leaves alone. The difference is one-directional and always
// toward asking the user. This is asserted by test, not assumed.

import {
  MIRROR_ALWAYS_REVIEW_REGION_CLASSES,
  MIRROR_LANDMARK_CONFIDENCE_THRESHOLD,
  MIRROR_MIN_REGION_AREA_RATIO,
  MIRROR_REGION_IOU_THRESHOLD,
  MIRROR_REGION_PADDING_RATIO,
  MIRROR_REGION_CLASS_ORDER,
} from '../../types/mirrorExtraction';
import type {
  MirrorRegionClass,
  MirrorRegionConfidenceBucket,
  NormalizedBounds,
} from '../../types/mirrorExtraction';
import type { MirrorDetectedPerson, MirrorLandmark, MirrorLandmarkType } from './mirrorExtractionAdapter';

/**
 * Above this a landmark is trusted to place a region edge on its own. Between
 * this and MIRROR_LANDMARK_CONFIDENCE_THRESHOLD the edge is still used — the
 * alternative is discarding a usable crop — but the region is flagged.
 */
export const MIRROR_LANDMARK_HIGH_CONFIDENCE = 0.7;

/**
 * Below this fraction of the person box filled by the mask, the box is mostly
 * background: a person at a sharp angle, or a loose detection. iOS-only signal;
 * see the parity note above.
 */
export const MIRROR_MIN_MASK_COVERAGE = 0.35;

export type DerivedMirrorRegion = {
  regionClass: MirrorRegionClass;
  bounds: NormalizedBounds;
  confidenceBucket: MirrorRegionConfidenceBucket;
};

type LandmarkMap = Partial<Record<MirrorLandmarkType, MirrorLandmark>>;

function toMap(landmarks: MirrorLandmark[]): LandmarkMap {
  const map: LandmarkMap = {};
  for (const landmark of landmarks ?? []) {
    if (!map[landmark.type]) map[landmark.type] = landmark;
  }
  return map;
}

/** A landmark is usable only above the floor. Below it, the edge is guesswork. */
function usable(landmark: MirrorLandmark | undefined): boolean {
  return Boolean(landmark) && landmark.confidence >= MIRROR_LANDMARK_CONFIDENCE_THRESHOLD;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function rect(x0: number, y0: number, x1: number, y1: number): NormalizedBounds | null {
  const left = clamp01(Math.min(x0, x1));
  const right = clamp01(Math.max(x0, x1));
  const top = clamp01(Math.min(y0, y1));
  const bottom = clamp01(Math.max(y0, y1));
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: left, y: top, width, height };
}

/** Grow a rect by a fraction of its longer edge, clamped to the frame. */
export function padRegion(bounds: NormalizedBounds, ratio: number): NormalizedBounds | null {
  const pad = Math.max(bounds.width, bounds.height) * ratio;
  return rect(bounds.x - pad, bounds.y - pad, bounds.x + bounds.width + pad, bounds.y + bounds.height + pad);
}

export function intersectionOverUnion(a: NormalizedBounds, b: NormalizedBounds): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function bucketFor(
  regionClass: MirrorRegionClass,
  definingLandmarks: Array<MirrorLandmark | undefined>,
  maskCoverage: number | null,
): MirrorRegionConfidenceBucket {
  if (MIRROR_ALWAYS_REVIEW_REGION_CLASSES.includes(regionClass)) return 'review';

  const present = definingLandmarks.filter(Boolean) as MirrorLandmark[];
  if (present.length === 0) return 'low';
  if (present.some((l) => l.confidence < MIRROR_LANDMARK_CONFIDENCE_THRESHOLD)) return 'low';

  // Mask coverage may only make things MORE cautious. Its absence is neutral.
  if (typeof maskCoverage === 'number' && maskCoverage < MIRROR_MIN_MASK_COVERAGE) {
    return 'review';
  }
  if (present.some((l) => l.confidence < MIRROR_LANDMARK_HIGH_CONFIDENCE)) return 'review';
  return 'high';
}

/**
 * Horizontal extent for a band.
 *
 * Landmarks sit on the SKELETON, not on the silhouette — a shoulder joint is
 * well inside the sleeve. The span between the two shoulder joints is therefore
 * widened by a fraction of itself so the crop contains the garment rather than
 * a strip down the middle of it. The person's own bounding box is the ceiling:
 * the detector already knows where the body stops.
 */
function bandX(
  points: MirrorLandmark[],
  personBounds: NormalizedBounds,
  widenRatio: number,
): { left: number; right: number } {
  if (points.length === 0) {
    return { left: personBounds.x, right: personBounds.x + personBounds.width };
  }
  const xs = points.map((p) => p.x);
  const min = Math.min(...xs);
  const max = Math.max(...xs);
  const widen = Math.max((max - min) * widenRatio, personBounds.width * 0.05);
  return {
    left: Math.max(personBounds.x, min - widen),
    right: Math.min(personBounds.x + personBounds.width, max + widen),
  };
}

/**
 * Derive every region this person's geometry supports.
 *
 * Returns them in canonical order: region class first (per
 * MIRROR_REGION_CLASS_ORDER), then descending area, then x, then y. That order
 * is what makes crop keys and crop files reproducible for the same image.
 */
export function deriveGarmentRegions(person: MirrorDetectedPerson): DerivedMirrorRegion[] {
  if (!person?.bounds) return [];
  const bounds = person.bounds;
  const marks = toMap(person.landmarks ?? []);
  const coverage = person.maskCoverage;

  const leftShoulder = usable(marks.left_shoulder) ? marks.left_shoulder : undefined;
  const rightShoulder = usable(marks.right_shoulder) ? marks.right_shoulder : undefined;
  const leftHip = usable(marks.left_hip) ? marks.left_hip : undefined;
  const rightHip = usable(marks.right_hip) ? marks.right_hip : undefined;
  const leftKnee = usable(marks.left_knee) ? marks.left_knee : undefined;
  const rightKnee = usable(marks.right_knee) ? marks.right_knee : undefined;
  const leftAnkle = usable(marks.left_ankle) ? marks.left_ankle : undefined;
  const rightAnkle = usable(marks.right_ankle) ? marks.right_ankle : undefined;

  const shoulders = [leftShoulder, rightShoulder].filter(Boolean) as MirrorLandmark[];
  const hips = [leftHip, rightHip].filter(Boolean) as MirrorLandmark[];
  const knees = [leftKnee, rightKnee].filter(Boolean) as MirrorLandmark[];
  const ankles = [leftAnkle, rightAnkle].filter(Boolean) as MirrorLandmark[];

  const hasShoulders = shoulders.length > 0;
  const hasHips = hips.length > 0;
  const shoulderY = hasShoulders ? mean(shoulders.map((l) => l.y)) : null;
  const hipY = hasHips ? mean(hips.map((l) => l.y)) : null;
  const kneeY = knees.length > 0 ? mean(knees.map((l) => l.y)) : null;
  const ankleY = ankles.length > 0 ? mean(ankles.map((l) => l.y)) : null;

  const out: DerivedMirrorRegion[] = [];
  const push = (
    regionClass: MirrorRegionClass,
    raw: NormalizedBounds | null,
    defining: Array<MirrorLandmark | undefined>,
  ) => {
    if (!raw) return;
    const padded = padRegion(raw, MIRROR_REGION_PADDING_RATIO);
    if (!padded) return;
    if (padded.width * padded.height < MIRROR_MIN_REGION_AREA_RATIO) return;
    out.push({
      regionClass,
      bounds: padded,
      confidenceBucket: bucketFor(regionClass, defining, coverage),
    });
  };

  const torso = hasShoulders && hasHips ? Math.max(1e-6, hipY - shoulderY) : null;

  // ── upper body: shoulders (plus collar headroom) down past the waistband ──
  if (torso !== null) {
    const span = bandX([...shoulders, ...hips], bounds, 0.35);
    push(
      'upper_body',
      rect(span.left, shoulderY - torso * 0.18, span.right, hipY + torso * 0.1),
      [leftShoulder, rightShoulder, leftHip, rightHip],
    );
  }

  // ── lower body: waistband down to the ankle ──────────────────────────────
  if (hasHips && (ankleY !== null || kneeY !== null)) {
    // With no ankle, the shin is extrapolated from the thigh: hip→knee and
    // knee→ankle are close enough in length that this lands near the shoe.
    const bottom = ankleY !== null ? ankleY : kneeY + (kneeY - hipY) * 0.95;
    const span = bandX([...hips, ...knees, ...ankles], bounds, 0.4);
    push(
      'lower_body',
      rect(span.left, hipY - (torso ?? bounds.height * 0.1) * 0.06, span.right, bottom),
      [leftHip, rightHip, ...(ankles.length > 0 ? ankles : knees)],
    );
  }

  // ── full length: emitted ONLY when the figure cannot be split ────────────
  //
  // When both bands exist, a whole-figure crop is a duplicate of their union
  // and adds nothing but an ambiguous third option. When the split fails —
  // no hips, or nothing below the hip — the whole figure is the only useful
  // thing left to offer, and it is always flagged for review.
  const splitSucceeded = out.some((r) => r.regionClass === 'upper_body')
    && out.some((r) => r.regionClass === 'lower_body');
  if (!splitSucceeded) {
    const top = shoulderY !== null ? shoulderY - (torso ?? bounds.height * 0.2) * 0.2 : bounds.y;
    const bottom = ankleY !== null ? ankleY : bounds.y + bounds.height;
    push('full_length', rect(bounds.x, top, bounds.x + bounds.width, bottom), [
      ...shoulders,
      ...hips,
    ]);
  }

  // ── feet ────────────────────────────────────────────────────────────────
  //
  // Scale comes from the shin when a knee is available, and from the person's
  // height otherwise. A foot box derived from neither would be an invented
  // rectangle, so no ankle means no foot region.
  const footScale = (ankle: MirrorLandmark, knee: MirrorLandmark | undefined): number => {
    if (knee) return Math.max(1e-6, Math.abs(ankle.y - knee.y)) * 0.6;
    return bounds.height * 0.07;
  };
  if (leftAnkle) {
    const size = footScale(leftAnkle, leftKnee);
    push(
      'left_foot',
      rect(leftAnkle.x - size * 0.8, leftAnkle.y - size * 0.5, leftAnkle.x + size * 0.8, leftAnkle.y + size),
      [leftAnkle],
    );
  }
  if (rightAnkle) {
    const size = footScale(rightAnkle, rightKnee);
    push(
      'right_foot',
      rect(rightAnkle.x - size * 0.8, rightAnkle.y - size * 0.5, rightAnkle.x + size * 0.8, rightAnkle.y + size),
      [rightAnkle],
    );
  }

  return dedupeRegions(sortRegions(out));
}

/** Canonical total order. Every tie-break is a value, never insertion order. */
export function sortRegions(regions: DerivedMirrorRegion[]): DerivedMirrorRegion[] {
  return [...regions].sort((a, b) => {
    const classDelta =
      MIRROR_REGION_CLASS_ORDER.indexOf(a.regionClass) -
      MIRROR_REGION_CLASS_ORDER.indexOf(b.regionClass);
    if (classDelta !== 0) return classDelta;
    const areaDelta = b.bounds.width * b.bounds.height - a.bounds.width * a.bounds.height;
    if (areaDelta !== 0) return areaDelta;
    if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
    return a.bounds.y - b.bounds.y;
  });
}

/**
 * Remove regions that name the same piece of the picture.
 *
 * Runs over the SORTED list and keeps the first of any overlapping pair, so the
 * survivor is decided by the canonical order rather than by which detection the
 * runtime happened to emit first. Cross-class overlaps count: a `left_foot` and
 * a `right_foot` that land on top of each other — feet together, or one ankle
 * mis-placed — are the same crop twice, and shipping both would be a duplicate
 * the user has to reject by hand.
 */
export function dedupeRegions(regions: DerivedMirrorRegion[]): DerivedMirrorRegion[] {
  const kept: DerivedMirrorRegion[] = [];
  for (const region of regions) {
    const duplicate = kept.some(
      (existing) => intersectionOverUnion(existing.bounds, region.bounds) >= MIRROR_REGION_IOU_THRESHOLD,
    );
    if (!duplicate) kept.push(region);
  }
  return kept;
}
