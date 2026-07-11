import type {
  NativeFaceMaskInput,
  NativeFaceMaskResult,
  NativePrivacyCapabilities,
  NativeCleanupResult,
} from './KScanPiiNative.types';

const SANITIZER_VERSION = 'native-face-mask-poc-1.0.0';

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
};
