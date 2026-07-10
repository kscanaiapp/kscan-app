import type { PrivacySanitizer, PrivacySanitizerInput, PrivacySanitizerResult } from './types';

const SANITIZER_VERSION = 'mobile-compat-1.0.0';

/**
 * Current mobile compatibility sanitizer.
 *
 * Represents today's app behavior honestly: the image is passed through unchanged.
 * No face detection, no face masking, no plate detection, no plate masking is
 * performed. This provider is isolated and is not wired into the existing mobile
 * flow.
 */
export const mobileCompatibilitySanitizer: PrivacySanitizer = {
  async sanitize(input: PrivacySanitizerInput): Promise<PrivacySanitizerResult> {
    const warnings: string[] = [];
    if (!input?.base64 && !input?.imageUri) {
      warnings.push('No image input provided; returning empty passthrough result.');
    }
    return {
      sanitizedImageUri: input?.imageUri,
      sanitizedBase64: input?.base64,
      sanitizerVersion: SANITIZER_VERSION,
      mode: 'passthrough',
      faceDetectionPerformed: false,
      faceMaskApplied: false,
      plateDetectionPerformed: false,
      plateMaskApplied: false,
      warnings,
    };
  },
};
