/**
 * Device capability + thermal governor — Section 28-29.
 *
 * "Do not classify solely from phone marketing name... Perform a short
 * runtime capability calibration." This file defines the shape of that
 * calibration and the resulting level; the actual measurement loop lives
 * in the native layer (native/ios, native/android), which has no
 * calibration evidence yet — see docs/vto-phase1-status.md. The
 * thresholds below are named placeholders pending that evidence, per
 * Section 29: "Do not fabricate fixed universal FPS/thermal thresholds
 * before baselines exist... recommend thresholds for human approval."
 */

export type DeviceCapabilityLevel = 'ENHANCED' | 'STANDARD' | 'BASIC' | 'UNSUPPORTED';

export interface DeviceCapabilitySample {
  cameraFrameTimeMs: number;
  poseLatencyMs: number;
  segmentationLatencyMs: number;
  renderTimeMs: number;
  droppedFrameRatio: number; // [0,1] over the sampling window
  memoryPressure: 'nominal' | 'warning' | 'critical' | 'unknown';
  thermalState: 'nominal' | 'fair' | 'serious' | 'critical';
}

export interface DeviceCapabilityThresholds {
  enhancedMaxFrameTimeMs: number;
  standardMaxFrameTimeMs: number;
  basicMaxFrameTimeMs: number;
  maxDroppedFrameRatioForEnhanced: number;
  maxDroppedFrameRatioForStandard: number;
}

/** PLACEHOLDER — not validated against device evidence. See file header. */
export const DEFAULT_DEVICE_CAPABILITY_THRESHOLDS: DeviceCapabilityThresholds = {
  enhancedMaxFrameTimeMs: 16, // ~60fps budget
  standardMaxFrameTimeMs: 33, // ~30fps budget
  basicMaxFrameTimeMs: 50, // ~20fps budget
  maxDroppedFrameRatioForEnhanced: 0.02,
  maxDroppedFrameRatioForStandard: 0.1,
};

export function classifyDeviceCapability(
  sample: DeviceCapabilitySample,
  thresholds: DeviceCapabilityThresholds = DEFAULT_DEVICE_CAPABILITY_THRESHOLDS,
): DeviceCapabilityLevel {
  if (sample.thermalState === 'critical' || sample.memoryPressure === 'critical') {
    return 'UNSUPPORTED';
  }

  const worstFrameTime = Math.max(sample.cameraFrameTimeMs, sample.poseLatencyMs, sample.segmentationLatencyMs, sample.renderTimeMs);

  if (
    worstFrameTime <= thresholds.enhancedMaxFrameTimeMs &&
    sample.droppedFrameRatio <= thresholds.maxDroppedFrameRatioForEnhanced &&
    sample.thermalState === 'nominal'
  ) {
    return 'ENHANCED';
  }

  if (
    worstFrameTime <= thresholds.standardMaxFrameTimeMs &&
    sample.droppedFrameRatio <= thresholds.maxDroppedFrameRatioForStandard
  ) {
    // thermalState 'critical' already returned UNSUPPORTED above, so only
    // 'nominal' | 'fair' | 'serious' reach this branch.
    return 'STANDARD';
  }

  if (worstFrameTime <= thresholds.basicMaxFrameTimeMs) {
    return 'BASIC';
  }

  return 'UNSUPPORTED';
}

/**
 * Section 29 runtime adaptation actions, ordered cheapest/least-visible
 * first. A governor applies these in order as device state degrades and
 * reverses them in order as it recovers — never jumps straight to the
 * "Live Preview isn't available" fallback without having tried the
 * cheaper steps first.
 */
export const QUALITY_REDUCTION_STEPS = [
  'lowerSegmentationCadence',
  'lowerInferenceResolution',
  'reducePoseCadence',
  'simplifyMesh',
  'disableOptionalLighting',
  'reduceSecondaryEffects',
] as const;
export type QualityReductionStep = (typeof QUALITY_REDUCTION_STEPS)[number];

export const LIVE_UNAVAILABLE_FALLBACK_MESSAGE =
  "Live Preview isn't available on this device right now. Try AI Photo.";
