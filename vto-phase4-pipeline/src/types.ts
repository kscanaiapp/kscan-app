import type { ConfidenceExplanation } from './confidenceExplain';
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
  /** Local file path (fixtures) or an https URL (real-corpus use — Phase 4.1). */
  ref: string;
  /**
   * How this image was actually obtained, for provenance-only reporting.
   * `https-fetch` sources are validated against `remoteMediaGuard.ts` (a
   * faithful, cited port of `supabase/functions/_shared/net/
   * safeRemoteMedia.ts` — see that module's header) before any bytes are
   * requested; see `docs/vto-phase4-corpus-discovery.md` §4 for why this
   * could not simply be imported across the Deno/Node boundary.
   */
  origin: 'local-fixture' | 'https-fetch';
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

/**
 * Gate E certification repair (GATE-E-INT-002, Phase 4.1 addendum §10-§13):
 * an engineering-observable failure to even PRODUCE a manifest, distinct
 * from a `Rejection` (a real, evaluated catalog-quality verdict). A source
 * that cannot be fetched, cannot be decoded, or that trips an unhandled
 * exception must terminate as `SYSTEM_ERROR:<code>` — never silently as
 * `REJECTED:EXTRACTION_UNRELIABLE` and never as `LIVE2D_ELIGIBLE` (task
 * section 7 of the addendum). Deliberately four codes, not "dozens":
 *
 *  - SOURCE_FETCH_FAILED: the source bytes could not be obtained at all
 *    (network failure, 4xx/5xx, blocked by the SSRF guard, missing local
 *    fixture, unsupported origin).
 *  - DECODE_FAILED: bytes were obtained but could not be turned into
 *    pixels — corrupt/truncated/zero-byte input, an unrecognized format
 *    with no matching signature at all, or a resource-safety refusal
 *    (oversized dimensions/pixel count — addendum §9/A5). Decode-stage
 *    resource limits are folded in here rather than given their own code,
 *    per the addendum's "do not invent dozens of unnecessary error codes".
 *  - UNSUPPORTED_IMAGE_FORMAT: bytes were obtained and the format is
 *    positively IDENTIFIED (a real signature matched, e.g. AVIF's `ftyp`
 *    box) but this pipeline deliberately does not decode it — addendum
 *    §A3. Distinct from DECODE_FAILED because the format is known, not
 *    corrupt; `format` carries which one.
 *  - PIPELINE_EXCEPTION: any other unexpected throw once decode has
 *    already succeeded (a defect in classification/segmentation/
 *    canonicalization/anchors/QA/persistence) — the batch-isolation
 *    catch-all (addendum §11).
 *  - INVALID_INPUT: the product RECORD itself is malformed before any
 *    image is even considered (e.g. no productRef).
 */
export type SystemErrorCode =
  | 'SOURCE_FETCH_FAILED'
  | 'DECODE_FAILED'
  | 'UNSUPPORTED_IMAGE_FORMAT'
  | 'PIPELINE_EXCEPTION'
  | 'INVALID_INPUT';

export interface SystemError {
  code: SystemErrorCode;
  /** Sanitized diagnostic only (task §13 of the addendum) — never raw image bytes, base64, or a full provider response. */
  message: string;
  stage: PipelineStage;
  /** Populated only for UNSUPPORTED_IMAGE_FORMAT. */
  format?: string;
}

/**
 * Source-adequacy diagnostic (Phase 4.1 addendum §A8-§A9) — deliberately a
 * SEPARATE axis from `EligibilityResult`/`Rejection`/`SystemError`. A
 * garment can be extracted and canonicalized correctly by a fully-working
 * pipeline and still originate from a source photo whose texture
 * resolution is visibly inadequate at torso scale; that is a corpus/source
 * limitation, not a pipeline defect, and reporting it as a segmentation or
 * pipeline failure would misattribute the bottleneck (addendum §A19).
 *
 * The thresholds below are an explicitly PROVISIONAL diagnostic starting
 * point (same posture as `ELIGIBILITY_CONFIDENCE_THRESHOLD` in
 * eligibility.ts) — see `sourceAdequacy.ts`. They are never used to gate
 * eligibility, rejection, or system-error classification.
 */
export type SourceAdequacyClass = 'ADEQUATE' | 'QUESTIONABLE' | 'INADEQUATE' | 'UNKNOWN';

export interface SourceAdequacyEvidence {
  classification: SourceAdequacyClass;
  sourceWidth: number;
  sourceHeight: number;
  shortSidePx: number;
  longSidePx: number;
  /** Post-crop garment-region dimensions, when a bounding box was measurable (i.e. segmentation succeeded). Null otherwise -> classification UNKNOWN. */
  garmentBoundingWidthPx: number | null;
  garmentBoundingHeightPx: number | null;
  /** garmentBounding area / source area, when measurable. */
  garmentOccupancyRatio: number | null;
  reason: string;
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
    format: 'png' | 'jpeg' | 'webp';
  };

  shotClassification: ShotClassificationResult;
  confidenceComponents: ConfidenceComponents;
  /**
   * Phase 4.2 §22-§23: which component(s) held the minimum, what each one
   * measured, and whether any were malformed. Present on EVERY manifest,
   * accepted or rejected — a confidence decision that cannot be attributed
   * is exactly what §22 forbids.
   */
  confidenceExplanation: ConfidenceExplanation;
  qa: ProductFidelityQaResult | null;
  eligibility: EligibilityResult;
  status: AssetStatus;
  rejection: Rejection | null;
  ksgarment: KsgarmentManifest | null;
  anchorEvidence: { id: string; confidence: number }[];
  correctionHistory: CorrectionLogRef[];
  stageTimings: StageTiming[];
  /** Diagnostic only — see `SourceAdequacyEvidence`. Never used to gate eligibility. */
  sourceAdequacy: SourceAdequacyEvidence;
}

export interface AnchorCandidate {
  point: GarmentControlPoint;
  confidence: number;
}
