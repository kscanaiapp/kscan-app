// services/privacyLensPrototype.js
// K Scan AI — Privacy Lens Post-Capture Prototype (Phase 1B)
// NO-TERMINAL BUILD — Uses only installed dependencies.
//
// WARNING: This is a prototype, not a production privacy feature.
// Face detection is mocked. Image redaction is a placeholder.
// Real face detection and selective redaction require additional native dependencies.
//
// Activation:
//   PRIVACY_LENS_POST_CAPTURE_ENABLED is hardcoded to false.
//   Production behavior is unchanged while the flag is false.
//   Only enable in __DEV__ after explicit human approval and dependency verification.

import * as ImageManipulator from 'expo-image-manipulator';
import { writeAsStringAsync, deleteAsync, cacheDirectory } from 'expo-file-system/legacy';

// ── Hardcoded guard flags (both disabled by default) ───────────────────────────
const PRIVACY_LENS_POST_CAPTURE_ENABLED = false;
const PRIVACY_LENS_MOCK_DETECTION_ENABLED = false;

const MOCK_ENABLED =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ === true &&
  PRIVACY_LENS_MOCK_DETECTION_ENABLED === true;

// ── Safe user-facing strings (design-only; not wired to UI) ────────────────────
const SAFE_MESSAGES = Object.freeze({
  failed: 'Privacy check failed. Please retake or try again.',
  unsupported: 'Privacy features are not available on this device.',
  skipped: 'Privacy check was not applied.',
});

// ── Type definitions (JSDoc) ─────────────────────────────────────────────────
/**
 * @typedef {'success' | 'failed' | 'skipped' | 'unsupported'} SanitizerStatus
 */

/**
 * @typedef {Object} FaceRegion
 * @property {number} x Normalized x-coordinate (0-1).
 * @property {number} y Normalized y-coordinate (0-1).
 * @property {number} width Normalized width (0-1).
 * @property {number} height Normalized height (0-1).
 */

/**
 * @typedef {Object} SanitizationResult
 * @property {SanitizerStatus} status
 * @property {string | null} artifact
 *   Sanitized image payload (base64 data URI) or null on failure/unsupported.
 * @property {number} facesDetected
 *   In-memory count only. NEVER logged to console, analytics, crash reporting,
 *   or backend telemetry. NEVER included in network payloads.
 * @property {number} processingTimeMs
 * @property {'mock' | 'pixelate' | 'blur' | 'redact' | 'none'} method
 * @property {boolean} redacted
 * @property {string[]} [cleanupUris]
 *   Temporary file URIs that a future real implementation must delete after use.
 * @property {string} [userMessage]
 *   Safe, non-technical message for future UI surfacing.
 */

// ── Mock detector ──────────────────────────────────────────────────────────────
/**
 * Minimal mock detector. Returns an empty face-region array by default.
 * Only returns hardcoded mock regions when MOCK_ENABLED is true.
 *
 * Rules:
 *   - Does not perform real detection.
 *   - Does not log coordinates, landmarks, contours, or bounds.
 *   - Mock region data is discarded after use; never stored or transmitted.
 *
 * @param {string} _input base64 data URI (not used by mock).
 * @returns {Promise<FaceRegion[]>}
 */
export async function detectFaces(_input) {
  if (!MOCK_ENABLED) {
    return [];
  }

  // Hardcoded mock region for prototype testing ONLY.
  // Never enable in production. No real detection.
  return [
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5 },
  ];
}

// ── Temp file helpers ─────────────────────────────────────────────────────────
/**
 * Convert a base64 data URI to a temporary file for expo-image-manipulator.
 *
 * @param {string} base64DataUri
 * @returns {Promise<string>} temp file URI
 */
async function base64DataUriToTempFile(base64DataUri) {
  // Strip data URI prefix to get raw base64
  const rawBase64 = base64DataUri.replace(/^data:[^;]+;base64,/, '');
  const tempFile = `${cacheDirectory}privacy-lens-${Date.now()}.jpg`;
  await writeAsStringAsync(tempFile, rawBase64, { encoding: 'base64' });
  return tempFile;
}

// ── Redaction placeholder ─────────────────────────────────────────────────────
/**
 * Placeholder redaction adapter.
 *
 * Current behavior: returns the original image unchanged.
 * This demonstrates the pipeline structure (temp file → manipulate → cleanup).
 *
 * Real implementation requires:
 *   1. A library capable of selective pixelation/blur/overlay (e.g., Skia).
 *   2. Real face detection coordinates from a detector (e.g., MLKit).
 *
 * All-or-nothing rule: if any region fails during real processing, the entire
 * sanitizer must return failed. Partial sanitization is unacceptable.
 *
 * @param {string} input base64 data URI
 * @param {FaceRegion[]} faceRegions detected face regions (mock or real)
 * @returns {Promise<string>} image payload (base64 data URI)
 */
