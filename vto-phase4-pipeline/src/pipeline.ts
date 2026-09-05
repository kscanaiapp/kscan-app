import { generateAnchors, requiredAnchorsPresent, toControlPoints } from './anchors';
import { canonicalizeMedium } from './canonicalize';
import type { DecodedSource } from './codec';
import { resolveEligibility, overallConfidence } from './eligibility';
import type { FidelityReferenceHints } from './fidelity';
import { computeProductFidelity } from './fidelity';
import { TEMPLATE_FAMILY_BY_CANONICAL, validateKsgarmentManifest } from './garmentContract';
import { buildAssetManifest, buildKsgarmentManifest } from './manifestBuilder';
import { buildMeshDefinition } from './mesh';
import type { RgbaImage } from './pixels';
import { segmentGarment } from './segmentation';
import { computeSourceAdequacy } from './sourceAdequacy';
import { classifyShot } from './shotClassifier';
import type {
  ConfidenceComponents,
  Phase4AssetManifest,
  Phase4ProductInput,
  Rejection,
  StageTiming,
} from './types';

export interface PipelineRunOptions {
  fidelityHints?: FidelityReferenceHints;
  /** Correction mechanism hooks (task section 37) — see correction.ts for the operator-facing entry point. */
  shotClassOverride?: 'EASY' | 'MEDIUM' | 'HARD' | 'UNSUPPORTED';
  segmentationThresholdOverride?: number;
  edgeMarginFractionOverride?: number;
}

class StageTimer {
  private timings: StageTiming[] = [];

  run<T>(stage: StageTiming['stage'], fn: () => T): T {
    const start = Date.now();
    try {
      const result = fn();
      this.timings.push({ stage, durationMs: Date.now() - start, retryCount: 0, result: 'ok' });
      return result;
    } catch (err) {
      this.timings.push({ stage, durationMs: Date.now() - start, retryCount: 0, result: 'error' });
      throw err;
    }
  }

  recordRejected(stage: StageTiming['stage'], startedAt: number) {
    this.timings.push({ stage, durationMs: Date.now() - startedAt, retryCount: 0, result: 'rejected' });
  }

