// Fail-closed privacy boundary for photo-library uploads into Elise.
// Metadata-only re-encoding is not pixel masking. Until a cross-platform face
// and license-plate detector/masker is integrated and proven, preparation is
// unavailable and no selected image may proceed to remote analysis.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

export const PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE =
  'Upload is unavailable until on-device face and license-plate masking can be verified.';

export function isPrivateImageUploadAvailable(): boolean {
  return false;
}

export type PrivacyPrepareResult = {
  sanitizedUri: string;
  width?: number;
  height?: number;
  policy: {
    mode: string;
    sanitizerVersion: string;
    faceDetectionAvailable: boolean;
    faceMaskApplied: boolean;
    plateDetectionAvailable: boolean;
    plateMaskApplied: boolean;
    metadataStripped: boolean;
  };
};

export class PrivacyPrepareError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyPrepareError';
  }
}

function isLocalImageUri(uri: string): boolean {
  return typeof uri === 'string' && (uri.startsWith('file://') || uri.startsWith('content://'));
}

/**
 * Validate the local input, then fail closed while required masking is absent.
 */
export async function prepareImageForPrivacyUpload(
  inputUri: string,
  options?: { maxDimension?: number; quality?: number },
): Promise<PrivacyPrepareResult> {
  if (!inputUri || typeof inputUri !== 'string') {
    throw new PrivacyPrepareError('No image selected.');
  }
  if (!isLocalImageUri(inputUri)) {
    throw new PrivacyPrepareError('Selected image must be on this device.');
  }

  void options;
  throw new PrivacyPrepareError(PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE);
}

/**
 * Delete a temporary sanitized derivative created by this service.
 * Safe to call on missing/already-deleted files.
 */
export async function cleanupSanitizedImage(uri: string | undefined | null): Promise<void> {
  if (!uri) return;
  try {
    await FileSystem.deleteAsync(uri, { idempotent: true });
  } catch {
    // Best-effort cleanup; never crash the user flow.
  }
}

/**
 * Compress the sanitized derivative to base64 for the scan-identify edge function.
 * This base64 is transient and must never be persisted or sent to StyleChat generation.
 */
export async function compressSanitizedImageForAnalysis(
  sanitizedUri: string,
  options?: { width?: number; quality?: number },
): Promise<{ base64: string; uri: string }> {
  const result = await ImageManipulator.manipulateAsync(
    sanitizedUri,
    [{ resize: { width: options?.width ?? 896 } }],
    {
      compress: options?.quality ?? 0.75,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    },
  );
  if (!result.base64) {
    throw new PrivacyPrepareError('Could not compress the image for analysis.');
  }
  return { base64: `data:image/jpeg;base64,${result.base64}`, uri: result.uri };
}
