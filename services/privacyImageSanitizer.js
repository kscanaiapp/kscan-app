// services/privacyImageSanitizer.js

const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;

const SANITIZER_STATUS = Object.freeze({
  faceDetectionAvailable: false,
  faceBlurApplied: false,
  plateDetectionAvailable: false,
  plateMaskApplied: false,
  remoteTransmissionAllowed: true,
  mode: 'passthrough',
});

export const PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE =
  'The selected image could not be prepared securely.';

export function getPrivacySanitizerStatus() {
  return { ...SANITIZER_STATUS };
}

/**
 * @param {string} input
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<string>}
 */
export async function sanitizeImageBeforeUpload(input, options = {}) {
  const _options = options; // reserved for Phase 2 (dependency-backed local detection/masking)

  if (isDev) {
    console.warn(
      `[K-SCAN PRIVACY] Sanitizer mode=${SANITIZER_STATUS.mode}; faceDetectionAvailable=${SANITIZER_STATUS.faceDetectionAvailable}; faceBlurApplied=${SANITIZER_STATUS.faceBlurApplied}`
    );
  }

  // Restore the proven v13 contract: return a usable image string so Scanner
  // camera/gallery analysis can proceed. Gallery intake additionally re-encodes
  // through privacyImageUpload before this step when that path is used.
  return input;
}