  all(): StageTiming[] {
    return this.timings;
  }
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Runs the full image -> canonical garment -> asset pipeline for one
 * already-decoded source image against one product record. Pure aside from
 * timing (`Date.now()`) — no filesystem/network I/O happens here (see
 * `sourceLoad.ts`/`assetStore.ts` for the I/O boundary), which is what
 * makes this function directly unit-testable against fixed pixel buffers.
 */
export interface PipelineRunResult {
  manifest: Phase4AssetManifest;
  texture: RgbaImage | null;
  alphaMask: RgbaImage | null;
}

export function runPipelineForImage(
  product: Phase4ProductInput,
  sourceRef: string,
  decoded: DecodedSource,
  options: PipelineRunOptions = {},
): PipelineRunResult {
  const timer = new StageTimer();
  let rejection: Rejection | null = null;
  let stageStart = Date.now();

  // --- classification (category gate + shot class) ---
  stageStart = Date.now();
  const templateFamily = TEMPLATE_FAMILY_BY_CANONICAL[product.category];
  if (!templateFamily) {
    rejection = { code: 'UNSUPPORTED_CATEGORY', message: `category "${product.category}" has no Live template-family mapping today`, stage: 'classification' };
    timer.recordRejected('classification', stageStart);
  }

  const classifiedResult = rejection ? classifyShot(decoded.image) : timer.run('classification', () => classifyShot(decoded.image));
  const shotResult = options.shotClassOverride
    ? { ...classifiedResult, shotClass: options.shotClassOverride, evidence: { ...classifiedResult.evidence, overriddenFrom: classifiedResult.shotClass } }
    : classifiedResult;

  if (!rejection && shotResult.shotClass === 'UNSUPPORTED') {
    const reasonEvidence = String(shotResult.evidence.reason ?? '');
    const code = reasonEvidence === 'too_many_disconnected_regions' ? 'MULTIPLE_GARMENTS' : 'GARMENT_NOT_PRIMARY';
    rejection = { code, message: `shot classifier could not analyze this source: ${reasonEvidence}`, stage: 'classification' };
  }

  // --- extraction ---
  let segmentation: ReturnType<typeof segmentGarment> | null = null;
  if (!rejection) {
    stageStart = Date.now();
    segmentation = classifyExtractionGate(
      decoded.image,
      shotResult.shotClass,
      shotResult.evidence,
      options.edgeMarginFractionOverride,
      options.segmentationThresholdOverride,
    );
    if (segmentation === null) {
      const skinTriggered = Number(shotResult.evidence.skinRatio ?? 0) >= 0.06;
      rejection = {
        code: skinTriggered ? 'OCCLUSION_TOO_HIGH' : 'EXTRACTION_UNRELIABLE',
        message: skinTriggered
          ? 'HARD-class source with detected skin-tone presence — this pipeline has no validated model-worn extraction path (task section 16: reject early)'
          : 'HARD-class source with a non-uniform background — background-color-based extraction is not defensible here',
        stage: 'extraction',
      };
      timer.recordRejected('extraction', stageStart);
    } else if (!segmentation.ok) {
      rejection = { code: 'GARMENT_NOT_PRIMARY', message: `no reliable garment region found (${segmentation.reason})`, stage: 'extraction' };
      timer.recordRejected('extraction', stageStart);
    } else {
      const edgesTouched = Object.values(segmentation.touchesEdge).filter(Boolean).length;
      if (edgesTouched >= 3) {
        rejection = { code: 'CROP_INCOMPLETE', message: `garment region touches ${edgesTouched}/4 image edges — likely cropped by the source photo`, stage: 'extraction' };
        timer.recordRejected('extraction', stageStart);
      } else {
        timer.run('extraction', () => segmentation);
      }
    }
  }

  // --- canonicalization ---
  let canonicalTexture: RgbaImage | null = null;
  let canonicalAlpha: RgbaImage | null = null;
  let appliedRotationDegrees = 0;
  if (!rejection && segmentation && segmentation.ok) {
    stageStart = Date.now();
    if (shotResult.shotClass === 'EASY') {
      canonicalTexture = segmentation.texture;
      canonicalAlpha = segmentation.alphaMask;
      timer.run('canonicalization', () => null);
    } else {
      const canon = canonicalizeMedium(segmentation.texture, segmentation.alphaMask);
      if (!canon.ok) {
        rejection = { code: 'GEOMETRY_INVALID', message: `measured tilt ${canon.measuredTiltDegrees.toFixed(1)}deg exceeds correctable bound`, stage: 'canonicalization' };
        timer.recordRejected('canonicalization', stageStart);
      } else {
        canonicalTexture = canon.texture;
        canonicalAlpha = canon.alphaMask;
        appliedRotationDegrees = canon.appliedRotationDegrees;
        timer.run('canonicalization', () => null);
      }
    }
  }

  // --- anchor generation ---
  let anchorCandidates: ReturnType<typeof generateAnchors> = [];
  if (!rejection && canonicalAlpha) {
    stageStart = Date.now();
    anchorCandidates = generateAnchors(canonicalAlpha);
    if (!requiredAnchorsPresent(anchorCandidates)) {
      rejection = { code: 'ANCHORS_INCOMPLETE', message: 'one or more of leftShoulder/rightShoulder/leftHem/rightHem could not be derived with sufficient confidence', stage: 'anchor_generation' };
      timer.recordRejected('anchor_generation', stageStart);
    } else {
      timer.run('anchor_generation', () => null);
    }
  }

  // --- geometry generation ---
  let ksgarment = null as ReturnType<typeof buildKsgarmentManifest> | null;
  if (!rejection && canonicalAlpha) {
    stageStart = Date.now();
    const controlPoints = toControlPoints(anchorCandidates);
    ksgarment = buildKsgarmentManifest({
      productId: product.productRef,
      category: product.category,
      controlPoints,
      meshDefinition: buildMeshDefinition(),
      assetVersion: '1',
    });
    const validation = validateKsgarmentManifest(ksgarment);
    if (!validation.valid) {
      rejection = { code: 'GEOMETRY_INVALID', message: `manifest validation failed: ${validation.errors.join('; ')}`, stage: 'geometry_generation' };
      timer.recordRejected('geometry_generation', stageStart);
    } else {
      timer.run('geometry_generation', () => null);
    }
  }

  // --- QA ---
  let qa = null as ReturnType<typeof computeProductFidelity> | null;
  if (!rejection && canonicalTexture && canonicalAlpha && segmentation && segmentation.ok) {
    stageStart = Date.now();
    qa = computeProductFidelity(canonicalTexture, canonicalAlpha, segmentation.maskPixelCount, segmentation.bboxPixelCount, options.fidelityHints);
    if (!qa.passed) {
      const patternFailure = qa.failureReasons.find((r) => r.startsWith('PATTERN_UNRECOVERABLE'));
      rejection = {
        code: patternFailure ? 'PATTERN_UNRECOVERABLE' : 'PRODUCT_FIDELITY_FAILED',
        message: qa.failureReasons.join('; '),
        stage: 'qa',
      };
      timer.recordRejected('qa', stageStart);
    } else {
      timer.run('qa', () => null);
    }
  }

  // --- confidence components (always computed, even on rejection, for defect-analysis evidence) ---
  const confidenceComponents: ConfidenceComponents = {
    shotClassification: shotResult.confidence,
    segmentation: segmentation && segmentation.ok ? clamp01(segmentation.fillRatio * (1 - Math.min(1, (segmentation.componentCount - 1) * 0.05))) : 0,
    anchorCompleteness: requiredAnchorAverage(anchorCandidates),
    geometryValidity: ksgarment ? clamp01(1 - Math.abs(appliedRotationDegrees) / 40) : 0,
    sourceQuality: clamp01((decoded.image.width * decoded.image.height) / (300 * 300)),
    productFidelity: qa ? (qa.passed ? 1 : 0) : 0,
  };

  const eligibility = resolveEligibility(confidenceComponents, rejection);
  // A confidence-gate failure (no explicit stage rejection, but eligibility
  // still resolved to ineligible — see eligibility.ts's threshold check)
  // must still populate `rejection`, so "ineligible" and "rejected" never
  // diverge: every Gate E rejection-distribution/rate computation and the
  // correction mechanism itself filter on `manifest.rejection`, and an item
  // that is truly ineligible but carries `rejection: null` would silently
  // vanish from both (see docs/vto-phase4-defect-ledger.md, PHASE4-007).
  if (!rejection && !eligibility.live2d && eligibility.reason) {
    rejection = { code: eligibility.reason, message: `overall confidence ${overallConfidence(confidenceComponents).toFixed(2)} is below the eligibility threshold`, stage: 'qa' };
  }

  stageStart = Date.now();
  timer.run('bundle_writing', () => null);

  // Source-adequacy diagnostic (addendum §A8-§A9) — a SEPARATE axis from
  // eligibility/rejection. Measured from the segmentation-stage bounding
  // box in ORIGINAL source-pixel coordinates (before canonicalization crop
  // or rotation) whenever segmentation succeeded, independent of whether
  // this item was later rejected downstream — "was the extracted garment
  // region big enough" is knowable as soon as a region was extracted at
  // all, and answering it must never depend on whether QA/anchors also
  // happened to pass.
  const garmentBoundingWidthPx = segmentation && segmentation.ok ? segmentation.bbox.maxX - segmentation.bbox.minX : null;
  const garmentBoundingHeightPx = segmentation && segmentation.ok ? segmentation.bbox.maxY - segmentation.bbox.minY : null;
  const sourceAdequacy = computeSourceAdequacy(decoded.image.width, decoded.image.height, garmentBoundingWidthPx, garmentBoundingHeightPx);

  const manifest = buildAssetManifest({
    productRef: product.productRef,
    retailer: product.retailer,
    variantId: product.variantId,
    category: product.category,
    evidenceClass: product.evidenceClass,
    sourceRef,
    sourceSha256: decoded.sha256,
    sourceWidth: decoded.image.width,
    sourceHeight: decoded.image.height,
    sourceFormat: decoded.format,
    shotClassification: shotResult,
    confidenceComponents,
    qa,
    eligibility,
    rejection,
    ksgarment,
    anchorEvidence: anchorCandidates.map((c) => ({ id: c.point.id, confidence: c.confidence })),
    stageTimings: timer.all(),
    sourceAdequacy,
  });

  return { manifest, texture: canonicalTexture, alphaMask: canonicalAlpha };
}

/** Bounded, defensible processing (task section 16): EASY/MEDIUM get a real background-based segmentation attempt; HARD is rejected before any extraction attempt (see docs/vto-phase4-defect-ledger.md for why no Hard-capable extraction exists yet). Returns null to signal "do not attempt". */
function classifyExtractionGate(
  image: import('./pixels').RgbaImage,
  shotClass: 'EASY' | 'MEDIUM' | 'HARD' | 'UNSUPPORTED',
  _evidence: Record<string, number | string | boolean>,
  edgeMarginFractionOverride?: number,
  segmentationThresholdOverride?: number,
): ReturnType<typeof segmentGarment> | null {
  if (shotClass === 'HARD') return null;
  return segmentGarment(image, edgeMarginFractionOverride ?? 0.02, segmentationThresholdOverride);
}

function requiredAnchorAverage(candidates: ReturnType<typeof generateAnchors>): number {
  const required = ['leftShoulder', 'rightShoulder', 'leftHem', 'rightHem'];
  const scores = required.map((id) => candidates.find((c) => c.point.id === id)?.confidence ?? 0);
  return scores.reduce((a, b) => a + b, 0) / scores.length;
}

export { overallConfidence };