export async function redactFaces(input, faceRegions) {
  if (!faceRegions || faceRegions.length === 0) {
    return input;
  }

  let tempFile = null;
  try {
    // Convert base64 data URI to temp file for expo-image-manipulator
    tempFile = await base64DataUriToTempFile(input);

    // Placeholder: expo-image-manipulator pass-through.
    // No real redaction is performed. The pipeline demonstrates:
    //   1. Temp file creation from base64
    //   2. Image manipulation via expo-image-manipulator
    //   3. Base64 conversion back
    //   4. Temp file cleanup
    //
    // Real redaction would require selective operations (blur, pixelate, overlay).
    // expo-image-manipulator ~14.0.8 supports only: resize, crop, rotate, flip.
    // Selective redaction requires Skia or a native image-processing library.
    const result = await ImageManipulator.manipulateAsync(
      tempFile,
      [], // No operations — pass-through placeholder
      { format: ImageManipulator.SaveFormat.JPEG, base64: true }
    );

    return `data:image/jpeg;base64,${result.base64}`;
  } catch (error) {
    // Any manipulation failure is treated as a redaction failure.
    // In the future design, a thrown sanitizer must NEVER allow raw upload.
    const err = new Error('Privacy redaction failed. Please retake or try again.');
    err.userMessage = SAFE_MESSAGES.failed;
    throw err;
  } finally {
    // Cleanup temp file — always attempt, ignore errors
    if (tempFile) {
      try {
        await deleteAsync(tempFile);
      } catch (_cleanupError) {
        // Ignore cleanup errors — do not log temp file paths or image data
      }
    }
  }
}

// ── Upload gate helper (design-only; not wired into production) ────────────────
/**
 * Determines whether a sanitized result is safe to upload under a privacy-gated flow.
 *
 * Rules:
 *   - Returns true ONLY for status === 'success' AND redacted === true.
 *   - Returns false for 'failed', 'unsupported', and 'skipped'.
 *
 * TODO: Wire into production upload after terminal dependency verification
 *       and explicit product decision to enforce privacy-gated uploads.
 *
 * @param {SanitizationResult} sanitizerResult
 * @returns {boolean}
 */
export function validatePrivacyLensUploadGate(sanitizerResult) {
  if (!sanitizerResult || typeof sanitizerResult !== 'object') {
    return false;
  }
  return (
    sanitizerResult.status === 'success' && sanitizerResult.redacted === true
  );
}

// ── Main prototype function ───────────────────────────────────────────────────
/**
 * Privacy Lens post-capture sanitizer prototype.
 *
 * Pipeline:
 *   1. Detect faces (mock by default, real when dependencies available).
 *   2. Redact faces (placeholder by default, real when Skia/native available).
 *   3. Return sanitized image or throw error (fail-closed).
 *
 * Fail-closed design: any error in the pipeline throws a safe error,
 * preventing the raw image from being uploaded.
 *
 * @param {string} input base64 data URI ("data:image/jpeg;base64,...")
 * @returns {Promise<string>} sanitized image payload (base64 data URI)
 * @throws {Error} if privacy check or redaction fails
 */
export async function sanitizeImageBeforeUploadV2(input) {
  const start = Date.now();

  try {
    // Step 1: Detect faces
    const faceRegions = await detectFaces(input);
    const facesDetected = faceRegions.length;

    if (facesDetected === 0) {
      // No faces detected — return original image unchanged
      return input;
    }

    // Step 2: Redact faces (placeholder)
    // Future real implementation: use Skia or native module for selective pixelation.
    const redacted = await redactFaces(input, faceRegions);

    // Step 3: Return sanitized image
    // In the future, this would return a SanitizationResult object.
    // For now, we return the string to preserve the legacy caller contract.
    return redacted;
  } catch (error) {
    // Fail-closed: any exception prevents upload
    if (error?.userMessage) {
      throw error;
    }
    const err = new Error(SAFE_MESSAGES.failed);
    err.userMessage = SAFE_MESSAGES.failed;
    throw err;
  } finally {
    // processingTimeMs is computed but not logged (per privacy rules)
    const _processingTimeMs = Date.now() - start;
    // Intentionally not logging _processingTimeMs to avoid any data leakage
  }
}

// ── Legacy-compatible wrapper (disabled by default) ───────────────────────────
/**
 * Legacy-compatible wrapper that preserves the original string return contract.
 *
 * When PRIVACY_LENS_POST_CAPTURE_ENABLED is false, this function is not used
 * and the legacy sanitizer in services/privacyImageSanitizer.js handles the call.
 *
 * When true, this wrapper calls the prototype pipeline and returns a string.
 *
 * @param {string} input base64 data URI
 * @returns {Promise<string>} sanitized image payload or original input
 * @throws {Error} if privacy check fails
 */
export async function sanitizeImageBeforeUploadPrototype(input) {
  if (!PRIVACY_LENS_POST_CAPTURE_ENABLED) {
    return input;
  }

  return await sanitizeImageBeforeUploadV2(input);
}
