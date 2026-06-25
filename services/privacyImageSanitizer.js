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

const PRIVACY_LENS_POST_CAPTURE_ENABLED = false;

export async function sanitizeImageBeforeUpload(input, options = {}) {
  const _options = options; // reserved for Phase 2 (dependency-backed local detection/masking)

  if (isDev) {
    console.warn(
      `[K-SCAN PRIVACY] Sanitizer mode=${SANITIZER_STATUS.mode}; faceDetectionAvailable=${SANITIZER_STATUS.faceDetectionAvailable}; faceBlurApplied=${SANITIZER_STATUS.faceBlurApplied}`
    );
  }

  // v1 is intentionally pass-through to preserve current contract and performance.
  // When the post-capture prototype is enabled, delegate to the prototype pipeline.
  if (PRIVACY_LENS_POST_CAPTURE_ENABLED) {
    try {
      const { sanitizeImageBeforeUploadV2 } = await import('./privacyLensPrototype');
      return await sanitizeImageBeforeUploadV2(input);
    } catch (error) {
      // Fail-closed: any privacy check failure prevents upload
      if (error?.userMessage) {
        throw error;
      }
      const err = new Error('Privacy check failed. Please retake or try again.');
      err.userMessage = 'Privacy check failed. Please retake or try again.';
      throw err;
    }
  }

  return input;
}