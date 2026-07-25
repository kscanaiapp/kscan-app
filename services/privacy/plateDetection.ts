// License-plate detection contract for the Zero-Knowledge privacy pipeline.
//
// No on-device plate detector exists in this build. This module defines the
// smallest interface the pipeline needs and ships an explicitly unsupported
// implementation. It never inspects an image, never fabricates detections,
// and keeps the global privacy gate closed.

export interface PlateBoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PlateDetectionCapabilities {
  supported: boolean;
  detectorImplementation: 'unavailable' | string;
  detectorVersion: string;
}

export interface PlateDetectionFailure {
  code:
    | 'PLATE_DETECTOR_UNAVAILABLE'
    | 'PLATE_DETECTION_FAILED'
    | 'INVALID_INPUT';
  reason: string;
}

export interface PlateDetectionResult {
  supported: boolean;
  performed: boolean;
  regionsDetected: number;
  regionsAccepted: number;
  confidence: number[];
  boundingBoxes: PlateBoundingBox[];
  durationMs: number;
  failure?: PlateDetectionFailure;
}

const PLATE_DETECTOR_VERSION = 'unsupported-1.0.0';

/**
 * Static capability constant consumed by the synchronous dispatch gate.
 * Flips only when a real, validated on-device plate detector lands.
 */
export const PLATE_DETECTION_SUPPORTED = false;

export function getCapabilities(): PlateDetectionCapabilities {
  return {
    supported: PLATE_DETECTION_SUPPORTED,
    detectorImplementation: 'unavailable',
    detectorVersion: PLATE_DETECTOR_VERSION,
  };
}

/**
 * Always returns a typed unsupported failure. Never inspects the input and
 * never returns fabricated regions.
 */
export async function detectPlates(_input: { imageUri: string }): Promise<PlateDetectionResult> {
  return {
    supported: false,
    performed: false,
    regionsDetected: 0,
    regionsAccepted: 0,
    confidence: [],
    boundingBoxes: [],
    durationMs: 0,
    failure: {
      code: 'PLATE_DETECTOR_UNAVAILABLE',
      reason:
        'On-device license-plate detection is not available in this build. The privacy gate remains closed.',
    },
  };
}
