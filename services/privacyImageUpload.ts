// Fail-closed privacy boundary for photo-library uploads.
//
// This build integrates the native face-masking foundation (kscan-pii-native)
// behind the unified privacy boundary, but on-device license-plate detection
// does not exist yet. The availability rule is:
//
//   available = face detector available
//     AND plate detector available
//     AND local masking available
//     AND output verification available
//
// Plate detection is absent, so isPrivateImageUploadAvailable() === false and
// preparation fails closed before any image work. The face-processing path
// below is real, callable, and testable; it simply cannot open the gate.

import * as ImageManipulator from 'expo-image-manipulator';
import * as FileSystem from 'expo-file-system/legacy';
import {
  isImageDispatchAllowed,
  prepareImageForDispatch,
} from './privacy/privacyBoundary';
import { cleanupNativeSanitizedImage } from './privacy/nativeFaceEngine';
import {
  deletePrivacyArtifact,
  isOwnedPrivacyArtifactUri,
} from './privacy/privacyArtifactStore';

export const PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE =
  'Upload is unavailable until on-device face and license-plate masking can be verified.';

export function isPrivateImageUploadAvailable(): boolean {
  return isImageDispatchAllowed();
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
 * Validate the local input, then run the unified privacy boundary. While any
 * required capability (currently plate detection) is missing, the boundary
 * blocks before any image work and this throws fail-closed.
 */
export async function prepareImageForPrivacyUpload(
  inputUri: string,
  _options?: { maxDimension?: number; quality?: number },
): Promise<PrivacyPrepareResult> {
  if (!inputUri || typeof inputUri !== 'string') {
    throw new PrivacyPrepareError('No image selected.');
  }
  if (!isLocalImageUri(inputUri)) {
    throw new PrivacyPrepareError('Selected image must be on this device.');
  }

  const result = await prepareImageForDispatch(inputUri);
  if (result.status !== 'SANITIZED_AND_VERIFIED') {
    throw new PrivacyPrepareError(PRIVATE_IMAGE_UPLOAD_UNAVAILABLE_MESSAGE);
  }

  const { proof } = result;
  return {
    sanitizedUri: result.sanitizedUri,
    policy: {
      mode: proof.processingCompleted ? 'face_and_plate_masked' : 'blocked',
      sanitizerVersion: proof.sanitizerVersion,
      faceDetectionAvailable: proof.faceDetectionPerformed,
      faceMaskApplied: proof.facesMasked > 0,
      plateDetectionAvailable: proof.plateDetectionPerformed,
      plateMaskApplied: proof.platesMasked > 0,
      metadataStripped: proof.metadataStripped,
    },
  };
}

/**
 * Delete a temporary sanitized derivative created by this service.
 * Safe to call on missing/already-deleted files.
 */
export async function cleanupSanitizedImage(uri: string | undefined | null): Promise<void> {
  if (!uri) return;
  try {
    if (isOwnedPrivacyArtifactUri(uri)) {
      await cleanupNativeSanitizedImage(uri);
      await deletePrivacyArtifact(uri);
      return;
    }
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
