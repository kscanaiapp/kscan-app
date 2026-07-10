import type { ScanRequest } from '../scan-contract/request';

export type PrivacyPolicyMode =
  | 'CURRENT_MOBILE_COMPATIBILITY'
  | 'WEARABLE_MOCK'
  | 'WEARABLE_PRODUCTION_REQUIRED_MASKING'
  | 'METADATA_ONLY';

export class PrivacyPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PrivacyPolicyError';
  }
}

/**
 * Assert that a shared ScanRequest satisfies the given privacy policy.
 *
 * Policies:
 * - CURRENT_MOBILE_COMPATIBILITY: accepts honestly labeled passthrough input.
 * - WEARABLE_MOCK: accepts the mock masked result (metadata-only or masked).
 * - WEARABLE_PRODUCTION_REQUIRED_MASKING: rejects passthrough input; requires
 *   face and plate masking to have been applied. Not activated in the current app.
 * - METADATA_ONLY: passes when no image leaves the device.
 */
export function assertPrivacyPolicySatisfied(
  request: ScanRequest,
  policy: PrivacyPolicyMode,
): void {
  if (!request || typeof request !== 'object') {
    throw new PrivacyPolicyError('Invalid request.');
  }

  const privacy = request.privacy;
  if (!privacy || typeof privacy !== 'object') {
    throw new PrivacyPolicyError('Missing privacy context.');
  }

  switch (policy) {
    case 'CURRENT_MOBILE_COMPATIBILITY':
      if (privacy.mode !== 'passthrough') {
        throw new PrivacyPolicyError('Current mobile compatibility requires passthrough mode.');
      }
      if (privacy.faceMaskApplied || privacy.plateMaskApplied) {
        throw new PrivacyPolicyError('Current mobile compatibility does not claim masking.');
      }
      return;

    case 'WEARABLE_MOCK':
      if (privacy.mode !== 'masked' && privacy.mode !== 'metadata_only') {
        throw new PrivacyPolicyError('Wearable mock policy requires masked or metadata_only mode.');
      }
      return;

    case 'WEARABLE_PRODUCTION_REQUIRED_MASKING':
      if (privacy.mode === 'passthrough') {
        throw new PrivacyPolicyError('Production wearable policy rejects passthrough input.');
      }
      if (!privacy.faceDetectionPerformed || !privacy.faceMaskApplied) {
        throw new PrivacyPolicyError('Production wearable policy requires face masking.');
      }
      if (!privacy.plateDetectionPerformed || !privacy.plateMaskApplied) {
        throw new PrivacyPolicyError('Production wearable policy requires plate masking.');
      }
      if (request.image?.base64) {
        // In production, the base64 must be the masked output, not the raw input.
        // This policy checks flags only; the sanitizer is responsible for the pixel transform.
      }
      return;

    case 'METADATA_ONLY':
      if (request.image?.base64) {
        throw new PrivacyPolicyError('Metadata-only policy must not include image data.');
      }
      // Allow either text or future pre-computed attributes; image must be absent.
      return;

    default:
      throw new PrivacyPolicyError(`Unknown privacy policy: ${policy}`);
  }
}
