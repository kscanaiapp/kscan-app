import type { ConfidenceComponents, EligibilityResult, Rejection } from './types';

/**
 * Provisional starting threshold, not yet validated against real
 * distributions (task section 40). See `overallConfidence` for how the
 * component scores are combined.
 */
export const ELIGIBILITY_CONFIDENCE_THRESHOLD = 0.5;

/**
 * The six component scores, in a fixed order. Named explicitly so that a
 * component which is missing entirely (rather than merely low) is still
 * examined by `overallConfidence` instead of being skipped.
 */
const CONFIDENCE_COMPONENT_KEYS = [
  'shotClassification',
  'segmentation',
  'anchorCompleteness',
  'geometryValidity',
  'sourceQuality',
  'productFidelity',
] as const satisfies readonly (keyof ConfidenceComponents)[];

/**
 * Overall confidence is the MIN of the component scores, not their average,
 * so a single critical failure (e.g. product fidelity) cannot be diluted by
 * otherwise-good scores — task section 33's explicit requirement.
 *
 * Every component must be a finite number within [0,1]. A component that is
 * absent, `NaN`, `Infinity`, negative, above 1, or not a number at all is
 * treated as a score of 0 (fail CLOSED), never as an absent constraint.
 *
 * Gate E certification repair (GATE-E-INT-001): `Math.min` returns `NaN` when
 * any argument is `NaN` or non-numeric, and `NaN < threshold` is `false` — so
 * the previous implementation returned `live2d: true` for an asset whose
 * confidence could not be computed at all. A malformed or incomplete result
 * must never become LIVE2D_ELIGIBLE. This changes nothing for well-formed
 * components: for six finite values in [0,1] the result is identical to the
 * previous `Math.min` of the same values.
 */
export function overallConfidence(components: ConfidenceComponents): number {
  let min = 1;
  for (const key of CONFIDENCE_COMPONENT_KEYS) {
    const raw: unknown = components?.[key];
    const score = typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 && raw <= 1 ? raw : 0;
    if (score < min) min = score;
  }
  return min;
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
