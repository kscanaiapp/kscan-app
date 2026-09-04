import { validateKsgarmentManifest, type GarmentControlPoint } from './garmentContract';
import type { DecodedSource } from './codec';
import { runPipelineForImage, type PipelineRunOptions } from './pipeline';
import { overallConfidence } from './eligibility';
import type { CorrectionLogRef, Phase4AssetManifest, Phase4ProductInput } from './types';

/**
 * Task section 37: "Do not build a large moderation/admin product. Build a
 * simple deterministic correction mechanism." Every correction here is a
 * pure function from (original manifest + a correction request) to a new,
 * fully re-validated manifest — never a silent field patch that skips QA.
 *
 * All five permitted correction types from task section 37 are implemented,
 * three by re-running the real pipeline with a narrow, named override
 * (SHOT_CLASS_OVERRIDE, MASK_REPLACE, CROP_CORRECTION), one by patching the
 * accepted-but-imperfect geometry and re-validating it (ANCHOR_ADJUST), and
 * one as a guarded override that is structurally refused against a real
 * product-fidelity failure (ELIGIBILITY_OVERRIDE) — see the guard below.
 *
 * `MASK_REPLACE` is implemented as a segmentation color-threshold override,
 * not a real interactive mask-editing UI (none exists in this batch-only
 * lane) — recorded honestly in docs/vto-phase4-defect-ledger.md as a P9
 * follow-up rather than presented as more than it is.
 */

export type CorrectionType =
  | 'MASK_REPLACE'
  | 'ANCHOR_ADJUST'
  | 'SHOT_CLASS_OVERRIDE'
  | 'CROP_CORRECTION'
  | 'ELIGIBILITY_OVERRIDE';

export interface CorrectionRequest {
  type: CorrectionType;
  reason: string;
  operator: string;
  shotClassOverride?: 'EASY' | 'MEDIUM' | 'HARD' | 'UNSUPPORTED';
  segmentationThresholdOverride?: number;
  edgeMarginFractionOverride?: number;
  anchorAdjustments?: GarmentControlPoint[];
  eligibilityOverrideValue?: boolean;
}

export interface CorrectionLogEntry {
  correctionId: string;
  assetId: string;
  productId: string;
  variantId: string | null;
  originalFailureOrReason: string;
  correctionType: CorrectionType;
  originalValue: unknown;
  correctedValue: unknown;
  operator: string;
  automated: true;
  correctionDurationMs: number;
  appliedAt: string;
  postCorrectionResult: 'ACCEPTED' | 'STILL_REJECTED' | 'REFUSED';
  refusalReason?: string;
}

export interface CorrectionOutcome {
  manifest: Phase4AssetManifest;
  /** Non-null only when the correction re-ran extraction/canonicalization; a pure manifest patch (ANCHOR_ADJUST, ELIGIBILITY_OVERRIDE) leaves the previously-persisted texture/alpha bundle untouched since the assetId (and therefore its files) does not change. */
  texture: import('./pixels').RgbaImage | null;
  alphaMask: import('./pixels').RgbaImage | null;
  logEntry: CorrectionLogEntry;
}

let correctionCounter = 0;

