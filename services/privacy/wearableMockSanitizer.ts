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
    // FIX (glasses-foundation-audit): No real pixel-level masking is performed
    // here. Returning the caller's original, unmodified image bytes while
    // claiming faceMaskApplied/mode: 'masked' would be a false privacy claim
    // if this result were ever consumed downstream. This mock therefore never
    // returns image bytes -- it only simulates the metadata shape a future
    // real masking implementation would produce.
    warnings.push('No real pixel-level face or plate masking was performed; this is a synthetic mock result for contract testing only.');
    return {
      sanitizedImageUri: undefined,
      sanitizedBase64: undefined,
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
