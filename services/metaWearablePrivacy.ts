import { File } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { isLocalUri } from './metaWearablePrivacyGeometry';

export const META_WEARABLE_PRIVACY_POLICY_VERSION = 'kscan.privacy.mobile.v1';
const MAX_DIMENSION = 800;

/**
 * Capture provenance recorded in the privacy policy attached to a scan.
 *
 * This is an attestation, not a label: it states which camera actually took
 * the image. Reporting `phone_camera` for a photo taken by the glasses would
 * make the stored policy record false, so the caller must pass the real
 * source whenever it is not the phone.
 */
export type MetaWearableCaptureSource = 'phone_camera' | 'meta_glasses';

export type MetaWearablePrivacyResult = {
  sanitizedUri: string;
  width: number;
  height: number;
  faceCount: number;
  policy: {
    policyVersion: typeof META_WEARABLE_PRIVACY_POLICY_VERSION;
    sanitized: true;
    metadataStripped: true;
    faceDetectionCompleted: true;
    faceMaskApplied: boolean;
    rawUpload: false;
    source: MetaWearableCaptureSource;
  };
};

export class MetaWearablePrivacyError extends Error {
  readonly code: string;

  constructor(code: string) {
    super('The capture could not be prepared securely.');
    this.name = 'MetaWearablePrivacyError';
    this.code = code;
  }
}

function loadNativePrivacyModule(): { detectAndMaskFaces?: (input: { imageUri: string }) => Promise<any> } | null {
  try {
    // Keep the native boundary lazy: an older binary cannot upload when the
    // local module is absent, but it also must not crash while loading a screen.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('../modules/kscan-pii-native');
  } catch {
    return null;
  }
}

/**
 * Phone-side wearable privacy boundary. Every camera asset is reconstructed as
 * a bounded JPEG before local face detection. Detector, render, encode, or
 * verification failure throws; callers must never fall back to the raw URI.
 */
export async function sanitizeMetaWearableCapture(
  rawUri: string,
  dimensions?: { width?: number; height?: number },
  options?: { source?: MetaWearableCaptureSource },
): Promise<MetaWearablePrivacyResult> {
  if (!isLocalUri(rawUri)) throw new MetaWearablePrivacyError('PRIVACY_INPUT_INVALID');
  const sourceWidth = Number(dimensions?.width);
  const sourceHeight = Number(dimensions?.height);
  const actions = Number.isFinite(sourceWidth) && Number.isFinite(sourceHeight)
    && Math.max(sourceWidth, sourceHeight) > MAX_DIMENSION
    ? [{ resize: sourceWidth >= sourceHeight ? { width: MAX_DIMENSION } : { height: MAX_DIMENSION } }]
    : [];
  let normalized: ImageManipulator.ImageResult;
  try {
    normalized = await ImageManipulator.manipulateAsync(rawUri, actions, {
      compress: 0.86,
      format: ImageManipulator.SaveFormat.JPEG,
      base64: false,
    });
  } catch {
    throw new MetaWearablePrivacyError('PRIVACY_RECONSTRUCTION_FAILED');
  }
  if (!isLocalUri(normalized.uri) || normalized.width <= 0 || normalized.height <= 0
    || Math.max(normalized.width, normalized.height) > MAX_DIMENSION) {
    throw new MetaWearablePrivacyError('PRIVACY_RECONSTRUCTION_FAILED');
  }

  const native = loadNativePrivacyModule();
  if (!native?.detectAndMaskFaces) throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_FAILED');

  let masked: any;
  try {
    masked = await native.detectAndMaskFaces({ imageUri: normalized.uri });
  } catch {
    throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_FAILED');
  }
  if (!masked || typeof masked !== 'object') throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_OUTPUT_INVALID');

  const faceCount = Number(masked.facesDetected);
  if (!Number.isInteger(faceCount) || faceCount < 0) throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_OUTPUT_INVALID');

  let sanitizedUri: string;
  if (masked.status === 'no_faces') {
    // The reconstructed JPEG is already metadata-free. No-face is a successful
    // detector result, not a fallback from a failed detector.
    sanitizedUri = normalized.uri;
  } else if (masked.status === 'success'
    && isLocalUri(masked.sanitizedUri)
    && masked.inputWidth === normalized.width
    && masked.inputHeight === normalized.height
    && masked.outputWidth === normalized.width
    && masked.outputHeight === normalized.height
    && Number(masked.facesMasked) > 0) {
    sanitizedUri = masked.sanitizedUri;
  } else if (masked.status === 'failed' || masked.status === 'unsupported') {
    throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_FAILED');
  } else {
    throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_OUTPUT_INVALID');
  }

  return {
    sanitizedUri,
    width: normalized.width,
    height: normalized.height,
    faceCount,
    policy: {
      policyVersion: META_WEARABLE_PRIVACY_POLICY_VERSION,
      sanitized: true,
      metadataStripped: true,
      faceDetectionCompleted: true,
      faceMaskApplied: faceCount > 0,
      rawUpload: false,
      source: options?.source ?? 'phone_camera',
    },
  };
}

export function getMetaWearablePrivacyReadiness() {
  return {
    policyVersion: META_WEARABLE_PRIVACY_POLICY_VERSION,
    maxDimension: MAX_DIMENSION,
    detector: 'local-native-face-masker',
    maskMode: 'solid',
    failClosed: true,
  } as const;
}

export function removeMetaWearableLocalAsset(uri: string | null | undefined): void {
  if (!isLocalUri(uri)) return;
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch {
    // Best-effort local cleanup; no URI or native error is logged.
  }
}
