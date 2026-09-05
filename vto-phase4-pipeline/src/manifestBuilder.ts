import type { ConfidenceExplanation } from './confidenceExplain';
import { KSGARMENT_SCHEMA_VERSION, type GarmentControlPoint, type KsgarmentManifest, type MeshDefinition } from './garmentContract';
import { deterministicAssetId } from './hashing';
import type {
  AssetStatus,
  ConfidenceComponents,
  CorrectionLogRef,
  EligibilityResult,
  EvidenceClass,
  Phase4AssetManifest,
  ProductFidelityQaResult,
  Rejection,
  ShotClassificationResult,
  SourceAdequacyEvidence,
  StageTiming,
} from './types';

/** Bump deliberately when this pipeline's algorithms change in a way that should invalidate prior assets (task section 28-29). */
export const PIPELINE_VERSION = '0.1.0';

export function computeAssetId(productRef: string, variantId: string | null, sourceSha256: string): string {
  return deterministicAssetId([productRef, variantId, sourceSha256, PIPELINE_VERSION, KSGARMENT_SCHEMA_VERSION]);
}

export function buildKsgarmentManifest(params: {
  productId: string;
  category: string;
  controlPoints: GarmentControlPoint[];
  meshDefinition: MeshDefinition;
  assetVersion: string;
}): KsgarmentManifest {
  return {
    version: KSGARMENT_SCHEMA_VERSION,
    productId: params.productId,
    category: params.category,
    subcategory: 'unknown',
    silhouette: 'unknown',
    sleeveLength: 'unknown',
    garmentLength: 'unknown',
    neckline: 'unknown',
    controlPoints: params.controlPoints,
    meshDefinition: params.meshDefinition,
    texture: 'texture.png',
    alphaMask: 'alpha.png',
    assetVersion: params.assetVersion,
  };
}

export function buildAssetManifest(params: {
  productRef: string;
  retailer: string | null;
  variantId: string | null;
  category: string;
  evidenceClass: EvidenceClass;
  sourceRef: string;
  sourceSha256: string;
  sourceWidth: number;
  sourceHeight: number;
  sourceFormat: 'png' | 'jpeg' | 'webp';
  shotClassification: ShotClassificationResult;
  confidenceComponents: ConfidenceComponents;
  confidenceExplanation: ConfidenceExplanation;
  qa: ProductFidelityQaResult | null;
  eligibility: EligibilityResult;
  rejection: Rejection | null;
  ksgarment: KsgarmentManifest | null;
  anchorEvidence: { id: string; confidence: number }[];
  stageTimings: StageTiming[];
  correctionHistory?: CorrectionLogRef[];
  status?: AssetStatus;
  sourceAdequacy: SourceAdequacyEvidence;
}): Phase4AssetManifest {
  const assetId = computeAssetId(params.productRef, params.variantId, params.sourceSha256);
  const status: AssetStatus = params.status ?? (params.rejection ? 'REJECTED' : 'CURRENT');

  return {
    assetId,
    pipelineVersion: PIPELINE_VERSION,
    contractVersion: KSGARMENT_SCHEMA_VERSION,
    assetVersion: '1',
    generatedAt: new Date().toISOString(),
    evidenceClass: params.evidenceClass,
    productIdentity: {
      productRef: params.productRef,
      retailer: params.retailer,
      variantId: params.variantId,
      category: params.category,
    },
    source: {
      ref: params.sourceRef,
      sha256: params.sourceSha256,
      width: params.sourceWidth,
      height: params.sourceHeight,
      format: params.sourceFormat,
    },
    shotClassification: params.shotClassification,
    confidenceComponents: params.confidenceComponents,
    confidenceExplanation: params.confidenceExplanation,
    qa: params.qa,
    eligibility: params.eligibility,
    status,
    rejection: params.rejection,
    ksgarment: params.ksgarment,
    anchorEvidence: params.anchorEvidence,
    sourceAdequacy: params.sourceAdequacy,
    correctionHistory: params.correctionHistory ?? [],
    stageTimings: params.stageTimings,
  };
}
