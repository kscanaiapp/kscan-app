// Mirror Selfie local extraction contract (Build 2.5 Step 3).
//
// WHAT THIS LAYER IS: an on-device pipeline that turns ONE mirror selfie into
// several garment-FOCUSED crop files, plus the local review state a user needs
// to accept or reject each one. It ends at a typed handoff object.
//
// WHAT THIS LAYER IS NOT, and must never become:
//   - a candidate creator (Step 4 owns stageMirrorSelfieGarmentCrops)
//   - a classifier (identify_for_closet owns garment identity)
//   - a Closet writer, a Recent Scan writer, or a commerce caller
//   - a network client of any kind
//
// ── THE HONESTY CONTRACT ────────────────────────────────────────────────────
//
// Extraction is GEOMETRIC, authorized as such by owner decision. It derives
// regions from a person bounding box, body landmarks and (where the platform
// supplies one) a person segmentation mask. It is NOT fashion segmentation.
//
// It CAN separate: head-down-to-hip, hip-down-to-ankle, whole figure, feet.
// It CANNOT separate: a jacket from the shirt underneath it, a coat from a
// sweater, any layered garment, an accessory, or a true garment contour.
//
// Therefore a region is named for the part of the BODY it covers, never for a
// garment. `upper_body` is not "shirt". `lower_body` is not "pants". A crop is
// NOT an assertion that exactly one garment is inside it — see
// `MirrorRegionConfidenceBucket` below, whose whole purpose is to carry that
// uncertainty forward to the user and then to Step 4.

/** Lifecycle of one local extraction session. Linear except retry and cancel. */
export type MirrorExtractionSessionStatus =
  | 'selecting_source'
  | 'validating'
  | 'resolving_person'
  | 'extracting_garments'
  | 'generating_crops'
  | 'reviewing_crops'
  | 'completed'
  | 'cancelled'
  | 'failed';

/**
 * Body regions BOTH platforms can produce consistently.
 *
 * Deliberately anatomical. Adding a garment word to this union — `jacket`,
 * `dress`, `shoes` — would be a classification claim this layer has no
 * evidence for, and would pre-empt identify_for_closet in Step 4.
 */
export type MirrorRegionClass =
  | 'upper_body'
  | 'lower_body'
  | 'full_length'
  | 'left_foot'
  | 'right_foot';

/**
 * Deterministic emission order. Region order in every result is this order
 * first, then descending area, then x, then y — so the same image always
 * produces the same sequence, which is what makes cropKey stable.
 */
export const MIRROR_REGION_CLASS_ORDER: readonly MirrorRegionClass[] = [
  'upper_body',
  'lower_body',
  'full_length',
  'left_foot',
  'right_foot',
] as const;

/**
 * Local, non-persisted confidence in the REGION GEOMETRY. Never a confidence
 * that the crop contains exactly one garment — no geometric method can know
 * that.
 *
 *   high   — the landmarks defining this region were all above threshold and
 *            the region passed every crop-quality check. The crop is a good
 *            picture of that part of the body. It may STILL contain a jacket
 *            over a shirt.
 *   review — something is uncertain: a defining landmark was weak, the mask
 *            coverage was poor, or the region is `full_length`, which by
 *            construction spans more than one garment. The user is asked to
 *            look before it goes anywhere.
 *   low     — retained for display and selection but flagged; the geometry is
 *            marginal.
 */
export type MirrorRegionConfidenceBucket = 'high' | 'review' | 'low';

/** `full_length` always spans multiple garments. It can never be `high`. */
export const MIRROR_ALWAYS_REVIEW_REGION_CLASSES: readonly MirrorRegionClass[] = [
  'full_length',
] as const;

/** Normalized 0..1 rect in the orientation-corrected image's coordinate space. */
export type NormalizedBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

/**
 * Bounded outcome codes. Every one is a recoverable USER outcome or a bounded
 * system condition — never a native exception string, never a filesystem path.
 */
export type MirrorExtractionErrorCode =
  | 'mirror_source_unreadable'
  | 'mirror_source_unsupported'
  | 'mirror_source_dimensions_invalid'
  | 'mirror_source_too_small'
  | 'mirror_source_too_large'
  | 'mirror_no_person_detected'
  | 'mirror_multiple_people_ambiguous'
  | 'mirror_no_garments_detected'
  | 'mirror_extraction_unsupported'
  | 'mirror_extraction_cancelled'
  | 'mirror_extraction_failed'
  | 'mirror_session_storage_failed'
  | 'mirror_actor_changed';

