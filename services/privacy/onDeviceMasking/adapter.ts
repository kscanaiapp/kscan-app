import type { OnDevicePrivacyResult } from './types';
import type { PrivacySanitizerResult } from '../types';

/**
 * Adapt the on-device privacy pipeline result into the foundation's
 * PrivacySanitizerResult shape.
 *
 * Rules:
 * - `mode: 'masked'` only when real pixels changed.
 * - `mode: 'passthrough'` when no pixels changed.
 * - Unsupported detector or failed codec results cannot map to `masked`.
 * - Strict wearable policy is never silently downgraded.
 */
export function toPrivacySanitizerResult(
  result: OnDevicePrivacyResult,
): PrivacySanitizerResult {
  const faceWarnings = result.faceDetection.warnings ?? [];
  const plateWarnings = result.plateDetection.warnings ?? [];
  const maskingWarnings = result.masking.warnings ?? [];

  const warnings = [
    ...faceWarnings,
    ...plateWarnings,
    ...maskingWarnings,
    ...result.failureReasons,
  ];

  // Determine mode honestly.
  let mode: PrivacySanitizerResult['mode'] = 'passthrough';
  if (result.masking.completed && result.masking.pixelsChanged) {
    mode = 'masked';
  } else if (result.failureReasons.length > 0 || !result.safeForTransmission) {
    // Any failure or blocked transmission stays honest: do not claim masking.
    mode = 'passthrough';
  }

  return {
    sanitizedImageUri: undefined,
    sanitizedBase64: undefined,
    sanitizerVersion: result.sanitizerVersion,
    mode,
    faceDetectionPerformed: result.faceDetection.completed,
    faceMaskApplied: result.masking.completed && result.masking.regionsMasked > 0,
    plateDetectionPerformed: result.plateDetection.completed,
    plateMaskApplied: result.masking.completed && result.masking.regionsMasked > 0,
    warnings,
  };
}
