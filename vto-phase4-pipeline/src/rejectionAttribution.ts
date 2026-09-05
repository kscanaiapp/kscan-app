import type { ConfidenceExplanation } from './confidenceExplain';
import type { SourcePreflight } from './sourcePreflight';
import type { Phase4AssetManifest, RejectionCode, ShotClass } from './types';

/**
 * Phase 4.2 §20 + §42.
 *
 * §20: Phase 4.1's real baseline reported `EXTRACTION_UNRELIABLE: 29/220`
 * as one opaque bucket. That code is reachable from two structurally
 * different places — an extraction-stage refusal, and the confidence gate —
 * and the confidence gate can be held by any of six components. Reported as
 * one number it is not actionable.
 *
 * §42: separates failures the IMPLEMENTATION caused from failures the
 * SOURCE caused. This distinction sets the denominator of the §43 repair
 * target, so it is defined conservatively and mechanically: a failure counts
 * as PIPELINE_DRIVEN only when the source was already judged addressable
 * (EASY/MEDIUM by the existing contract) AND the cause is something this
 * pipeline computes about it. A source that is genuinely too small, genuinely
 * multi-garment, or genuinely model-worn is SOURCE_DRIVEN — counting those as
 * pipeline-driven would inflate the denominator with failures no amount of
 * engineering could repair, which §43 explicitly forbids.
 */

export type RejectionCause =
  // ── Confidence-gate causes, one per limiting component ──
  | 'CONFIDENCE_SEGMENTATION'
  | 'CONFIDENCE_ANCHORS'
  | 'CONFIDENCE_GEOMETRY'
  | 'CONFIDENCE_SHOT_CLASSIFICATION'
  | 'CONFIDENCE_SOURCE_QUALITY'
  | 'CONFIDENCE_PRODUCT_FIDELITY'
  | 'CONFIDENCE_MALFORMED_COMPONENT'
  // ── Stage-gate causes ──
  | 'STAGE_HARD_NO_EXTRACTION_PATH'
  | 'STAGE_HARD_NON_UNIFORM_BACKGROUND'
  | 'STAGE_NO_GARMENT_REGION'
  | 'STAGE_CROP_INCOMPLETE'
  | 'STAGE_MULTIPLE_GARMENTS'
  | 'STAGE_GEOMETRY_INVALID'
  | 'STAGE_ANCHORS_INCOMPLETE'
  | 'STAGE_PRODUCT_FIDELITY_FAILED'
  | 'STAGE_PATTERN_UNRECOVERABLE'
  | 'STAGE_UNSUPPORTED_CATEGORY'
  | 'STAGE_SOURCE_TOO_SMALL'
  | 'STAGE_VARIANT_AMBIGUOUS'
  | 'UNATTRIBUTED';

export type FailureAttribution = 'PIPELINE_DRIVEN' | 'SOURCE_DRIVEN' | 'NOT_APPLICABLE';

export interface RejectionAttributionResult {
  code: RejectionCode | null;
  cause: RejectionCause;
  /** Which of the two structurally different paths produced the code. */
  gate: 'confidence' | 'stage' | 'none';
  attribution: FailureAttribution;
  /** Named, measured contributors — never a bare label. */
  detail: Record<string, string | number | boolean | null>;
  /** Why this attribution, in words. */
  rationale: string;
}

const CONFIDENCE_CAUSE_BY_COMPONENT: Record<string, RejectionCause> = {
  segmentation: 'CONFIDENCE_SEGMENTATION',
  anchorCompleteness: 'CONFIDENCE_ANCHORS',
  geometryValidity: 'CONFIDENCE_GEOMETRY',
  shotClassification: 'CONFIDENCE_SHOT_CLASSIFICATION',
  sourceQuality: 'CONFIDENCE_SOURCE_QUALITY',
  productFidelity: 'CONFIDENCE_PRODUCT_FIDELITY',
};

/**
 * Causes that are properties of the SOURCE PHOTOGRAPH, which no amount of
 * work inside the authorized Phase 4.2 surfaces could repair. Everything
 * else, for an addressable source, is the implementation's responsibility.
 */
const SOURCE_DRIVEN_CAUSES: ReadonlySet<RejectionCause> = new Set<RejectionCause>([
  'STAGE_HARD_NO_EXTRACTION_PATH',
  'STAGE_HARD_NON_UNIFORM_BACKGROUND',
  'STAGE_MULTIPLE_GARMENTS',
  'STAGE_CROP_INCOMPLETE',
  'STAGE_SOURCE_TOO_SMALL',
  'STAGE_UNSUPPORTED_CATEGORY',
  'STAGE_VARIANT_AMBIGUOUS',
]);

/** Addressability per the EXISTING contract (§14) — not a widened definition. */
function isAddressable(shotClass: ShotClass | null): boolean {
  return shotClass === 'EASY' || shotClass === 'MEDIUM';
}

