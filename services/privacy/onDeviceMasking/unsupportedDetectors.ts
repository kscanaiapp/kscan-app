import type { OnDevicePiiDetector, DetectionResult } from './types';

const FACE_VERSION = 'blocked-1.0.0';
const PLATE_VERSION = 'blocked-1.0.0';

/**
 * Explicitly unsupported face detector.
 *
 * This provider documents that real on-device face detection is not available
 * in this build. It never inspects an image and never claims to detect faces.
 */
export const unsupportedFaceDetector: OnDevicePiiDetector = {
  detectorVersion: FACE_VERSION,
  regionType: 'face',
  supported: false,

  async detect(): Promise<DetectionResult> {
    return {
      attempted: false,
      completed: false,
      supported: false,
      regions: [],
      warnings: [
        'On-device face detection is not supported in this build. A native detector is required for real face masking.',
      ],
    };
  },
};

/**
 * Explicitly unsupported license-plate detector.
 */
export const unsupportedLicensePlateDetector: OnDevicePiiDetector = {
  detectorVersion: PLATE_VERSION,
  regionType: 'license_plate',
  supported: false,

  async detect(): Promise<DetectionResult> {
    return {
      attempted: false,
      completed: false,
      supported: false,
      regions: [],
      warnings: [
        'On-device license-plate detection is not supported in this build. A native detector is required for real plate masking.',
      ],
    };
  },
};
