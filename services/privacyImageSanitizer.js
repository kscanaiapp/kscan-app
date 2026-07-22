// services/privacyImageSanitizer.js

import { prepareImageForPrivacyUpload } from './privacyImageUpload';

const isDev = typeof __DEV__ !== 'undefined' && __DEV__ === true;

const SANITIZER_STATUS = Object.freeze({
  faceDetectionAvailable: false,
  faceBlurApplied: false,
  plateDetectionAvailable: false,
  plateMaskApplied: false,
  metadataStripped: true,
  remoteTransmissionAllowed: true,
  sanitizerVersion: 'metadata-reencode-v1',
  mode: 'metadata-stripped-reencode',
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
  if (!input || typeof input !== 'string') {
    const error = new Error(PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE);
    error.name = 'PrivacySanitizerUnavailableError';
    error.userMessage = PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE;
    throw error;
  }

  if (isDev) {
    console.warn(
      `[K-SCAN PRIVACY] Sanitizer mode=${SANITIZER_STATUS.mode}; faceDetectionAvailable=${SANITIZER_STATUS.faceDetectionAvailable}; faceBlurApplied=${SANITIZER_STATUS.faceBlurApplied}`
    );
  }

  try {
    // Scanner compression already creates a fresh bounded JPEG. Preserve that
    // derivative instead of decoding and encoding it a third time.
    if (/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(input)) {
      return input;
    }

    // Library/file consumers may enter here before Scanner compression. Create
    // the same metadata-stripped local derivative used by the upload flow.
    const prepared = await prepareImageForPrivacyUpload(input, options);
    return prepared.sanitizedUri;
  } catch {
    const error = new Error(PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE);
    error.name = 'PrivacySanitizerUnavailableError';
    error.userMessage = PRIVACY_SANITIZER_UNAVAILABLE_MESSAGE;
    throw error;
  }
}
