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

  const x2 = Math.min(box.x + box.width, imageWidth);
  const y2 = Math.min(box.y + box.height, imageHeight);
  const x1 = Math.max(box.x, 0);
  const y1 = Math.max(box.y, 0);

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
 * - If still tied, keep the earlier input.
 * Cross-type overlaps are preserved.
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