function stageCause(code: RejectionCode, message: string): RejectionCause {
  switch (code) {
    case 'OCCLUSION_TOO_HIGH':
      return 'STAGE_HARD_NO_EXTRACTION_PATH';
    case 'EXTRACTION_UNRELIABLE':
      // Reachable at the extraction stage only for a HARD, non-uniform-background
      // source; the confidence-gate route is handled separately by the caller.
      return 'STAGE_HARD_NON_UNIFORM_BACKGROUND';
    case 'GARMENT_NOT_PRIMARY':
      return 'STAGE_NO_GARMENT_REGION';
    case 'CROP_INCOMPLETE':
      return 'STAGE_CROP_INCOMPLETE';
    case 'MULTIPLE_GARMENTS':
      return 'STAGE_MULTIPLE_GARMENTS';
    case 'GEOMETRY_INVALID':
      return 'STAGE_GEOMETRY_INVALID';
    case 'ANCHORS_INCOMPLETE':
      return 'STAGE_ANCHORS_INCOMPLETE';
    case 'PRODUCT_FIDELITY_FAILED':
      return 'STAGE_PRODUCT_FIDELITY_FAILED';
    case 'PATTERN_UNRECOVERABLE':
      return 'STAGE_PATTERN_UNRECOVERABLE';
    case 'UNSUPPORTED_CATEGORY':
      return 'STAGE_UNSUPPORTED_CATEGORY';
    case 'SOURCE_TOO_SMALL':
      return 'STAGE_SOURCE_TOO_SMALL';
    case 'VARIANT_AMBIGUOUS':
      return 'STAGE_VARIANT_AMBIGUOUS';
    default:
      return message ? 'UNATTRIBUTED' : 'UNATTRIBUTED';
  }
}

/**
 * A confidence-gate rejection is recognized by the message shape the
 * pipeline emits for it, which is the only place `overall confidence` is
 * used as a prefix. Matching on the message rather than the stage is
 * deliberate: the QA stage also emits `stage: 'qa'`, so the stage alone
 * cannot distinguish the two paths.
 */
function isConfidenceGateRejection(message: string): boolean {
  return message.startsWith('overall confidence');
}

export function attributeRejection(
  manifest: Pick<Phase4AssetManifest, 'rejection' | 'shotClassification' | 'confidenceExplanation' | 'eligibility'>,
  preflight?: SourcePreflight | null,
): RejectionAttributionResult {
  const rejection = manifest.rejection;
  const shotClass = manifest.shotClassification?.shotClass ?? null;
  const addressable = isAddressable(shotClass);

  if (!rejection) {
    return {
      code: null,
      cause: 'UNATTRIBUTED',
      gate: 'none',
      attribution: 'NOT_APPLICABLE',
      detail: { eligible: manifest.eligibility?.live2d ?? false },
      rationale: 'No rejection — nothing to attribute.',
    };
  }

  const explanation: ConfidenceExplanation | undefined = manifest.confidenceExplanation;

  if (isConfidenceGateRejection(rejection.message) && explanation) {
    const malformed = explanation.malformedComponents.length > 0;
    const limiter = explanation.limitingComponents[0];
    const cause: RejectionCause = malformed
      ? 'CONFIDENCE_MALFORMED_COMPONENT'
      : (CONFIDENCE_CAUSE_BY_COMPONENT[limiter] ?? 'UNATTRIBUTED');

    const detail: Record<string, string | number | boolean | null> = {
      overallConfidence: explanation.overall,
      limitingComponents: explanation.limitingComponents.join(','),
      malformedComponents: explanation.malformedComponents.join(',') || null,
      shotClass,
    };
    for (const c of explanation.components) detail['component.' + c.key] = c.score;
    if (preflight) {
      detail['preflight.totalComponentCount'] = preflight.totalComponentCount;
      detail['preflight.significantComponentCount'] = preflight.significantComponentCount;
      detail['preflight.shortSidePx'] = preflight.shortSidePx;
      detail['preflight.garmentOccupancy'] = preflight.garmentOccupancy;
      detail['preflight.backgroundUniformity'] = preflight.backgroundUniformity;
      detail['preflight.paddingTotalFraction'] = preflight.padding.totalFraction;
    }

    // A confidence-gate miss on an ADDRESSABLE source is, by §42's own
    // definition, an internal-confidence failure — the source was judged
    // usable and the implementation's own scoring rejected it.
    const attribution: FailureAttribution = addressable ? 'PIPELINE_DRIVEN' : 'SOURCE_DRIVEN';

    return {
      code: rejection.code,
      cause,
      gate: 'confidence',
      attribution,
      detail,
      rationale: addressable
        ? 'Source is addressable (' + shotClass + ') and every stage gate passed; the internal confidence score alone rejected it, limited by ' + explanation.limitingComponents.join(' + ') + '.'
        : 'Confidence gate missed on a non-addressable (' + shotClass + ') source — the source, not the scoring, is the constraint.',
    };
  }

  const cause = stageCause(rejection.code, rejection.message);
  const sourceDriven = SOURCE_DRIVEN_CAUSES.has(cause);
  const attribution: FailureAttribution = !addressable || sourceDriven ? 'SOURCE_DRIVEN' : 'PIPELINE_DRIVEN';

  const detail: Record<string, string | number | boolean | null> = {
    stage: rejection.stage,
    shotClass,
    message: rejection.message.slice(0, 240),
  };
  if (preflight) {
    detail['preflight.significantComponentCount'] = preflight.significantComponentCount;
    detail['preflight.largestComponentRatio'] = preflight.largestComponentRatio;
    detail['preflight.borderContactEdges'] = preflight.borderContactEdges;
    detail['preflight.garmentOccupancy'] = preflight.garmentOccupancy;
    detail['preflight.paddingTotalFraction'] = preflight.padding.totalFraction;
    detail['preflight.skinRatioProxy'] = preflight.skinRatioProxy;
  }

  return {
    code: rejection.code,
    cause,
    gate: 'stage',
    attribution,
    detail,
    rationale: !addressable
      ? 'Source is not addressable (' + shotClass + ') — Phase 4 deliberately has no path for it.'
      : sourceDriven
        ? 'Addressable source, but the rejection names a property of the photograph itself (' + cause + ') rather than of the implementation.'
        : 'Addressable source failed at the ' + rejection.stage + ' stage (' + cause + ') — a stage this pipeline owns.',
  };
}
