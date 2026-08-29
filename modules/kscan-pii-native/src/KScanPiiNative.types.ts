/**
 * Cross-platform native face-masking privacy engine public contract.
 *
 * This contract is intentionally source-agnostic. The module is inactive in
 * this phase and must not be imported by current application screens.
 */

export interface NativeFaceMaskInput {
  imageUri: string;
  paddingRatio?: number;
}

export type NativePrivacyStatus =
  | 'success'
  | 'no_faces'
  | 'unsupported'
  | 'failed';

export type NativePrivacyErrorCode =
  | 'INVALID_INPUT'
  | 'INVALID_URI'
  | 'UNSUPPORTED_SCHEME'
  | 'UNSUPPORTED_FORMAT'
  | 'IMAGE_TOO_LARGE'
  | 'DECODE_FAILED'
  | 'ORIENTATION_FAILED'
  | 'DETECTOR_UNAVAILABLE'
  | 'DETECTION_FAILED'
  | 'INVALID_REGION'
  | 'MASKING_FAILED'
  | 'ENCODING_FAILED'
  | 'VERIFICATION_FAILED'
  | 'CLEANUP_REJECTED'
  | 'CLEANUP_FAILED'
  | 'INTERNAL_ERROR';

export interface NativeFaceRegion {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NativeFaceMaskResult {
  status: NativePrivacyStatus;
  platform: 'android' | 'ios';

  detectorImplementation:
    | 'mlkit_bundled'
    | 'apple_vision'
    | 'unavailable';

  detectorVersion: string;
  sanitizerVersion: string;

  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;

  facesDetected: number;
  facesAccepted: number;
  facesMasked: number;
  regionsChanged: number;
  regionsAlreadyRedacted: number;

  pixelsChanged: boolean;
  sanitizedUri?: string;

  inputChecksum?: string;
  outputChecksum?: string;
  checksumAlgorithm?: string;

  detectionDurationMs?: number;
  maskingDurationMs?: number;
  encodingDurationMs?: number;
  verificationDurationMs?: number;
  totalDurationMs?: number;

  warnings: string[];
  errorCode?: NativePrivacyErrorCode;
  failureReason?: string;
}

export interface NativePrivacyCapabilities {
  supported: boolean;
  platform: 'android' | 'ios';

  detectorImplementation:
    | 'mlkit_bundled'
    | 'apple_vision'
    | 'unavailable';

  acceptedUriSchemes: string[];
  acceptedMimeTypes: string[];
  outputMimeType: 'image/png';

  maxWidth: number;
  maxHeight: number;
  maxPixels: number;

  sanitizerVersion: string;
}

export interface NativeCleanupResult {
  deleted: boolean;
  rejected: boolean;
  warnings: string[];
}

// ── Person / body-region detection (Build 2.5 Step 3) ────────────────────────
//
// A SECOND, SEPARATE CAPABILITY on the same module. It shares the module's
// decoder, cache manager and orientation handling; it shares nothing else with
// face masking. In particular it is NON-DESTRUCTIVE: it reads an image and
// returns geometry. It never writes a redacted derivative and never modifies
// the input.
//
// WHAT IT IS NOT: a garment segmenter. Neither ML Kit nor Apple Vision knows
// what a jacket is. This returns a person box and body joints; the caller
// derives anatomical bands from them. See services/mirror/mirrorGarmentRegions.ts
// for the honesty contract that governs how far those bands may be trusted.

/** Normalized to the input image, 0..1. Never pixels — the caller's crop source
 *  is a different, larger image than the one detection ran on. */
export interface NativeNormalizedRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The joint subset BOTH runtimes report reliably.
 *
 * ML Kit Pose Detection produces 33 landmarks; Apple Vision's body-pose request
 * produces 19. This is the intersection, deliberately — a joint only one
 * platform has would place a region edge differently on each, and the two
 * platforms' crops would silently diverge.
 */
export type NativeBodyLandmarkType =
  | 'nose'
  | 'left_shoulder'
  | 'right_shoulder'
  | 'left_hip'
  | 'right_hip'
  | 'left_knee'
  | 'right_knee'
  | 'left_ankle'
  | 'right_ankle';

export interface NativeBodyLandmark {
  type: NativeBodyLandmarkType;
  x: number;
  y: number;
  /** 0..1. Both platforms' native scales are clamped into this range. */
  confidence: number;
}

export interface NativeDetectedPerson {
  /**
   * Best available BODY extent for this person. Used to clamp derived regions.
   *
   * iOS: the Vision human rectangle. Android: a box computed from the pose
   * landmarks when this is the posed subject, and the face box grown by a
   * conventional head-to-height ratio otherwise.
   */
  bounds: NativeNormalizedRect;
  /**
   * LIKE-FOR-LIKE extent used only to rank candidates against each other.
   *
   * WHY THIS FIELD EXISTS, and why `bounds` cannot do its job: ML Kit pose
   * detection returns exactly ONE subject per image, so Android's multi-person
   * signal has to come from the face detector the module already bundles.
   * Ranking a pose-derived full-body box against other people's face boxes
   * would make the posed subject win every time — including when a second
   * person is standing right beside them, which is precisely the case that must
   * ask the user. So ranking uses one consistent kind of region per platform:
   * face boxes on Android, human rectangles on iOS.
   */
  rankingExtent: NativeNormalizedRect;
  confidence: number;
  landmarks: NativeBodyLandmark[];
  /**
   * Fraction of `bounds` filled by the person segmentation mask, 0..1.
   *
   * `null` on Android: ML Kit pose detection produces no mask, and no
   * Play-Services-delivered segmenter is authorized because it would require a
   * first-run model download that breaks the offline requirement. The caller
   * treats absence as neutral — the value may only ever demote a region's
   * confidence, never promote one — so the platforms stay in parity.
   */
  maskCoverage: number | null;
}

export type NativeExtractionStatus = 'success' | 'no_person' | 'unsupported' | 'failed';

export interface NativePersonDetectionInput {
  imageUri: string;
}

export interface NativePersonDetectionResult {
  status: NativeExtractionStatus;
  platform: 'android' | 'ios';
  detectorImplementation: 'mlkit_pose' | 'apple_vision' | 'unavailable';
  detectorVersion: string;
  extractorVersion: string;

