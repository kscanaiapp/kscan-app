import { NativeModules, Platform } from 'react-native';

const nativeSanitizer = NativeModules.KScanPrivacySanitizer;

export function getPrivacySanitizerStatus() {
  const available = Platform.OS === 'android' && !!nativeSanitizer?.sanitizeJpeg;
  return {
    faceDetectionAvailable: available,
    faceBlurApplied: available,
    mode: available ? 'mlkit-local-solid-mask' : 'unavailable',
  };
}

/**
 * Strict mode is used by wearable scans. It always returns newly encoded JPEG
 * bytes or throws before analysis; raw fallback is intentionally impossible.
 * Existing non-wearable mobile scans retain their established path until the
 * corresponding iOS native sanitizer is approved.
 */
export async function sanitizeImageBeforeUpload(input, options = {}) {
  if (!options.requireFaceMasking) return input;
  if (typeof input !== 'string' || !input.startsWith('data:image/jpeg;base64,')) {
    throw Object.assign(new Error('Privacy validation blocked this scan.'), { code: 'PRIVACY_INVALID_INPUT' });
  }
  if (Platform.OS !== 'android' || !nativeSanitizer?.sanitizeJpeg) {
    throw Object.assign(new Error('Privacy protection is unavailable on this phone build.'), { code: 'PRIVACY_UNAVAILABLE' });
  }
  const result = await nativeSanitizer.sanitizeJpeg(input);
  if (!result?.dataUri || result.dataUri === input || !result.dataUri.startsWith('data:image/jpeg;base64,')) {
    throw Object.assign(new Error('Privacy validation blocked this scan.'), { code: 'PRIVACY_OUTPUT_INVALID' });
  }
  return result.dataUri;
}