export const MIRROR_EXTRACTION_ERROR_CODES: readonly MirrorExtractionErrorCode[] = [
  'mirror_source_unreadable',
  'mirror_source_unsupported',
  'mirror_source_dimensions_invalid',
  'mirror_source_too_small',
  'mirror_source_too_large',
  'mirror_no_person_detected',
  'mirror_multiple_people_ambiguous',
  'mirror_no_garments_detected',
  'mirror_extraction_unsupported',
  'mirror_extraction_cancelled',
  'mirror_extraction_failed',
  'mirror_session_storage_failed',
  'mirror_actor_changed',
] as const;

/**
 * The three outcomes §9 of the owner decision requires be RECOVERABLE — the
 * user is offered another photo or another person, not an error screen.
 */
export const MIRROR_RECOVERABLE_ERROR_CODES: readonly MirrorExtractionErrorCode[] = [
  'mirror_no_person_detected',
  'mirror_multiple_people_ambiguous',
  'mirror_no_garments_detected',
] as const;

export function isRecoverableMirrorError(code: unknown): boolean {
  return (
    typeof code === 'string' &&
    (MIRROR_RECOVERABLE_ERROR_CODES as readonly string[]).includes(code)
  );
}

// ── Session identity ────────────────────────────────────────────────────────

/**
 * Session id shape, IDENTICAL to the Step 1 staging contract in
 * services/closetMirrorStaging.ts. Not re-derived loosely here: Step 4 passes
 * this exact string to stageMirrorSelfieGarmentCrops, which re-validates it
 * against the same pattern and rejects anything else.
 *
 * The pattern cannot express a `file://` URI, a path separator, or free text,
 * so a session id structurally cannot carry PII or a parent-selfie reference.
 */
export const MIRROR_SESSION_OR_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidMirrorSessionId(value: unknown): value is string {
  return typeof value === 'string' && MIRROR_SESSION_OR_KEY_PATTERN.test(value);
}

export function isValidMirrorCropKey(value: unknown): value is string {
  return typeof value === 'string' && MIRROR_SESSION_OR_KEY_PATTERN.test(value);
}

// ── Media contract (all values sourced from the existing pipeline) ──────────

/**
 * Normalized working-copy ceiling. 1440 is the repository's committed-Closet
 * and candidate width (services/closetCandidateMedia.js). Crops are cut from
 * THIS image, so anything smaller would downgrade every promoted item.
 */
export const MIRROR_NORMALIZED_SOURCE_MAX_EDGE = 1440;

/**
 * Inference-image ceiling. 896 is the repository's existing model-input long
 * edge (services/imageUtils.js#compressForUpload, services/privacyImageUpload
 * .ts). Reused rather than invented, per the owner's media-contract decision.
 *
 * Detection runs on THIS image; crops are cut from the 1440 normalized source.
 * Both share an aspect ratio, so normalized 0..1 coordinates map between them
 * without a second correction step.
 */
export const MIRROR_INFERENCE_MAX_EDGE = 896;

/** Candidate/Closet-authoritative encode settings. Not re-derived. */
export const MIRROR_CROP_FORMAT = 'jpeg' as const;
export const MIRROR_CROP_QUALITY = 0.9;
export const MIRROR_CROP_MAX_EDGE = MIRROR_NORMALIZED_SOURCE_MAX_EDGE;

/** Pre-decode source ceiling, identical to MAX_SOURCE_IMAGE_BYTES. */
export const MIRROR_MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/**
 * Smallest source that can yield a usable garment crop.
 *
 * NOT a quality threshold invented for its own sake: below this, a body region
 * occupying a third of the frame produces a crop under ~100px on its long edge,
 * which cannot survive the 896px model input Step 4 eventually feeds. Stated
 * as a floor on the SOURCE so the failure is reported at intake, where the user
 * can pick a better photo, rather than after a full extraction run.
 */
export const MIRROR_MIN_SOURCE_EDGE = 320;

/**
 * Geometric padding around a derived region, as a fraction of that region's
 * longer edge. A margin, not a quality threshold — it exists so a crop does not
 * shave the shoulder seam or the hem. Clamped to the image bounds.
 */
export const MIRROR_REGION_PADDING_RATIO = 0.08;

