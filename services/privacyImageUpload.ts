// Privacy preparation for photo-library uploads into Elise.
//
// This path performs the strongest local preparation available in the current
// Expo/native stack:
//   - validates input is a local image URI (no video / cloud placeholders)
//   - re-encodes through expo-image-manipulator to strip EXIF/metadata
//   - resizes to a fashion-analysis-friendly max dimension
//   - returns an honest privacy-policy statement
//
// It does NOT perform pixel-level face or license-plate masking because no
// supported on-device detector is available in Expo SDK 54 (expo-face-detector
// is deprecated/removed). The policy flags this honestly; masking must be added
// via a future native detector if required by a stricter deployment policy.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

const SANITIZER_VERSION = 'elise-upload-metadata-only-1.0.0';

// Max dimension for the sanitized derivative. Large enough for fashion analysis,
// small enough to keep payloads bounded.
const MAX_UPLOAD_DIMENSION = 1024;
const UPLOAD_QUALITY = 0.82;

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

function honestPolicy(metadataStripped: boolean) {
  return {
    mode: 'metadata_stripped',
    sanitizerVersion: SANITIZER_VERSION,
    faceDetectionAvailable: false,
    faceMaskApplied: false,
    plateDetectionAvailable: false,
    plateMaskApplied: false,
    metadataStripped,
  };
}

/**
 * Prepare a photo-library image for remote fashion analysis.
 *
 * Returns a sanitized derivative URI and an honest privacy policy. Throws
 * PrivacyPrepareError when the input is invalid or re-encoding fails.
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

  const maxDimension = options?.maxDimension ?? MAX_UPLOAD_DIMENSION;
  const quality = options?.quality ?? UPLOAD_QUALITY;

  try {
    // Re-encode through ImageManipulator. This strips EXIF/metadata and produces
    // a fresh JPEG derivative in the app's cache directory.
    const result = await ImageManipulator.manipulateAsync(
      inputUri,
      [{ resize: { width: maxDimension } }],
      {
        compress: quality,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: false,
      },
    );

    if (!result?.uri) {
      throw new PrivacyPrepareError('Could not prepare the image.');
    }

    return {
      sanitizedUri: result.uri,
      width: result.width,
      height: result.height,
      policy: honestPolicy(true),
    };
  } catch (err) {
    if (err instanceof PrivacyPrepareError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new PrivacyPrepareError(`Image preparation failed: ${message}`);
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
