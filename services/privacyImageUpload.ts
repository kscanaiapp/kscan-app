// Privacy boundary for local photo-library uploads into Scanner and Elise.
// Every accepted local image is re-encoded before analysis so source metadata
// is not transmitted. This does not claim face or license-plate masking.
//
// Prep constants match the accepted Scanner pathway in services/imageUtils.js:
// max width 896, JPEG quality 0.65.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

export const SCANNER_COMPAT_MAX_WIDTH = 896;
export const SCANNER_COMPAT_JPEG_QUALITY = 0.65;

export const PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE =
  'The selected image could not be prepared securely.';

export function isPrivateImageUploadAvailable(): boolean {
  return true;
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
 * Validate and re-encode the local input before remote analysis. Re-encoding
 * strips source metadata but intentionally does not claim pixel masking.
 * Uses the same 896 / 0.65 JPEG bounds as Scanner compressForUpload.
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

  try {
    const result = await ImageManipulator.manipulateAsync(
      inputUri,
      [{ resize: { width: options?.maxDimension ?? SCANNER_COMPAT_MAX_WIDTH } }],
      {
        compress: options?.quality ?? SCANNER_COMPAT_JPEG_QUALITY,
        format: ImageManipulator.SaveFormat.JPEG,
      },
    );
    if (!result?.uri || typeof result.uri !== 'string') {
      throw new PrivacyPrepareError(PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE);
    }
    return {
      sanitizedUri: result.uri,
      width: result.width,
      height: result.height,
      policy: {
        mode: 'metadata-stripped-reencode',
        sanitizerVersion: 'metadata-reencode-v1',
        faceDetectionAvailable: false,
        faceMaskApplied: false,
        plateDetectionAvailable: false,
        plateMaskApplied: false,
        metadataStripped: true,
      },
    };
  } catch (error) {
    if (error instanceof PrivacyPrepareError) throw error;
    throw new PrivacyPrepareError(PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE);
  }
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
 * Defaults match Scanner compressForUpload (896 / 0.65).
 */
export async function compressSanitizedImageForAnalysis(
  sanitizedUri: string,
  options?: { width?: number; quality?: number },
): Promise<{ base64: string; uri: string }> {
  const result = await ImageManipulator.manipulateAsync(
    sanitizedUri,
    [{ resize: { width: options?.width ?? SCANNER_COMPAT_MAX_WIDTH } }],
    {
      compress: options?.quality ?? SCANNER_COMPAT_JPEG_QUALITY,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: true,
    },
  );
  if (!result.base64) {
    throw new PrivacyPrepareError('Could not compress the image for analysis.');
  }
  return { base64: `data:image/jpeg;base64,${result.base64}`, uri: result.uri };
}