/**
 * Intersection-over-union above which two regions are treated as the same
 * region. Reuses the value already governing region dedup in the native module
 * (modules/kscan-pii-native/src/index.ts#IOU_DEDUPLICATION_THRESHOLD).
 */
export const MIRROR_REGION_IOU_THRESHOLD = 0.5;

/**
 * A region smaller than this fraction of the source frame is not a garment
 * crop, it is a scrap. Applied AFTER padding and clamping.
 */
export const MIRROR_MIN_REGION_AREA_RATIO = 0.004;

// ── Person resolution thresholds ────────────────────────────────────────────

/** Below this, a detection is not a person for our purposes. */
export const MIRROR_PERSON_CONFIDENCE_THRESHOLD = 0.5;

/**
 * A landmark below this does not get to define a region edge. Regions that
 * depend on one are either dropped or demoted to `review`.
 */
export const MIRROR_LANDMARK_CONFIDENCE_THRESHOLD = 0.4;

/**
 * Dominance rule. The largest person must cover at least this multiple of the
 * runner-up's area to be selected WITHOUT asking the user.
 *
 * 1.6 is chosen so that two people standing side by side at similar depth —
 * the exact case where guessing is wrong and annoying — always asks. A
 * background bystander is typically well under half the subject's area and is
 * resolved silently.
 */
export const MIRROR_PERSON_DOMINANCE_RATIO = 1.6;

// ── Session state ───────────────────────────────────────────────────────────

export type MirrorSourceType = 'camera' | 'gallery';

/**
 * One locally-derived crop, as held in review state.
 *
 * `cropUri` and `cropKey` are the ONLY two fields that cross into Step 4 (see
 * MirrorGarmentCropInput). Everything else is presentation state and is
 * deliberately dropped at the boundary.
 */
export type LocalMirrorGarmentCrop = {
  cropUri: string;
  cropKey: string;
  sourceImageIndex: number;
  regionClass: MirrorRegionClass;
  localBounds?: NormalizedBounds;
  localConfidenceBucket: MirrorRegionConfidenceBucket;
  cropWidth: number;
  cropHeight: number;
  selected: boolean;
};

/** Exactly the Step 1 staging input shape. Re-declared, never widened. */
export type MirrorGarmentCropInput = {
  cropUri: string;
  cropKey: string;
};

/**
 * THE Step 3 → Step 4 handoff. Passed explicitly as a value.
 *
 * There is no filesystem discovery, no module-level mutable singleton and no
 * navigation query string carrying these URIs — a query string would put a
 * file path in a navigation log, which is exactly what the privacy contract
 * forbids.
 */
export type MirrorExtractionSelection = {
  extractionSessionId: string;
  crops: MirrorGarmentCropInput[];
};

export type MirrorExtractionProgress = {
  status: MirrorExtractionSessionStatus;
  /** 0..1, coarse and monotonic. Never a duration, never a byte count. */
  fraction: number;
};

/**
 * Local session state. Holds URIs because it lives in memory on the device and
 * never leaves it. Nothing here is persisted to a database and nothing here is
 * ever passed to telemetry.
 */
export type MirrorExtractionSession = {
  extractionSessionId: string;
  status: MirrorExtractionSessionStatus;
  sourceType: MirrorSourceType | null;
  /** App-owned normalized copy. Deleted once crop selection is accepted. */
  normalizedSourceUri: string | null;
  normalizedWidth: number;
  normalizedHeight: number;
  sourceImageIndex: number;
  crops: LocalMirrorGarmentCrop[];
  /** Candidate people awaiting explicit user choice. */
  pendingPersonChoices: NormalizedBounds[] | null;
  errorCode: MirrorExtractionErrorCode | null;
  createdAtMs: number;
  cleanedUp: boolean;
};

/**
 * Approved-crop TTL. Deliberately the SAME constant the candidate system
 * already uses — importing it rather than restating 7 days means a future
 * change to the candidate clock cannot silently desynchronize Mirror.
 *
 * NOTE THE ASYMMETRY, which is the point of the owner's retention decision:
 * this governs APPROVED CROPS only. The normalized selfie is deleted as soon as
 * crop selection is accepted and never lives this long.
 */
export { CLOSET_CANDIDATE_TTL_MS as MIRROR_SESSION_MAX_TTL_MS } from './closetCandidate';
