// Privacy boundary for local photo-library uploads into Scanner and Elise.
// Every accepted local image is re-encoded before analysis so source metadata
// is not transmitted. This does not claim face or license-plate masking.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';

const SANITIZER_VERSION = 'elise-upload-metadata-only-1.0.0';

// Max dimension for the sanitized derivative. Large enough for fashion analysis,
// small enough to keep payloads bounded.
const MAX_UPLOAD_DIMENSION = 1024;
const UPLOAD_QUALITY = 0.82;

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

function honestPolicy(metadataStripped: boolean) {
  return {
    mode: 'metadata-stripped-reencode',
    sanitizerVersion: SANITIZER_VERSION,
    faceDetectionAvailable: false,
    faceMaskApplied: false,
    plateDetectionAvailable: false,
    plateMaskApplied: false,
    metadataStripped,
  };
}

/**
 * Resize instructions that bound the LONGEST edge, not the width.
 *
 * `{ resize: { width: max } }` alone was never a maximum dimension: it pins
 * the width and lets expo-image-manipulator derive the height from the aspect
 * ratio, so an 800x2400 portrait came back 1024x3072 -- three times the bound
 * it was supposed to be under -- and a 400x600 thumbnail was UPSCALED to
 * 1024x1536, spending payload on pixels that were never in the source.
 *
 * Given the source dimensions this returns a single-axis instruction on
 * whichever edge is longer (so the aspect ratio is still derived, never
 * distorted), or NO instruction at all when the image is already inside the
 * bound -- that is the half that stops the upscale.
 *
 * WHEN THE DIMENSIONS ARE UNKNOWN it returns the legacy width-only action
 * rather than probing. A probe means a second full-resolution decode+encode
 * on the Scanner and Elise upload paths, which is a real cost on low-end
 * Android for a build that is frozen; callers that already hold the source
 * dimensions (VTO does, from the picker asset and from VtoPersonInput) pass
 * them and get the true bound for free. See __tests__/vtoMediaLifecycle.test.js.
 */
export function boundedResizeActions(
  sourceWidth: number | null | undefined,
  sourceHeight: number | null | undefined,
  maxDimension: number,
): Array<{ resize: { width?: number; height?: number } }> {
  const legacy = [{ resize: { width: maxDimension } }];
  if (!Number.isFinite(maxDimension) || maxDimension <= 0) return legacy;
  if (
    typeof sourceWidth !== 'number' ||
    typeof sourceHeight !== 'number' ||
    !Number.isFinite(sourceWidth) ||
    !Number.isFinite(sourceHeight) ||
    sourceWidth <= 0 ||
    sourceHeight <= 0
  ) {
    return legacy;
  }
  // Already within the bound on both edges: re-encode only. Never upscale.
  if (sourceWidth <= maxDimension && sourceHeight <= maxDimension) return [];
  return sourceWidth >= sourceHeight
    ? [{ resize: { width: maxDimension } }]
    : [{ resize: { height: maxDimension } }];
}

/**
 * Prepare a photo-library image for remote fashion analysis.
 *
 * Returns a sanitized derivative URI and an honest privacy policy. Throws
 * PrivacyPrepareError when the input is invalid or re-encoding fails.
 */
export async function prepareImageForPrivacyUpload(
  inputUri: string,
  options?: {
    maxDimension?: number;
    quality?: number;
    /** Dimensions of `inputUri` when the caller already knows them. Supplying
     *  them is what upgrades the bound from width-only to longest-edge. */
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  },
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
      boundedResizeActions(options?.sourceWidth, options?.sourceHeight, maxDimension),
      {
        compress: quality,
        format: ImageManipulator.SaveFormat.JPEG,
        base64: false,
      },
    );

    if (!result?.uri || typeof result.uri !== 'string') {
      throw new PrivacyPrepareError(PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE);
    }

    return {
      sanitizedUri: result.uri,
      width: result.width,
      height: result.height,
      policy: honestPolicy(true),
    };
  } catch (err) {
    if (err instanceof PrivacyPrepareError) throw err;
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
 */
export async function compressSanitizedImageForAnalysis(
  sanitizedUri: string,
  options?: {
    width?: number;
    quality?: number;
    /** Dimensions of `sanitizedUri` when known. Same upgrade as above: with
     *  them the derivative is bounded on its longest edge and a small image
     *  is re-encoded rather than blown up into a larger payload. */
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  },
): Promise<{ base64: string; uri: string }> {
  const maxDimension = options?.width ?? 896;
  const result = await ImageManipulator.manipulateAsync(
    sanitizedUri,
    boundedResizeActions(options?.sourceWidth, options?.sourceHeight, maxDimension),
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
