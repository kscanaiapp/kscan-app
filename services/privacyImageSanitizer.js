// services/privacyImageSanitizer.js

const isDev = typeof __DEV__ !== 'undefined' ? __DEV__ : process.env.NODE_ENV !== 'production';

const SANITIZER_STATUS = Object.freeze({
  faceDetectionAvailable: false,
  faceBlurApplied: false,
  mode: 'passthrough',
});

export function getPrivacySanitizerStatus() {
  return { ...SANITIZER_STATUS };
}

export async function sanitizeImageBeforeUpload(input, options = {}) {
  const _options = options; // reserved for Phase 2 (dependency-backed local detection/masking)

  if (isDev) {
    console.warn(
      `[K-SCAN PRIVACY] Sanitizer mode=${SANITIZER_STATUS.mode}; faceDetectionAvailable=${SANITIZER_STATUS.faceDetectionAvailable}; faceBlurApplied=${SANITIZER_STATUS.faceBlurApplied}`
    );
  }

  // v1 is intentionally pass-through to preserve current contract and performance.
  return input;
}