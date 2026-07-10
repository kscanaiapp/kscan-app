import type { BoundingBox } from './types';

export interface ValidatedBox {
  box: BoundingBox;
  area: number;
  valid: boolean;
  reason?: string;
}

/**
 * Validate a bounding box. Clamp partially visible boxes to image bounds.
 * Reject invalid or completely out-of-frame boxes safely.
 */
export function validateBox(box: BoundingBox, imageWidth: number, imageHeight: number): ValidatedBox {
  if (!box || typeof box !== 'object' || Array.isArray(box)) {
    return { box, area: 0, valid: false, reason: 'Box is not an object.' };
  }

  const dims = [box.x, box.y, box.width, box.height];
  if (dims.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return { box, area: 0, valid: false, reason: 'Box coordinates must be finite numbers.' };
  }

  if (dims.some((v) => v > Number.MAX_SAFE_INTEGER || v < Number.MIN_SAFE_INTEGER)) {
    return { box, area: 0, valid: false, reason: 'Box coordinates exceed safe numeric range.' };
  }

  if (box.width <= 0 || box.height <= 0) {
    return { box, area: 0, valid: false, reason: 'Box dimensions must be positive.' };
  }

  if (imageWidth <= 0 || imageHeight <= 0) {
    return { box, area: 0, valid: false, reason: 'Image dimensions must be positive.' };
  }

  // Rounding policy: round outward to whole pixels. The start edge is
  // floored and the end edge is ceiled, so the resulting integer box is
  // always a superset of the requested fractional box. This is a privacy
  // redaction primitive, so under-covering a region (leaving PII pixels
  // unmasked because they fell on a fractional coordinate) is unacceptable;
  // over-covering by at most one pixel per edge is not. Pixel array
  // indexing requires integer coordinates — a fractional box passed through
  // unrounded would silently fail to write some in-box pixels, since
  // non-integer indices on a Uint8Array do not address the backing buffer.
  const x2 = Math.min(Math.ceil(box.x + box.width), imageWidth);
  const y2 = Math.min(Math.ceil(box.y + box.height), imageHeight);
  const x1 = Math.max(Math.floor(box.x), 0);
  const y1 = Math.max(Math.floor(box.y), 0);

  const width = x2 - x1;
  const height = y2 - y1;

  if (width <= 0 || height <= 0) {
    return { box, area: 0, valid: false, reason: 'Box is completely outside the image.' };
  }

  const clamped: BoundingBox = { x: x1, y: y1, width, height };
  return { box: clamped, area: width * height, valid: true };
}

export function boxArea(box: BoundingBox): number {
  if (!box || typeof box.width !== 'number' || typeof box.height !== 'number') return 0;
  if (box.width <= 0 || box.height <= 0) return 0;
  return box.width * box.height;
}

export function intersectionArea(a: BoundingBox, b: BoundingBox): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return width * height;
}

export function unionArea(a: BoundingBox, b: BoundingBox): number {
  return boxArea(a) + boxArea(b) - intersectionArea(a, b);
}

export function boxIoU(a: BoundingBox, b: BoundingBox): number {
  const union = unionArea(a, b);
  if (union <= 0) return 0;
  return intersectionArea(a, b) / union;
}

/**
 * Deduplicate same-type regions using IoU >= 0.5.
 * - Keep higher confidence.
 * - If confidence is equal or absent, keep larger area.
 * - If still tied, keep the earlier input (relies on Array.prototype.sort
 *   being stable, guaranteed by the JS spec since ES2019 / Node 11+).
 * Cross-type overlaps are preserved.
 *
 * This is a greedy algorithm, not cluster-based: candidates are visited in
 * confidence order and kept only if they don't overlap anything already
 * kept. For a transitive chain A-B, B-C (where A and C do not overlap each
 * other), this can keep both A and C while dropping B, rather than
 * clustering all three into one region. That is intentional — A and C are
 * not duplicates of each other, so both surviving is correct.
 */
export function deduplicateRegions<T extends { box: BoundingBox; confidence?: number; type: string }>(
  regions: T[],
  iouThreshold = 0.5,
): T[] {
  if (!Array.isArray(regions)) return [];

  const sorted = [...regions].sort((a, b) => {
    const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
    if (confDiff !== 0) return confDiff;
    const areaDiff = boxArea(b.box) - boxArea(a.box);
    return areaDiff;
  });

  const kept: T[] = [];
  for (const candidate of sorted) {
    const sameTypeOverlap = kept.some(
      (existing) => existing.type === candidate.type && boxIoU(existing.box, candidate.box) >= iouThreshold,
    );
    if (!sameTypeOverlap) {
      kept.push(candidate);
    }
  }

  return kept;
}