  inputWidth?: number;
  inputHeight?: number;

  persons: NativeDetectedPerson[];

  detectionDurationMs?: number;
  totalDurationMs?: number;

  warnings: string[];
  /** Reuses the module's existing bounded code vocabulary — no second one. */
  errorCode?: NativePrivacyErrorCode;
  failureReason?: string;
}

export interface NativeExtractionCapabilities {
  personDetectionSupported: boolean;
  platform: 'android' | 'ios';
  detectorImplementation: 'mlkit_pose' | 'apple_vision' | 'unavailable';
  /** True only where the platform supplies a person mask. Android: false. */
  segmentationMaskSupported: boolean;
  supportedLandmarks: NativeBodyLandmarkType[];
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  extractorVersion: string;
}

// ── License-plate screening (Build 34 Track B, Phase B2A) ────────────────────
//
// Mirrors the face contract field-for-field, with plate counters instead of
// face counters. Kept as a SEPARATE result type on purpose: reporting masked
// plates through `facesDetected` would make the privacy engine misreport what
// it actually did, and the two capabilities are claimed independently
// downstream (faceMaskApplied vs plateMaskApplied).
//
// REGION GEOMETRY ONLY. The detector locates text-shaped regions and never
// produces, returns, logs or persists a single recognized character —
// `ocrPerformed` is part of the contract so that claim is auditable rather
// than merely documented.

export interface NativePlateMaskInput {
  imageUri: string;
  paddingRatio?: number;
}

export type NativePlateStatus =
  | 'success'
  | 'no_plates'
  | 'unsupported'
  | 'failed';

export interface NativePlateMaskResult {
  status: NativePlateStatus;
  platform: 'android' | 'ios';

  detectorImplementation:
    | 'mlkit_text_bundled'
    | 'vision_text_rectangles'
    | 'unavailable';

  detectorVersion: string;
  sanitizerVersion: string;

  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;

  platesDetected: number;
  platesAccepted: number;
  platesMasked: number;
  regionsChanged: number;
  regionsAlreadyRedacted: number;

  pixelsChanged: boolean;
  sanitizedUri?: string;

  /** Always false. No character recognition is performed on any path. */
  ocrPerformed: boolean;

  inputChecksum?: string;
  outputChecksum?: string;
  checksumAlgorithm?: string;

  detectionDurationMs?: number;
  maskingDurationMs?: number;
  encodingDurationMs?: number;
  verificationDurationMs?: number;
  totalDurationMs?: number;

  warnings: string[];
  /** Reuses the module's existing bounded code vocabulary — no second one. */
  errorCode?: NativePrivacyErrorCode;
  failureReason?: string;
}

export interface NativePlateCapabilities {
  supported: boolean;
  platform: 'android' | 'ios';
  detectorImplementation:
    | 'mlkit_text_bundled'
    | 'vision_text_rectangles'
    | 'unavailable';
  detectorVersion: string;
  sanitizerVersion: string;
  /** Always false; asserted by the parity test, not just documented. */
  ocrPerformed: boolean;
}
