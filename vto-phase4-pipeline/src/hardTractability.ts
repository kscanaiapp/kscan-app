import type { SourcePreflight } from './sourcePreflight';

/**
 * Phase 4.2 §15-§19: subdivide the HARD bucket for PLANNING ONLY.
 *
 * Phase 4.1's real baseline put 209 of 220 products into a single
 * undifferentiated HARD/occlusion bucket. That is too coarse to answer the
 * only question that matters for future investment (§62): would a
 * model-worn extraction R&D lane unlock a material fraction of the catalog,
 * or is the imagery hopeless regardless of technique?
 *
 * ────────────────────────────────────────────────────────────────────────
 * THIS MODULE CANNOT MAKE ANYTHING ELIGIBLE.
 *
 * It is deliberately a PURE FUNCTION OF `SourcePreflight` that returns a
 * label and nothing else. It is not imported by `eligibility.ts`,
 * `pipeline.ts`, or `shotClassifier.ts`; it cannot reach the confidence
 * components, the rejection code, or the shot class. A `HARD_TRACTABLE`
 * label means "worth researching later", never "accept this now" —
 * enforced by regression test in hardTractability.test.ts.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Every threshold below is an ESTIMATE derived from the Phase 4.1 real
 * corpus distribution, not ground truth (§16: "Do not pretend heuristic
 * estimates are ground truth"). The signals are proxies with known blind
 * spots, recorded in `limitations` on every result.
 */

export type HardTractability = 'HARD_TRACTABLE' | 'HARD_INTRACTABLE' | 'HARD_UNKNOWN';

export const HARD_TRACTABILITY_THRESHOLDS = {
  /** Above this border-ring stddev the background is "busy" — deterministic background subtraction has no chance and even a model must fight the scene. */
  busyBackgroundUniformity: 34,
  /** More than this many significant foreground regions indicates layering / multiple garments / props. */
  maxSignificantRegions: 3,
  /** Skin fraction of the foreground above which the body dominates the frame (seated/angled/large exposed areas). */
  highSkinRatio: 0.28,
  /** Below this, a "HARD" call is probably driven by background complexity rather than a person at all. */
  lowSkinRatio: 0.1,
  /** Largest component must hold at least this share of the foreground to be a single coherent subject. */
  minLargestComponentRatio: 0.7,
  /** Subject bounding box must cover at least this share of the frame to carry usable garment pixels. */
  minGarmentOccupancy: 0.12,
  /** Touching this many image edges means the subject is cropped by the frame. */
  maxBorderContactEdges: 2,
} as const;

export interface HardTractabilityResult {
  tractability: HardTractability;
  /** Named signals that drove the verdict, each an ESTIMATE. */
  signals: {
    backgroundComplexity: number;
    significantRegions: number;
    skinRatioProxy: number;
    largestComponentRatio: number;
    garmentOccupancy: number;
    borderContactEdges: number;
    cropComplete: boolean;
  };
  /** Human-readable reasons, in evaluation order. */
  reasons: string[];
  limitations: string[];
}

const LIMITATIONS = [
  'skinRatioProxy is a coarse RGB bounds heuristic, not a person/pose detector — it under-reports darker skin tones and over-reports warm-toned garments and wood/tan backgrounds.',
  'No pose, frontality, or limb-position estimation exists in this pipeline; "arms mostly clear" is approximated only by region count and skin fraction.',
  'Layering is inferred from foreground region count, which cannot distinguish a second garment from a prop, a shadow, or a segmentation artefact.',
  'These labels are unvalidated against human judgement — no ground-truth tractability corpus exists (§38: NO_REFERENCE).',
];

/**
 * Classifies an already-HARD source. Callers must only invoke this for
 * sources the shot classifier called HARD; it does not itself re-derive the
 * shot class and must never be used to override one.
 */
export function classifyHardTractability(preflight: SourcePreflight): HardTractabilityResult {
  const t = HARD_TRACTABILITY_THRESHOLDS;
  const signals = {
    backgroundComplexity: preflight.backgroundUniformity,
    significantRegions: preflight.significantComponentCount,
    skinRatioProxy: preflight.skinRatioProxy,
    largestComponentRatio: preflight.largestComponentRatio,
    garmentOccupancy: preflight.garmentOccupancy,
    borderContactEdges: preflight.borderContactEdges,
    cropComplete: preflight.borderContactEdges <= t.maxBorderContactEdges,
  };
  const reasons: string[] = [];

  // Unknown first: if the frame carries no measurable subject at all, no
  // tractability claim is honest in either direction.
  if (preflight.foregroundCoverage <= 0 || preflight.largestComponentRatio <= 0 || preflight.significantComponentCount === 0) {
    reasons.push('no measurable foreground subject — tractability is not assessable');
    return { tractability: 'HARD_UNKNOWN', signals, reasons, limitations: LIMITATIONS };
  }

  // Intractable: any single disqualifier is sufficient (§18's example is a
  // conjunction, but each condition alone already defeats the deterministic
  // path AND materially raises the cost of any learned path).
  let intractable = false;
  if (preflight.backgroundUniformity > t.busyBackgroundUniformity) {
    reasons.push(`busy background (uniformity ${preflight.backgroundUniformity} > ${t.busyBackgroundUniformity})`);
    intractable = true;
  }
  if (preflight.significantComponentCount > t.maxSignificantRegions) {
    reasons.push(`${preflight.significantComponentCount} significant foreground regions (> ${t.maxSignificantRegions}) — layering, props, or multiple garments`);
    intractable = true;
  }
  if (preflight.skinRatioProxy > t.highSkinRatio) {
    reasons.push(`skin fraction ${preflight.skinRatioProxy} > ${t.highSkinRatio} — body dominates the frame, large garment regions likely hidden`);
    intractable = true;
  }
  if (preflight.largestComponentRatio < t.minLargestComponentRatio) {
    reasons.push(`largest region holds only ${preflight.largestComponentRatio} of foreground (< ${t.minLargestComponentRatio}) — fragmented subject`);
    intractable = true;
  }
  if (preflight.garmentOccupancy < t.minGarmentOccupancy) {
    reasons.push(`subject occupies only ${preflight.garmentOccupancy} of the frame (< ${t.minGarmentOccupancy}) — too few garment pixels to recover`);
    intractable = true;
  }
  if (!signals.cropComplete) {
    reasons.push(`subject touches ${preflight.borderContactEdges}/4 edges — cropped by the frame`);
    intractable = true;
  }
  if (intractable) return { tractability: 'HARD_INTRACTABLE', signals, reasons, limitations: LIMITATIONS };

  // Tractable: a plain-background, single-subject, uncropped,
  // moderately-occluded frame — §17's conceptual example.
  reasons.push(
    `plain background (${preflight.backgroundUniformity} <= ${t.busyBackgroundUniformity}), ` +
      `${preflight.significantComponentCount} significant region(s), ` +
      `skin ${preflight.skinRatioProxy}, occupancy ${preflight.garmentOccupancy}, uncropped`,
  );
  if (preflight.skinRatioProxy < t.lowSkinRatio) {
    reasons.push(`low skin fraction (${preflight.skinRatioProxy} < ${t.lowSkinRatio}) — HARD call may be background-driven rather than model-worn`);
  }
  return { tractability: 'HARD_TRACTABLE', signals, reasons, limitations: LIMITATIONS };
}
