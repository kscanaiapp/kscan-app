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

  // A region that was already fully redacted is a valid masked result even
  // though pixelsChanged is false -- pixelsChanged must not be the gate.
  // facesMasked > 0 with a real sanitizedUri is what actually indicates a
  // successfully masked (newly or already) output.
  let mode: PrivacySanitizerResult['mode'] = 'passthrough';
  if (result.status === 'success' && !!result.sanitizedUri && result.facesMasked > 0) {
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
  return !!result.sanitizedUri && result.facesMasked > 0;
}
