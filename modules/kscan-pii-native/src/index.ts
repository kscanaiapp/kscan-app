import KScanPiiNativeModule from './KScanPiiNativeModule';
import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativePrivacyStatus,
  NativePrivacyErrorCode,
  NativeFaceRegion,
} from './KScanPiiNative.types';

export type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativePrivacyStatus,
  NativePrivacyErrorCode,
  NativeFaceRegion,
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
