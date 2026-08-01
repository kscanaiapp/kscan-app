import KScanPiiNativeModule from './KScanPiiNativeModule';
import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativePrivacyStatus,
  NativePrivacyErrorCode,
  NativeFaceRegion,
  NativeExtractionCapabilities,
  NativePersonDetectionInput,
  NativePersonDetectionResult,
  NativeDetectedPerson,
  NativeBodyLandmark,
  NativeBodyLandmarkType,
  NativeNormalizedRect,
  NativeExtractionStatus,
} from './KScanPiiNative.types';

export type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativePrivacyStatus,
  NativePrivacyErrorCode,
  NativeFaceRegion,
  NativeExtractionCapabilities,
  NativePersonDetectionInput,
  NativePersonDetectionResult,
  NativeDetectedPerson,
  NativeBodyLandmark,
  NativeBodyLandmarkType,
  NativeNormalizedRect,
  NativeExtractionStatus,
};

export { KScanPiiNativeModule };

export const SANITIZER_VERSION = 'native-face-mask-poc-1.0.0';
export const ACCEPTED_URI_SCHEMES = ['file'] as const;
export const ACCEPTED_MIME_TYPES = ['image/jpeg', 'image/png'] as const;
export const OUTPUT_MIME_TYPE = 'image/png' as const;
export const MAX_WIDTH = 4096;
export const MAX_HEIGHT = 4096;
export const MAX_PIXELS = 16_777_216;
export const DEFAULT_PADDING_RATIO = 0.15;
export const MIN_PADDING_RATIO = 0.0;
export const MAX_PADDING_RATIO = 0.5;
export const IOU_DEDUPLICATION_THRESHOLD = 0.5;
export const CHECKSUM_ALGORITHM = 'fnv1a-dual-lane-64';

export function getPrivacyCapabilities(): Promise<NativePrivacyCapabilities> {
  return KScanPiiNativeModule.getPrivacyCapabilities();
}

export function detectAndMaskFaces(
  input: NativeFaceMaskInput,
): Promise<NativeFaceMaskResult> {
  return KScanPiiNativeModule.detectAndMaskFaces(input);
}

export function cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult> {
  return KScanPiiNativeModule.cleanupSanitizedImage(uri);
}

// ── Person / body-region detection (Build 2.5 Step 3) ────────────────────────

export const EXTRACTOR_VERSION = 'native-person-regions-1.0.0';

/**
 * The joint subset both platforms report. Exported so the extraction adapter
 * and the parity test can assert against ONE list rather than two copies that
 * can drift apart.
 */
export const SUPPORTED_BODY_LANDMARKS = [
  'nose',
  'left_shoulder',
  'right_shoulder',
  'left_hip',
  'right_hip',
  'left_knee',
  'right_knee',
  'left_ankle',
  'right_ankle',
] as const;

export function getExtractionCapabilities(): Promise<NativeExtractionCapabilities> {
  return KScanPiiNativeModule.getExtractionCapabilities();
}

/**
 * Detect people and their body landmarks in an app-owned image.
 *
 * READ ONLY. Unlike detectAndMaskFaces this produces no derivative file, so
 * there is nothing to clean up afterwards and no sanitized URI to track.
 */
export function detectPersonRegions(
  input: NativePersonDetectionInput,
): Promise<NativePersonDetectionResult> {
  return KScanPiiNativeModule.detectPersonRegions(input);
}
