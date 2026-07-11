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
