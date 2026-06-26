// services/privacyLensPrototype.js
// K Scan AI — Privacy Lens Post-Capture Orchestrator (Phase 2)
//
// This is the orchestration layer that coordinates:
//   1. Face detection (via privacyLensDetector adapter)
//   2. Face redaction (via privacyLensRedactor adapter)
//   3. Upload gate validation
//   4. Fail-closed error handling
//
// WARNING: This is a prototype, not a production privacy feature.
// Real face detection and selective redaction require additional native dependencies.
// The enabled path is fail-closed: any failure throws a safe Error, preventing upload.
//
// Activation:
//   PRIVACY_LENS_POST_CAPTURE_ENABLED is hardcoded to false.
//   Production behavior is unchanged while the flag is false.
//   Only enable in __DEV__ after explicit human approval and dependency verification.

import { detectFacesForPrivacyLens } from './privacyLensDetector';
import { redactFacesForPrivacyLens } from './privacyLensRedactor';

// ── Hardcoded guard flags (both disabled by default) ───────────────────────────
const PRIVACY_LENS_POST_CAPTURE_ENABLED = false;
const PRIVACY_LENS_ALLOW_DEV_MOCKS = false;

// ── Safe user-facing strings (design-only; not wired to UI) ──────────────────
const SAFE_MESSAGES = Object.freeze({
  failed: 'Privacy sanitization could not be completed. Please retake the photo or disable Privacy Lens.',
  unsupported: 'Privacy features are not available on this device.',
  skipped: 'Privacy check was not applied.',
});

// ── Type definitions (JSDoc) ─────────────────────────────────────────────────
/**
 * @typedef {'success' | 'failed' | 'skipped' | 'unsupported'} SanitizerStatus
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

// ── Upload gate helper (design-only; not wired into production) ────────────────
/**
 * Determines whether a sanitized result is safe to upload under a privacy-gated flow.
 *
 * Rules:
 *   - Feature disabled: allow legacy pass-through (always true when flag is false).
 *   - Feature enabled + detector unavailable: block.
 *   - Feature enabled + redactor unavailable: block.
 *   - Feature enabled + detected faces not all redacted: block.
 *   - Feature enabled + successful sanitized output: allow.
 *   - Feature enabled + detector ran successfully and found zero faces: allow original input.
 *   - Never allow raw fallback after sanitizer failure.
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

  // Feature disabled: legacy pass-through is always allowed
  if (!PRIVACY_LENS_POST_CAPTURE_ENABLED) {
    return true;
  }

  // Feature enabled: only allow successful outcomes
  if (sanitizerResult.status === 'success') {
    // Either faces were redacted, or detector confirmed zero faces
    return sanitizerResult.redacted === true || sanitizerResult.facesDetected === 0;
  }

  // Any failure, skipped, or unsupported state blocks upload
  return false;
}

// ── Orchestrator ───────────────────────────────────────────────────────────────
/**
 * Privacy Lens post-capture sanitizer orchestrator.
 *
 * Pipeline (enabled path only):
 *   1. Validate input is a non-empty string.
 *   2. Detect faces via detector adapter.
 *   3. If detector unavailable → throw (fail-closed).
 *   4. If zero faces detected → return original input (safe to upload).
 *   5. If faces detected → redact via redactor adapter.
 *   6. If redactor unavailable → throw (fail-closed).
 *   7. If redactor fails → throw (fail-closed).
 *   8. If not all faces redacted → throw (all-or-nothing rule).
 *   9. Return sanitized base64 data URI string.
 *
 * Fail-closed design: any failure in the enabled path throws a safe Error,
 * preventing the raw image from being uploaded.
 *
 * @param {string} input base64 data URI ("data:image/jpeg;base64,...")
 * @param {Object} [_options] reserved for future options
 * @returns {Promise<string>} sanitized image payload (base64 data URI)
 * @throws {Error} if privacy check or redaction fails
 */
export async function sanitizeImageBeforeUploadV2(input, _options = {}) {
  const start = Date.now();

  try {
    // ── Step 1: Input validation ───────────────────────────────────────────
    if (!input || typeof input !== 'string') {
      const err = new Error(SAFE_MESSAGES.failed);
      err.userMessage = SAFE_MESSAGES.failed;
      throw err;
    }

    // ── Step 2: Detect faces ──────────────────────────────────────────────
    const detectionResult = await detectFacesForPrivacyLens(input, {
      allowDevMocks: PRIVACY_LENS_ALLOW_DEV_MOCKS,
    });

    if (!detectionResult.ok) {
      // Detector unavailable or failed — fail-closed
      const err = new Error(
        detectionResult.reason || SAFE_MESSAGES.unsupported
      );
      err.userMessage = detectionResult.reason || SAFE_MESSAGES.unsupported;
      throw err;
    }

    const facesDetected = detectionResult.faces.length;

    // If zero faces detected, the original image is safe to upload
    if (facesDetected === 0) {
      return input;
    }

    // ── Step 3: Redact faces ──────────────────────────────────────────────
    const redactionResult = await redactFacesForPrivacyLens(
      input,
      detectionResult.faces,
      { allowDevMocks: PRIVACY_LENS_ALLOW_DEV_MOCKS }
    );

    if (!redactionResult.ok) {
      // Redactor unavailable or failed — fail-closed
      const err = new Error(
        redactionResult.reason || SAFE_MESSAGES.failed
      );
      err.userMessage = redactionResult.reason || SAFE_MESSAGES.failed;
      throw err;
    }

    // All-or-nothing rule: every detected face must be redacted
    const redactedIds = redactionResult.redactedFaceIds || [];
    const allFacesRedacted = detectionResult.faces.every((face) =>
      redactedIds.includes(face.id)
    );

    if (!allFacesRedacted) {
      const err = new Error(
        'Privacy Lens could not redact all detected faces. Please retake the photo.'
      );
      err.userMessage =
        'Privacy Lens could not redact all detected faces. Please retake the photo.';
      throw err;
    }

    // ── Step 4: Validate output format ────────────────────────────────────
    const sanitized = redactionResult.sanitizedImage;
    if (!sanitized || typeof sanitized !== 'string') {
      const err = new Error(SAFE_MESSAGES.failed);
      err.userMessage = SAFE_MESSAGES.failed;
      throw err;
    }

    // Ensure the output preserves the data URI header if the input had one
    // Do not return raw error text or null as the image payload
    return sanitized;
  } catch (error) {
    // Fail-closed: rethrow if it already has a userMessage
    if (error?.userMessage) {
      throw error;
    }
    // Wrap any unexpected error in a safe message
    const err = new Error(SAFE_MESSAGES.failed);
    err.userMessage = SAFE_MESSAGES.failed;
    throw err;
  } finally {
    // processingTimeMs is computed but intentionally not logged
    // to avoid any data leakage or biometric-style metadata exposure
    const _processingTimeMs = Date.now() - start;
    // eslint-disable-next-line no-unused-vars
    void _processingTimeMs;
  }
}

// ── Legacy-compatible wrapper (disabled by default) ───────────────────────────
/**
 * Legacy-compatible wrapper that preserves the original string return contract.
 *
 * When PRIVACY_LENS_POST_CAPTURE_ENABLED is false, this function is not used
 * and the legacy sanitizer in services/privacyImageSanitizer.js handles the call.
 *
 * When true, this wrapper calls the Phase 2 pipeline and returns a string.
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
