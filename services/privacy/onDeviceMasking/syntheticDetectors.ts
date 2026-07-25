import type { OnDevicePiiDetector, DetectionResult, DetectedPiiRegion, PiiRegionType } from './types';

export interface SyntheticDetectorOptions {
  detectorVersion?: string;
  regions?: DetectedPiiRegion[];
  shouldThrow?: boolean;
}

function createSyntheticDetector(
  regionType: PiiRegionType,
  defaultVersion: string,
): (options?: SyntheticDetectorOptions) => OnDevicePiiDetector {
  return (options = {}) => {
    const detectorVersion = options.detectorVersion ?? defaultVersion;
    const suppliedRegions = options.regions ?? [];
    const shouldThrow = options.shouldThrow ?? false;

    return {
      detectorVersion,
      regionType,
      supported: false, // Synthetic detectors are explicitly not real detection.

      async detect(): Promise<DetectionResult> {
        if (shouldThrow) {
          throw new Error(`Synthetic ${regionType} detector forced failure for testing.`);
        }

        const regions = suppliedRegions.filter((r) => r.type === regionType);
        return {
          attempted: true,
          completed: true,
          supported: false,
          regions,
          warnings: [
            `This is a synthetic ${regionType} detector for pipeline testing only. No real image analysis was performed.`,
          ],
          durationMs: 0,
        };
      },
    };
  };
}

/**
 * Synthetic face detector for deterministic pipeline tests only.
 * Does not inspect any image. Does not perform real face detection.
 */
export const syntheticFaceDetector = createSyntheticDetector('face', 'synthetic-face-1.0.0');

/**
 * Synthetic license-plate detector for deterministic pipeline tests only.
 * Does not inspect any image. Does not perform real plate detection.
 */
export const syntheticLicensePlateDetector = createSyntheticDetector('license_plate', 'synthetic-plate-1.0.0');
