import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
  NativeExtractionCapabilities,
  NativePersonDetectionResult,
} from './KScanPiiNative.types';

const SANITIZER_VERSION = 'native-face-mask-poc-1.0.0';
const EXTRACTOR_VERSION = 'native-person-regions-1.0.0';

function unsupportedCapabilities(): NativePrivacyCapabilities {
  return {
    supported: false,
    platform: 'ios', // web reports the least-capable platform identity for parity tests
    detectorImplementation: 'unavailable',
    acceptedUriSchemes: ['file'],
    acceptedMimeTypes: ['image/jpeg', 'image/png'],
    outputMimeType: 'image/png',
    maxWidth: 4096,
    maxHeight: 4096,
    maxPixels: 16777216,
    sanitizerVersion: SANITIZER_VERSION,
  };
}

function unsupportedResult(input?: NativeFaceMaskInput): NativeFaceMaskResult {
  return {
    status: 'unsupported',
    platform: 'ios',
    detectorImplementation: 'unavailable',
    detectorVersion: '',
    sanitizerVersion: SANITIZER_VERSION,
    facesDetected: 0,
    facesAccepted: 0,
    facesMasked: 0,
    regionsChanged: 0,
    regionsAlreadyRedacted: 0,
    pixelsChanged: false,
    warnings: ['Native module is unavailable on web.'],
    ...(input?.imageUri ? {} : { errorCode: 'INVALID_INPUT', failureReason: 'No image URI provided.' }),
  };
}

export default {
  getPrivacyCapabilities(): Promise<NativePrivacyCapabilities> {
    return Promise.resolve(unsupportedCapabilities());
  },
  detectAndMaskFaces(input: NativeFaceMaskInput): Promise<NativeFaceMaskResult> {
    return Promise.resolve(unsupportedResult(input));
  },
  cleanupSanitizedImage(uri: string): Promise<NativeCleanupResult> {
    return Promise.resolve({
      deleted: false,
      rejected: true,
      warnings: [`Native cleanup is unavailable on web: ${uri}`],
    });
  },

  // Build 2.5 Step 3. Web has no on-device pose runtime, and reporting
  // `unsupported` rather than an empty success is load-bearing: an empty
  // success would be shown to the user as "no person in this photo", blaming
  // their photograph for a missing capability.
  getExtractionCapabilities(): Promise<NativeExtractionCapabilities> {
    return Promise.resolve({
      personDetectionSupported: false,
      platform: 'ios',
      detectorImplementation: 'unavailable',
      segmentationMaskSupported: false,
      supportedLandmarks: [],
      maxWidth: 4096,
      maxHeight: 4096,
      maxPixels: 16777216,
      extractorVersion: EXTRACTOR_VERSION,
    });
  },

  detectPersonRegions(): Promise<NativePersonDetectionResult> {
    return Promise.resolve({
      status: 'unsupported',
      platform: 'ios',
      detectorImplementation: 'unavailable',
      detectorVersion: '',
      extractorVersion: EXTRACTOR_VERSION,
      persons: [],
      warnings: ['On-device person detection is unavailable on web.'],
    });
  },
};
