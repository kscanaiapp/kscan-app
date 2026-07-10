import type { PrivacySanitizer, PrivacySanitizerInput, PrivacySanitizerResult } from './types';

const SANITIZER_VERSION = 'wearable-mock-1.0.0';

/**
 * Synthetic wearable mock sanitizer.
 *
 * This provider uses fixture metadata only. It simulates a future state where
 * local face and plate detection has been performed and masking has been applied.
 * It does NOT process a real user image and does NOT imply that production
 * masking currently exists.
 */
export const wearableMockSanitizer: PrivacySanitizer = {
  async sanitize(input: PrivacySanitizerInput): Promise<PrivacySanitizerResult> {
    const warnings: string[] = [];
    if (!input?.base64 && !input?.imageUri) {
      warnings.push('No image input provided; using synthetic metadata only.');
    }
    return {
      // In a real masked flow the sanitized output would be a new image. This
      // mock returns the original input unchanged and labels the mode masked
      // purely for contract testing.
      sanitizedImageUri: input?.imageUri,
      sanitizedBase64: input?.base64,
      sanitizerVersion: SANITIZER_VERSION,
      mode: 'masked',
      faceDetectionPerformed: true,
      faceMaskApplied: true,
      plateDetectionPerformed: true,
      plateMaskApplied: true,
      warnings,
    };
  },
};
