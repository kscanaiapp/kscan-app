import type { NativeFaceMaskResult, NativePrivacyStatus } from '../../../modules/kscan-pii-native/src/KScanPiiNative.types';
import type { PrivacySanitizerResult } from '../types';

/**
 * Adapter from the native face-masking module result to the foundation's
 * PrivacySanitizerResult shape.
 *
 * This adapter is intentionally isolated. It does not approve transmission;
 * that decision remains with the audited shared privacy policy.
 */
export function nativeResultToPrivacySanitizerResult(
  result: NativeFaceMaskResult,
): PrivacySanitizerResult {
  const warnings = [...(result.warnings ?? [])];
  if (result.failureReason) {
    warnings.push(result.failureReason);
  }

  let mode: PrivacySanitizerResult['mode'] = 'passthrough';
  if (result.status === 'success' && result.pixelsChanged && result.sanitizedUri) {
    mode = 'masked';
  }

  return {
    sanitizedImageUri: result.sanitizedUri,
    sanitizedBase64: undefined,
    sanitizerVersion: result.sanitizerVersion,
    mode,
    faceDetectionPerformed: result.facesDetected > 0 || result.status === 'no_faces',
    faceMaskApplied: result.status === 'success' && result.facesMasked > 0,
    plateDetectionPerformed: false,
    plateMaskApplied: false,
    warnings,
  };
}

/**
 * Map a native status to a policy-level transmission decision helper.
 *
 * The returned boolean is advisory; the privacy policy must still make the
 * final transmission decision.
 */
export function isNativeResultSafeForTransmission(result: NativeFaceMaskResult): boolean {
  if (result.status !== 'success') return false;
  return result.pixelsChanged && !!result.sanitizedUri && result.facesMasked > 0;
}
