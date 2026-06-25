// services/privacyLensPrototype.js
// K Scan AI — Privacy Lens Post-Capture Prototype (Phase 1A)
// NO-TERMINAL SCAFFOLD — Mock only. No real face detection. No pixelation.
//
// WARNING: This is a contract-first architectural prototype.
// It does NOT implement real privacy filtering.
// It does NOT manipulate pixels.
// It does NOT perform biometric detection.
//
// Activation:
//   Both flags below are hardcoded to false. Production behavior is unchanged.
//   Only enable in __DEV__ after explicit human approval and dependency verification.

// ── Hardcoded guard flags (both disabled by default) ───────────────────────────
const PRIVACY_LENS_PROTOTYPE_ENABLED = false;
const PRIVACY_LENS_MOCK_DETECTION_ENABLED = false;

const MOCK_ENABLED =
  typeof __DEV__ !== 'undefined' &&
  __DEV__ === true &&
  PRIVACY_LENS_MOCK_DETECTION_ENABLED === true;

// ── Type definitions (JSDoc) ─────────────────────────────────────────────────
/**
 * @typedef {'success' | 'failed' | 'skipped' | 'unsupported'} SanitizerStatus
 */

/**
 * @typedef {Object} SanitizationResult
 * @property {SanitizerStatus} status
 * @property {string | null} artifact
 *   Sanitized image payload (e.g., base64 data URI) or null on failure/unsupported.
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

// ── Safe user-facing strings (design-only; not wired to UI) ──────────────────
const SAFE_MESSAGES = Object.freeze({
  failed:
    'Privacy check failed. Please retake or try again.',
  unsupported:
    'Privacy features are not available on this device.',
  skipped:
    'Privacy check was not applied.',
});

// ── Mock detector stub ───────────────────────────────────────────────────────
/**
 * Minimal stub detector. Returns an empty face-region array by default.
 * Only returns a hardcoded mock region when MOCK_ENABLED is true.
 *
 * Rules:
 *   - Does not manipulate pixels.
 *   - Does not perform real detection.
 *   - Does not log coordinates, landmarks, contours, or bounds.
 *   - Mock region data is discarded after use; never stored or transmitted.
 *
 * @returns {Array<{x: number, y: number, width: number, height: number, label: string}>}
 */
function runMockDetectorStub() {
  if (!MOCK_ENABLED) {
    return [];
  }

  // Hardcoded mock region for prototype testing ONLY.
  // Never enable in production. No real detection.
  return [
    { x: 0.25, y: 0.25, width: 0.5, height: 0.5, label: 'mock-face-stub' },
  ];
}

// ── Strategy: Mock (disabled by default) ───────────────────────────────────
/**
 * Mock sanitizer strategy.
 * Does not manipulate pixels. Does not claim redaction occurred.
 * Returns the original artifact inside a clearly marked mock result.
 *
 * @param {string} inputArtifact
 * @returns {SanitizationResult}
 */
function SanitizerStrategyMock(inputArtifact) {
  const start = Date.now();
  const mockRegions = runMockDetectorStub();

  // Future real implementations must treat all detected face regions as all-or-nothing.
  // If any region fails during real processing, the entire sanitizer must return failed.

  return {
    status: 'skipped',
    artifact: inputArtifact,
    facesDetected: mockRegions.length,
    processingTimeMs: Date.now() - start,
    method: 'mock',
    redacted: false,
    cleanupUris: [],
    userMessage: SAFE_MESSAGES.skipped,
  };
}

// ── Strategy: Real placeholder (not implemented) ───────────────────────────────
/**
 * Placeholder for future real pixelation / redaction / blur implementation.
 *
 * Requirements before activation:
 *   1. Terminal agent must verify and install a real image-processing library
 *      capable of overlay/mask/pixelation (expo-image-manipulator ~14.0.8
 *      supports resize, crop, rotate, flip only — no verified blur/pixelate).
 *   2. Real still-image face detector must be verified and installed.
 *   3. Timeout boundary (~3000ms) must be implemented.
 *   4. Raw temp-file cleanup must be verified.
 *
 * @param {string} _inputArtifact
 * @returns {SanitizationResult}
 */
function SanitizerStrategyRealPlaceholder(_inputArtifact) {
  return {
    status: 'unsupported',
    artifact: null,
    facesDetected: 0,
    processingTimeMs: 0,
    method: 'none',
    redacted: false,
    cleanupUris: [],
    userMessage: SAFE_MESSAGES.unsupported,
  };
}

// ── Factory ──────────────────────────────────────────────────────────────────
/**
 * Selects a sanitizer strategy based on flags.
 *
 * Default path (both flags false): returns a mock-stub result with the original
 * artifact unchanged, so the contract shape is available for future callers without
 * breaking the legacy string-only pipeline.
 *
 * @param {string} inputArtifact
 * @returns {SanitizationResult}
 */
export function createPrivacyLensSanitizer(inputArtifact) {
  if (!PRIVACY_LENS_PROTOTYPE_ENABLED) {
    return SanitizerStrategyMock(inputArtifact);
  }

  // When the prototype flag is enabled but no real dependencies are installed,
  // still fall back to the mock strategy. A terminal dependency spike will swap
  // this branch to the real strategy later.
  return SanitizerStrategyMock(inputArtifact);
}

// ── Upload gate helper (design-only; not wired to production) ───────────────
/**
 * Determines whether a sanitized result is safe to upload under a
 * privacy-gated flow.
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

// ── Prototype wrapper with safe failure boundary ─────────────────────────────
/**
 * Safe prototype wrapper with try/catch boundary.
 *
 * Any exception returns a failed result. In the future design, a thrown
 * sanitizer must NEVER allow raw upload.
 *
 * TODO (future real implementation):
 *   - Add a timeout boundary (~3000ms). If exceeded → status: 'failed'.
 *   - Swap the mock strategy for the real strategy after dependency verification.
 *   - Wire cleanupUris deletion into the caller's finally block.
 *
 * @param {string} inputArtifact
 * @returns {SanitizationResult}
 */
export function sanitizeImageBeforeUploadPrototype(inputArtifact) {
  try {
    return createPrivacyLensSanitizer(inputArtifact);
  } catch (_err) {
    return {
      status: 'failed',
      artifact: null,
      facesDetected: 0,
      processingTimeMs: 0,
      method: 'none',
      redacted: false,
      cleanupUris: [],
      userMessage: SAFE_MESSAGES.failed,
    };
  }
}
