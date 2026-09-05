import type { SourceAdequacyClass, SourceAdequacyEvidence } from './types';

/**
 * Explicitly PROVISIONAL diagnostic thresholds (addendum §A8-§A9) — same
 * posture as `ELIGIBILITY_CONFIDENCE_THRESHOLD` in eligibility.ts: a
 * starting point for measurement, never itself an eligibility/rejection
 * gate. Based on the POST-CROP garment-region short side, not the raw
 * source image's short side — a 659px source thumbnail with the garment
 * occupying a small fraction of it is a small garment texture regardless
 * of the source file's own resolution, and it is exactly that number
 * (garment texture resolution, not source file resolution) this diagnostic
 * exists to surface (addendum §A8: "the pipeline's existing minimum decode
 * size is not proof that those images are adequate Live garment
 * textures").
 */
export const ADEQUATE_SHORT_SIDE_PX = 256;
export const QUESTIONABLE_SHORT_SIDE_PX = 128;

/** Diagnostic short-side buckets for reporting (addendum §A8) — labels only, never a pass/fail gate. */
export const SHORT_SIDE_BUCKETS = ['<256', '256-383', '384-511', '512-767', '768+'] as const;
export type ShortSideBucket = (typeof SHORT_SIDE_BUCKETS)[number];

export function shortSideBucket(shortSidePx: number): ShortSideBucket {
  if (shortSidePx < 256) return '<256';
  if (shortSidePx < 384) return '256-383';
  if (shortSidePx < 512) return '384-511';
  if (shortSidePx < 768) return '512-767';
  return '768+';
}

/**
 * Computes the source-adequacy diagnostic. Called for EVERY item, whether
 * or not segmentation succeeded — an item rejected before a garment
 * bounding box could be measured is classified UNKNOWN (never conflated
 * with INADEQUATE: a source that was never measured is not evidence the
 * source was too small — addendum §A9's own example is the opposite
 * failure mode, a well-measured but small texture).
 */
export function computeSourceAdequacy(
  sourceWidth: number,
  sourceHeight: number,
  garmentBoundingWidthPx: number | null,
  garmentBoundingHeightPx: number | null,
): SourceAdequacyEvidence {
  const shortSidePx = Math.min(sourceWidth, sourceHeight);
  const longSidePx = Math.max(sourceWidth, sourceHeight);
  const garmentOccupancyRatio =
    garmentBoundingWidthPx !== null && garmentBoundingHeightPx !== null && sourceWidth > 0 && sourceHeight > 0
      ? (garmentBoundingWidthPx * garmentBoundingHeightPx) / (sourceWidth * sourceHeight)
      : null;

  if (garmentBoundingWidthPx === null || garmentBoundingHeightPx === null) {
    return {
      classification: 'UNKNOWN',
      sourceWidth,
      sourceHeight,
      shortSidePx,
      longSidePx,
      garmentBoundingWidthPx: null,
      garmentBoundingHeightPx: null,
      garmentOccupancyRatio: null,
      reason: 'no garment bounding box was measurable (rejected before or during segmentation) — source adequacy cannot be assessed independently of pipeline outcome',
    };
  }

  const garmentShortSide = Math.min(garmentBoundingWidthPx, garmentBoundingHeightPx);
  let classification: SourceAdequacyClass;
  let reason: string;
  if (garmentShortSide >= ADEQUATE_SHORT_SIDE_PX) {
    classification = 'ADEQUATE';
    reason = `garment-region short side ${garmentShortSide}px meets the ${ADEQUATE_SHORT_SIDE_PX}px provisional diagnostic floor`;
  } else if (garmentShortSide >= QUESTIONABLE_SHORT_SIDE_PX) {
    classification = 'QUESTIONABLE';
    reason = `garment-region short side ${garmentShortSide}px is below the ${ADEQUATE_SHORT_SIDE_PX}px provisional floor but at/above ${QUESTIONABLE_SHORT_SIDE_PX}px`;
  } else {
    classification = 'INADEQUATE';
    reason = `garment-region short side ${garmentShortSide}px is below the ${QUESTIONABLE_SHORT_SIDE_PX}px provisional diagnostic floor`;
  }

  return {
    classification,
    sourceWidth,
    sourceHeight,
    shortSidePx,
    longSidePx,
    garmentBoundingWidthPx,
    garmentBoundingHeightPx,
    garmentOccupancyRatio,
    reason,
  };
}
