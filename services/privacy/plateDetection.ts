// License-plate screening for the Zero-Knowledge privacy pipeline.
//
// Build 34 Track B B2A replaced the previous explicitly-unsupported stub with
// a real on-device implementation. The interface below is unchanged from that
// stub so existing consumers keep compiling; what changed is that the answers
// now come from the native engine instead of being hardcoded to "unavailable".
//
// WHAT THE DETECTOR ACTUALLY IS, stated plainly so nobody over-reads it:
// neither platform ships a first-party "license plate" model. Screening is
// on-device TEXT-REGION detection (Apple Vision VNDetectTextRectanglesRequest;
// Android bundled ML Kit text recognition, whose recognized characters are
// discarded and never read) followed by a plate-shaped GEOMETRY filter. It
// therefore screens for plate-LIKE regions, and it masks them. It is a
// screen, not a guarantee, and `no_plates` means "nothing plate-shaped was
// found", not "this image contains no plate".
//
// FAIL CLOSED EVERYWHERE. Absent capability, a native throw, a detector error,
// a masking error and an unverifiable output all resolve to a failure result.
// No path returns the unmasked input as though it were screened.

import {
  detectAndMaskPlatesLocal,
  isNativePlateEngineLinked,
} from './nativePlateEngine';

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
  /** Regions actually obscured in the returned artifact. */
  regionsMasked: number;
  confidence: number[];
  boundingBoxes: PlateBoundingBox[];
  durationMs: number;
  /**
   * The plate-masked artifact. Present only when masking produced and verified
   * a new output; absent on `no_plates` (nothing to change) and on failure.
   */
  maskedUri?: string;
  failure?: PlateDetectionFailure;
}

const PLATE_DETECTOR_VERSION = 'native-plate-screen-1.0.0';

/**
 * Whether this binary can screen for plates at all.
 *
 * Now a function of real native linkage rather than a hardcoded false. It is
 * false in every Node/test/web context (no native module), which keeps the
 * dispatch gate closed exactly as before outside a real device build.
 */
export function isPlateDetectionSupported(): boolean {
  return isNativePlateEngineLinked();
}

/**
 * Back-compatible constant for consumers that read a static flag.
 *
 * DEPRECATED IN FAVOUR OF isPlateDetectionSupported(). A module-load-time
 * constant cannot observe native linkage reliably, so this is evaluated once
 * and kept only so existing imports do not break. New code must call the
 * function.
 */
export const PLATE_DETECTION_SUPPORTED = isPlateDetectionSupported();

export function getCapabilities(): PlateDetectionCapabilities {
  const supported = isPlateDetectionSupported();
  return {
    supported,
    detectorImplementation: supported ? 'native_text_region_geometry' : 'unavailable',
    detectorVersion: PLATE_DETECTOR_VERSION,
  };
}

function unsupported(reason: string): PlateDetectionResult {
  return {
    supported: false,
    performed: false,
    regionsDetected: 0,
    regionsAccepted: 0,
    regionsMasked: 0,
    confidence: [],
    boundingBoxes: [],
    durationMs: 0,
    failure: { code: 'PLATE_DETECTOR_UNAVAILABLE', reason },
  };
}

function failed(reason: string, durationMs = 0): PlateDetectionResult {
  return {
    supported: true,
    performed: false,
    regionsDetected: 0,
    regionsAccepted: 0,
    regionsMasked: 0,
    confidence: [],
    boundingBoxes: [],
    durationMs,
    failure: { code: 'PLATE_DETECTION_FAILED', reason },
  };
}

/**
 * Screen for plate-shaped regions and mask any that are found.
 *
 * Input must already be the face-sanitized artifact: this stage masks into it,
 * so running it on the raw original would discard the face masking.
 *
 * Never fabricates detections and never returns the input as a masked output.
 */
export async function detectPlates(input: { imageUri: string }): Promise<PlateDetectionResult> {
  if (!input?.imageUri || typeof input.imageUri !== 'string') {
    return {
      supported: isPlateDetectionSupported(),
      performed: false,
      regionsDetected: 0,
      regionsAccepted: 0,
      regionsMasked: 0,
      confidence: [],
      boundingBoxes: [],
      durationMs: 0,
      failure: { code: 'INVALID_INPUT', reason: 'Missing or invalid imageUri.' },
    };
  }

  if (!isPlateDetectionSupported()) {
    return unsupported(
      'On-device license-plate screening is not available in this binary. The privacy gate remains closed.',
    );
  }

  const native = await detectAndMaskPlatesLocal({ imageUri: input.imageUri });
  if (!native) {
    return unsupported('The native plate-screening capability is not linked in this binary.');
  }

  const durationMs = native.totalDurationMs ?? native.detectionDurationMs ?? 0;

  if (native.status === 'failed' || native.status === 'unsupported') {
    return failed(
      `${native.errorCode ?? 'UNKNOWN'}: ${native.failureReason ?? 'Plate screening did not complete.'}`,
      durationMs,
    );
  }

  // A completed screen that masked something must have produced a verified
  // artifact; a masked run without an output URI is incoherent, so refuse it
  // rather than let a caller assume the input was masked in place.
  if (native.status === 'success' && !native.sanitizedUri) {
    return failed('Plate masking reported success without a verified output.', durationMs);
  }

  return {
    supported: true,
    performed: true,
    regionsDetected: native.platesDetected,
    regionsAccepted: native.platesAccepted,
    regionsMasked: native.platesMasked,
    // Region geometry only: the engine reports no per-region confidence, and
    // fabricating one here would be inventing evidence.
    confidence: [],
    boundingBoxes: [],
    durationMs,
    maskedUri: native.status === 'success' ? native.sanitizedUri : undefined,
  };
}
