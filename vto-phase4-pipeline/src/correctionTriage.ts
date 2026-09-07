import type { RejectionCode } from './types';

/**
 * Post-baseline classification only (addendum §A15 / original brief §32-34).
 * Never alters the frozen baseline's actual eligible/rejected/systemError
 * outcome — purely a triage label layered on top, for Phase 4.1/4.2
 * planning. No minutes are estimated here; see §A15/§36 — only a real timed
 * human correction session may report `HUMAN CORRECTION MINUTES`, and none
 * occurred in this lane.
 */
export type CorrectionTriage = 'POTENTIALLY_CORRECTABLE' | 'NOT_ECONOMICALLY_CORRECTABLE' | 'UNKNOWN';

/**
 * Examples straight from the brief: minor mask repair, small anchor
 * correction, crop adjustment, source-image reselection, shot-class
 * correction are POTENTIALLY_CORRECTABLE; hidden geometry, missing
 * sleeve/hem, major model occlusion, multiple inseparable garments,
 * unsupported category, unreliable product identity are NOT.
 */
const POTENTIALLY_CORRECTABLE: readonly RejectionCode[] = [
  'EXTRACTION_UNRELIABLE',
  'ANCHORS_INCOMPLETE',
  'CROP_INCOMPLETE',
  'SOURCE_TOO_SMALL',
  'GEOMETRY_INVALID',
];

const NOT_ECONOMICALLY_CORRECTABLE: readonly RejectionCode[] = [
  // Audit P42-A-003 (A3): a HARD policy refusal is not fixable by mask
  // repair or crop adjustment — the pipeline declined to extract at all.
  // Under the old conflated code it was triaged POTENTIALLY_CORRECTABLE.
  'EXTRACTION_REFUSED_BY_POLICY',
  'OCCLUSION_TOO_HIGH',
  'MULTIPLE_GARMENTS',
  'GARMENT_NOT_PRIMARY',
  'UNSUPPORTED_CATEGORY',
  'PATTERN_UNRECOVERABLE',
  'VARIANT_AMBIGUOUS',
  // A real, measured product-fidelity failure is exactly what the
  // ELIGIBILITY_OVERRIDE correction type structurally refuses to bypass
  // (correction.ts) — it is not a "try again with a tweak" class of issue.
  'PRODUCT_FIDELITY_FAILED',
];

export function classifyCorrectionTriage(rejectionCode: RejectionCode | null): CorrectionTriage {
  if (rejectionCode === null) return 'UNKNOWN';
  if (POTENTIALLY_CORRECTABLE.includes(rejectionCode)) return 'POTENTIALLY_CORRECTABLE';
  if (NOT_ECONOMICALLY_CORRECTABLE.includes(rejectionCode)) return 'NOT_ECONOMICALLY_CORRECTABLE';
  return 'UNKNOWN';
}
