/**
 * Privacy sanitizer boundary types.
 *
 * This boundary is isolated from the existing mobile privacyImageSanitizer.js.
 * It defines the contract future wearable clients will use once local face and
 * plate masking is implemented.
 */

export interface PrivacySanitizerInput {
  imageUri?: string;
  base64?: string;
  mimeType?: string;
}

export type PrivacySanitizerMode = 'passthrough' | 'masked' | 'metadata_only';

export interface PrivacySanitizerResult {
  sanitizedImageUri?: string;
  sanitizedBase64?: string;
  sanitizerVersion: string;
  mode: PrivacySanitizerMode;
  faceDetectionPerformed: boolean;
  faceMaskApplied: boolean;
  plateDetectionPerformed: boolean;
  plateMaskApplied: boolean;
  warnings: string[];
}

export interface PrivacySanitizer {
  sanitize(input: PrivacySanitizerInput): Promise<PrivacySanitizerResult>;
}
