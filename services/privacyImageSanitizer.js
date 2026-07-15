// services/privacyImageSanitizer.js

const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;

const SANITIZER_STATUS = Object.freeze({
  faceDetectionAvailable: false,
  faceBlurApplied: false,
  plateDetectionAvailable: false,
  plateMaskApplied: false,
  remoteTransmissionAllowed: false,
  mode: 'blocked',
});

export const PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE =
  'Image analysis is unavailable because on-device face and license-plate masking is not installed.';

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

  // Fail closed. A pass-through or metadata-only transform is not sufficient
  // for the app's Zero-Knowledge image boundary and must never be represented
  // as safe for remote transmission.
  throw new Error(PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE);
}
