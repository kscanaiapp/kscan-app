import type { ConfidenceComponents, EligibilityResult, Rejection } from './types';

/**
 * Provisional starting threshold, not yet validated against real
 * distributions (task section 40). Overall confidence is the MIN of the
 * component scores, not their average, so a single critical failure (e.g.
 * product fidelity) cannot be diluted by otherwise-good scores — task
 * section 33's explicit requirement.
 */
export const ELIGIBILITY_CONFIDENCE_THRESHOLD = 0.5;

export function overallConfidence(components: ConfidenceComponents): number {
  return Math.min(
    components.shotClassification,
    components.segmentation,
    components.anchorCompleteness,
    components.geometryValidity,
    components.sourceQuality,
    components.productFidelity,
  );
}

/**
 * Phase 4 may never declare live3d eligible (task section 32) — this
 * program has no 3D reconstruction stage at all, so `live3d: false` is not
 * a policy choice here, it is a structural fact reflected in the type
 * (`EligibilityResult.live3d` is typed `false`, not `boolean`).
 */
export function resolveEligibility(components: ConfidenceComponents, rejection: Rejection | null): EligibilityResult {
  if (rejection) {
    return { live2d: false, live3d: false, reason: rejection.code };
  }
  const confidence = overallConfidence(components);
  if (confidence < ELIGIBILITY_CONFIDENCE_THRESHOLD) {
    return { live2d: false, live3d: false, reason: 'EXTRACTION_UNRELIABLE' };
  }
  return { live2d: true, live3d: false, reason: null };
}