export function applyCorrection(
  original: Phase4AssetManifest,
  product: Phase4ProductInput,
  sourceRef: string,
  decoded: DecodedSource,
  request: CorrectionRequest,
): CorrectionOutcome {
  const start = Date.now();
  const originalFailureOrReason = original.rejection ? `${original.rejection.code}: ${original.rejection.message}` : 'no prior rejection';

  // ELIGIBILITY_OVERRIDE guard — task section 37: "No manual override may bypass product-fidelity validation silently."
  if (request.type === 'ELIGIBILITY_OVERRIDE') {
    const blockedByFidelity = original.rejection?.code === 'PRODUCT_FIDELITY_FAILED' || original.rejection?.code === 'PATTERN_UNRECOVERABLE';
    if (blockedByFidelity && request.eligibilityOverrideValue === true) {
      return {
        manifest: original,
        texture: null,
        alphaMask: null,
        logEntry: buildLogEntry(original, product, request, originalFailureOrReason, original, start, 'REFUSED', `refused: cannot override a real product-fidelity failure (${original.rejection?.code})`),
      };
    }
    const corrected: Phase4AssetManifest = {
      ...original,
      eligibility: { live2d: !!request.eligibilityOverrideValue, live3d: false, reason: request.eligibilityOverrideValue ? null : original.eligibility.reason },
      status: request.eligibilityOverrideValue ? 'CURRENT' : original.status,
      correctionHistory: [...original.correctionHistory, correctionRef(request.type)],
    };
    return {
      manifest: corrected,
      texture: null,
      alphaMask: null,
      logEntry: buildLogEntry(original, product, request, originalFailureOrReason, corrected, start, corrected.eligibility.live2d ? 'ACCEPTED' : 'STILL_REJECTED'),
    };
  }

  if (request.type === 'ANCHOR_ADJUST') {
    if (!original.ksgarment) {
      return {
        manifest: original,
        texture: null,
        alphaMask: null,
        logEntry: buildLogEntry(original, product, request, originalFailureOrReason, original, start, 'REFUSED', 'refused: no geometry exists yet to adjust (asset was rejected before geometry generation)'),
      };
    }
    const byId = new Map(original.ksgarment.controlPoints.map((cp) => [cp.id, cp]));
    for (const adj of request.anchorAdjustments ?? []) byId.set(adj.id, adj);
    const updatedManifest = { ...original.ksgarment, controlPoints: [...byId.values()] };
    const validation = validateKsgarmentManifest(updatedManifest);
    const corrected: Phase4AssetManifest = {
      ...original,
      ksgarment: updatedManifest,
      rejection: validation.valid ? null : { code: 'GEOMETRY_INVALID', message: validation.errors.join('; '), stage: 'geometry_generation' },
      status: validation.valid ? 'CURRENT' : 'REJECTED',
      confidenceComponents: { ...original.confidenceComponents, anchorCompleteness: validation.valid ? 1 : original.confidenceComponents.anchorCompleteness },
      correctionHistory: [...original.correctionHistory, correctionRef(request.type)],
    };
    corrected.eligibility = validation.valid
      ? { live2d: overallConfidence(corrected.confidenceComponents) >= 0.5, live3d: false, reason: overallConfidence(corrected.confidenceComponents) >= 0.5 ? null : 'EXTRACTION_UNRELIABLE' }
      : { live2d: false, live3d: false, reason: 'GEOMETRY_INVALID' };
    return {
      manifest: corrected,
      texture: null,
      alphaMask: null,
      logEntry: buildLogEntry(original, product, request, originalFailureOrReason, corrected, start, corrected.eligibility.live2d ? 'ACCEPTED' : 'STILL_REJECTED'),
    };
  }

  // MASK_REPLACE / SHOT_CLASS_OVERRIDE / CROP_CORRECTION — re-run the real pipeline with a narrow override, full QA re-run included.
  const options: PipelineRunOptions = {
    shotClassOverride: request.shotClassOverride,
    segmentationThresholdOverride: request.segmentationThresholdOverride,
    edgeMarginFractionOverride: request.edgeMarginFractionOverride,
  };
  const correctedRun = runPipelineForImage(product, sourceRef, decoded, options);
  const corrected = correctedRun.manifest;
  corrected.correctionHistory = [...original.correctionHistory, correctionRef(request.type)];

  return {
    manifest: corrected,
    texture: correctedRun.texture,
    alphaMask: correctedRun.alphaMask,
    logEntry: buildLogEntry(original, product, request, originalFailureOrReason, corrected, start, corrected.rejection ? 'STILL_REJECTED' : 'ACCEPTED'),
  };
}

function correctionRef(type: CorrectionType): CorrectionLogRef {
  return { correctionId: nextCorrectionId(), type, appliedAt: new Date().toISOString() };
}

function nextCorrectionId(): string {
  correctionCounter += 1;
  return `corr-${correctionCounter.toString().padStart(6, '0')}`;
}

function buildLogEntry(
  original: Phase4AssetManifest,
  product: Phase4ProductInput,
  request: CorrectionRequest,
  originalFailureOrReason: string,
  correctedManifest: Phase4AssetManifest,
  startedAt: number,
  result: 'ACCEPTED' | 'STILL_REJECTED' | 'REFUSED',
  refusalReason?: string,
): CorrectionLogEntry {
  return {
    correctionId: nextCorrectionId(),
    assetId: original.assetId,
    productId: product.productRef,
    variantId: product.variantId,
    originalFailureOrReason,
    correctionType: request.type,
    originalValue: summarizeManifest(original),
    correctedValue: summarizeManifest(correctedManifest),
    operator: request.operator,
    automated: true,
    correctionDurationMs: Date.now() - startedAt,
    appliedAt: new Date().toISOString(),
    postCorrectionResult: result,
    ...(refusalReason ? { refusalReason } : {}),
  };
}

function summarizeManifest(m: Phase4AssetManifest): unknown {
  return { status: m.status, rejection: m.rejection, eligibility: m.eligibility, shotClass: m.shotClassification.shotClass };
}
