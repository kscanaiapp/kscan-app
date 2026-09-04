import type { RgbaImage } from './pixels';
import { maskWidthProfile } from './segmentation';
import { GARMENT_CONTROL_POINT_IDS, MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT, type GarmentControlPoint } from './garmentContract';
import type { AnchorCandidate } from './types';

/**
 * Deterministic anchor generation from the mask's per-row width profile —
 * "largest connected garment component; contour; bounding box; extrema;
 * concavities" per task section 24. No pose/landmark model is used.
 *
 * Row semantics (all measured from the alpha mask, not assumed):
 *  - shoulder row: near the top of the garment where the mask first
 *    reaches a broad, stable width.
 *  - armpit row: the first pronounced local minimum in width below the
 *    shoulder row (the concave notch where a sleeve meets the torso).
 *  - sleeve row: the widest row in the upper half (outer sleeve edge).
 *  - waist/torso row: mid-height.
 *  - hem row: the bottom of the garment.
 */
export function generateAnchors(alphaMask: RgbaImage): AnchorCandidate[] {
  const profile = maskWidthProfile(alphaMask);
  const validRows = profile.filter((p) => p.width > 0);
  if (validRows.length < 6) return [];

  const topRow = validRows[0].row;
  const bottomRow = validRows[validRows.length - 1].row;
  const span = bottomRow - topRow;
  const maxWidth = Math.max(...validRows.map((p) => p.width));
  const width = alphaMask.width;

  const rowAt = (fraction: number) => nearestValidRow(validRows, topRow + Math.round(fraction * span));

  const candidates: AnchorCandidate[] = [];

  const shoulderRow = rowAt(0.06);
  if (shoulderRow) {
    const conf = widthValidityConfidence(shoulderRow.width, maxWidth);
    candidates.push(makePoint('leftShoulder', shoulderRow.leftX, shoulderRow.row, width, alphaMask.height, conf));
    candidates.push(makePoint('rightShoulder', shoulderRow.rightX, shoulderRow.row, width, alphaMask.height, conf));
  }

  const hemRow = rowAt(0.97) ?? validRows[validRows.length - 1];
  {
    const conf = widthValidityConfidence(hemRow.width, maxWidth);
    candidates.push(makePoint('leftHem', hemRow.leftX, hemRow.row, width, alphaMask.height, conf));
    candidates.push(makePoint('rightHem', hemRow.rightX, hemRow.row, width, alphaMask.height, conf));
  }

  const waistRow = rowAt(0.55);
  if (waistRow) {
    const conf = widthValidityConfidence(waistRow.width, maxWidth);
    const centerX = (waistRow.leftX + waistRow.rightX) / 2;
    candidates.push(makePoint('waist', centerX, waistRow.row, width, alphaMask.height, conf));
    candidates.push(makePoint('leftTorso', waistRow.leftX, waistRow.row, width, alphaMask.height, conf));
    candidates.push(makePoint('rightTorso', waistRow.rightX, waistRow.row, width, alphaMask.height, conf));
  }

  // Sleeve row: widest row in the upper half.
  const upperHalf = validRows.filter((p) => p.row <= topRow + span * 0.5);
  if (upperHalf.length > 0) {
    const sleeveRow = upperHalf.reduce((best, p) => (p.width > best.width ? p : best), upperHalf[0]);
    const conf = clamp01((sleeveRow.width - (shoulderRow?.width ?? sleeveRow.width)) / Math.max(1, maxWidth) + 0.5);
    candidates.push(makePoint('leftSleeve', sleeveRow.leftX, sleeveRow.row, width, alphaMask.height, conf));
    candidates.push(makePoint('rightSleeve', sleeveRow.rightX, sleeveRow.row, width, alphaMask.height, conf));
  }

  // Armpit row: first pronounced local minimum between shoulder and waist.
  const band = validRows.filter((p) => p.row > (shoulderRow?.row ?? topRow) && p.row < (waistRow?.row ?? bottomRow));
  if (band.length >= 3) {
    let minEntry = band[0];
    for (const p of band) if (p.width < minEntry.width) minEntry = p;
    const neighborAvg =
      band.reduce((sum, p) => sum + p.width, 0) / band.length;
    const dipMagnitude = neighborAvg > 0 ? (neighborAvg - minEntry.width) / neighborAvg : 0;
    const conf = clamp01(dipMagnitude * 1.5);
    candidates.push(makePoint('leftArmpit', minEntry.leftX, minEntry.row, width, alphaMask.height, conf));
    candidates.push(makePoint('rightArmpit', minEntry.rightX, minEntry.row, width, alphaMask.height, conf));
  }

  return candidates;
}

export function requiredAnchorsPresent(candidates: readonly AnchorCandidate[], minConfidence = 0.5): boolean {
  for (const requiredId of MINIMUM_CONTROL_POINTS_FOR_ATTACHMENT) {
    const found = candidates.find((c) => c.point.id === requiredId && c.confidence >= minConfidence);
    if (!found) return false;
  }
  return true;
}

export function toControlPoints(candidates: readonly AnchorCandidate[], minConfidence = 0.35): GarmentControlPoint[] {
  return candidates.filter((c) => c.confidence >= minConfidence).map((c) => c.point);
}

function nearestValidRow<T extends { row: number; width: number; leftX: number; rightX: number }>(
  rows: readonly T[],
  targetRow: number,
): T | undefined {
  let best: T | undefined;
  let bestDist = Infinity;
  for (const r of rows) {
    const d = Math.abs(r.row - targetRow);
    if (d < bestDist) {
      bestDist = d;
      best = r;
    }
  }
  return best;
}

function widthValidityConfidence(rowWidth: number, maxWidth: number): number {
  if (maxWidth <= 0) return 0;
  return clamp01(rowWidth / (0.3 * maxWidth));
}

function makePoint(
  id: (typeof GARMENT_CONTROL_POINT_IDS)[number],
  x: number,
  y: number,
  imgWidth: number,
  imgHeight: number,
  confidence: number,
): AnchorCandidate {
  return {
    point: { id, u: clamp01(x / Math.max(1, imgWidth)), v: clamp01(y / Math.max(1, imgHeight)) },
    confidence: clamp01(confidence),
  };
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}
