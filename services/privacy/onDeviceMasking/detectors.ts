import type { OnDevicePiiDetector, PiiRegionType, DetectionResult } from './types';

export { OnDevicePiiDetector, PiiRegionType, DetectionResult };

export function createEmptyDetectionResult(warnings: string[], supported = false): DetectionResult {
  return {
    attempted: false,
    completed: false,
    supported,
    regions: [],
    warnings,
  };
}
