import type { GarmentControlPoint, KsgarmentManifest, LiveSupportedTemplateFamily } from './garmentContract';

/**
 * Phase 4 input product record — deliberately grounded in the real app's
 * Commerce contract (see docs/vto-phase4-source-authority.md, "Current
 * Commerce product contract authority"), not a second invented ID system.
 *
 * `productRef` is the exact identity concept the app already uses
 * (`VtoGarmentInput.productRef` / `LiveVtoGarmentDescriptor.productRef`,
 * "one product identity" per `types/vtoLive.ts`'s own comment) — correlation
 * only, never authorization, same as upstream.
 *
 * `variantId` mirrors `CanonicalPurchaseOption.variant` (a free-text,
 * nullable, retailer-declared label — not a canonical enumerated identity).
 * When two candidate images for the same `productRef` disagree on
 * `variantId`/image identity and neither is authoritative, Phase 4 treats
 * variant identity as ambiguous (task section 14) rather than guessing from
 * pixel color.
 */
export interface Phase4SourceImageRef {
  /** Local file path (fixtures) or https URL (future real-corpus use). */
  ref: string;
  /** How this image was actually obtained, for provenance-only reporting. */
  origin: 'local-fixture';
}

export interface Phase4ProductInput {
  productRef: string;
  retailer: string | null;
  variantId: string | null;
  /**
   * True only when `variantId` came from a genuinely authoritative,
   * canonical source (not this app's real contract today — see
   * docs/vto-phase4-source-authority.md — but modeled so the pipeline has
   * a defined, tested behavior for the day one exists). Defaults to false
   * everywhere real data is used; only this lane's own synthetic
   * "variant product" fixture sets it true, to exercise the
   * legitimately-distinct-variants path deliberately.
   */
  variantAuthoritative: boolean;
  /** K Scan canonical category string, as Commerce produces it today. */
  category: string;
  title: string | null;
  brand: string | null;
  images: Phase4SourceImageRef[];
  evidenceClass: EvidenceClass;
}

export type EvidenceClass =
  | 'SYNTHETIC'
  | 'AUTHORIZED_FIXTURE'
  | 'READ_ONLY_REAL_PRODUCT'
  | 'COMMITTED_REAL_PRODUCT_FIXTURE';

export type ShotClass = 'EASY' | 'MEDIUM' | 'HARD' | 'UNSUPPORTED';

export interface ShotClassificationResult {
  shotClass: ShotClass;
  confidence: number;
  evidence: Record<string, number | string | boolean>;
}

export type RejectionCode =
  | 'UNSUPPORTED_CATEGORY'
  | 'SOURCE_INVALID'
  | 'SOURCE_TOO_SMALL'
  | 'MULTIPLE_GARMENTS'
  | 'GARMENT_NOT_PRIMARY'
  | 'CROP_INCOMPLETE'
  | 'OCCLUSION_TOO_HIGH'
  | 'EXTRACTION_UNRELIABLE'
  | 'ANCHORS_INCOMPLETE'
  | 'GEOMETRY_INVALID'
  | 'PRODUCT_FIDELITY_FAILED'
  | 'PATTERN_UNRECOVERABLE'
  | 'VARIANT_AMBIGUOUS';

export const TERMINAL_REJECTION_CODES: readonly RejectionCode[] = [
  'UNSUPPORTED_CATEGORY',
  'MULTIPLE_GARMENTS',
  'GARMENT_NOT_PRIMARY',
  'CROP_INCOMPLETE',
  'OCCLUSION_TOO_HIGH',
  'EXTRACTION_UNRELIABLE',
  'ANCHORS_INCOMPLETE',
  'GEOMETRY_INVALID',
  'PRODUCT_FIDELITY_FAILED',
  'PATTERN_UNRECOVERABLE',
  'VARIANT_AMBIGUOUS',
];

export interface Rejection {
  code: RejectionCode;
  message: string;
  stage: PipelineStage;
}

export type PipelineStage =
  | 'source_acquisition'
  | 'classification'
  | 'extraction'
  | 'canonicalization'
  | 'anchor_generation'
  | 'geometry_generation'
  | 'qa'
  | 'bundle_writing';

export const PIPELINE_STAGES: readonly PipelineStage[] = [
  'source_acquisition',
  'classification',
  'extraction',
  'canonicalization',
  'anchor_generation',
  'geometry_generation',
  'qa',
  'bundle_writing',
];

export interface StageTiming {
  stage: PipelineStage;
  durationMs: number;
  retryCount: number;
  result: 'ok' | 'rejected' | 'error';
}

/** Reference-truth-aware metric: computable only when a ground truth exists. */
export type MetricResult =
  | { computable: true; referenceClass: 'REFERENCE_AVAILABLE'; value: number; detail: string }
  | { computable: false; referenceClass: 'NO_REFERENCE'; detail: string };

export interface ProductFidelityQaResult {
  silhouette: {
    fillRatio: number;
    compactness: number;
    maskToBboxAreaNote: string;
  };
  color: MetricResult;
  logo: MetricResult;
  pattern: MetricResult;
  passed: boolean;
  failureReasons: string[];
}

export interface ConfidenceComponents {
  shotClassification: number;
  segmentation: number;
  anchorCompleteness: number;
  geometryValidity: number;
  sourceQuality: number;
  productFidelity: number;
}

export interface EligibilityResult {
  live2d: boolean;
  live3d: false;
  reason: RejectionCode | null;
}

export type AssetStatus = 'CURRENT' | 'STALE' | 'INVALID' | 'REJECTED';

export interface CorrectionLogRef {
  correctionId: string;
  type: string;
  appliedAt: string;
}

export interface Phase4AssetManifest {
  assetId: string;
  pipelineVersion: string;
  contractVersion: string;
  assetVersion: string;
  generatedAt: string;
  evidenceClass: EvidenceClass;

  productIdentity: {
    productRef: string;
    retailer: string | null;
    variantId: string | null;
    category: string;
  };

  source: {
    ref: string;
    sha256: string;
    width: number;
    height: number;
    format: 'png' | 'jpeg';
  };

  shotClassification: ShotClassificationResult;
  confidenceComponents: ConfidenceComponents;
  qa: ProductFidelityQaResult | null;
  eligibility: EligibilityResult;
  status: AssetStatus;
  rejection: Rejection | null;
  ksgarment: KsgarmentManifest | null;
  anchorEvidence: { id: string; confidence: number }[];
  correctionHistory: CorrectionLogRef[];
  stageTimings: StageTiming[];
}

export interface AnchorCandidate {
  point: GarmentControlPoint;
  confidence: number;
}
