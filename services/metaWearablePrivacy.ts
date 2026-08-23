import FaceDetection from '@react-native-ml-kit/face-detection';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { ImageFormat, Skia } from '@shopify/react-native-skia';
import { computeMaskRect, isLocalUri, validateFrame, type FaceFrame } from './metaWearablePrivacyGeometry';

export const META_WEARABLE_PRIVACY_POLICY_VERSION = 'kscan.privacy.mobile.v1';
const MAX_DIMENSION = 800;
const JPEG_QUALITY = 82;

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

function maskRect(frame: FaceFrame, width: number, height: number) {
  const rect = computeMaskRect(frame, width, height);
  return Skia.XYWHRect(rect.x, rect.y, rect.width, rect.height);
}

async function decode(uri: string) {
  const data = await Skia.Data.fromURI(uri);
  const image = Skia.Image.MakeImageFromEncoded(data);
  if (!image) throw new MetaWearablePrivacyError('PRIVACY_DECODE_FAILED');
  return image;
}

async function renderMasks(uri: string, width: number, height: number, frames: FaceFrame[]): Promise<string> {
  const source = await decode(uri);
  if (source.width() !== width || source.height() !== height) throw new MetaWearablePrivacyError('PRIVACY_DIMENSIONS_INVALID');
  const surface = Skia.Surface.MakeOffscreen(width, height);
  if (!surface) throw new MetaWearablePrivacyError('PRIVACY_RENDER_UNAVAILABLE');
  const canvas = surface.getCanvas();
  const full = Skia.XYWHRect(0, 0, width, height);
  const imagePaint = Skia.Paint();
  imagePaint.setAntiAlias(true);
  canvas.drawImageRect(source, full, full, imagePaint, false);
  const maskPaint = Skia.Paint();
  maskPaint.setAntiAlias(false);
  maskPaint.setColor(Skia.Color('#000000'));
  for (const frame of frames) canvas.drawRect(maskRect(frame, width, height), maskPaint);
  surface.flush();
  const bytes = surface.makeImageSnapshot().encodeToBytes(ImageFormat.JPEG, JPEG_QUALITY);
  if (!bytes?.length) throw new MetaWearablePrivacyError('PRIVACY_ENCODE_FAILED');
  const directory = new Directory(Paths.cache, 'meta-wearable', 'sanitized');
  directory.create({ idempotent: true, intermediates: true });
  const target = new File(directory, `${globalThis.crypto?.randomUUID?.() ?? Date.now().toString(36)}.jpg`);
  target.write(bytes);
  const info = target.info();
  if (!info.exists || !info.size) throw new MetaWearablePrivacyError('PRIVACY_OUTPUT_INVALID');
  const verified = await decode(target.uri);
  if (verified.width() !== width || verified.height() !== height) {
    if (target.exists) target.delete();
    throw new MetaWearablePrivacyError('PRIVACY_OUTPUT_INVALID');
  }
  return target.uri;
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

  let detected: unknown;
  try {
    detected = await FaceDetection.detect(normalized.uri, {
      performanceMode: 'accurate',
      landmarkMode: 'none',
      contourMode: 'none',
      classificationMode: 'none',
      minFaceSize: 0.1,
      trackingEnabled: false,
    });
  } catch {
    throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_FAILED');
  }
  if (!Array.isArray(detected)) throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_OUTPUT_INVALID');
  const frames = detected.map((face) => validateFrame((face as { frame?: unknown })?.frame, normalized.width, normalized.height));
  if (frames.some((frame) => frame === null)) throw new MetaWearablePrivacyError('PRIVACY_DETECTOR_OUTPUT_INVALID');
  const validFrames = frames as FaceFrame[];
  const sanitizedUri = validFrames.length
    ? await renderMasks(normalized.uri, normalized.width, normalized.height, validFrames)
    : normalized.uri;
  return {
    sanitizedUri,
    width: normalized.width,
    height: normalized.height,
    faceCount: validFrames.length,
    policy: {
      policyVersion: META_WEARABLE_PRIVACY_POLICY_VERSION,
      sanitized: true,
      metadataStripped: true,
      faceDetectionCompleted: true,
      faceMaskApplied: validFrames.length > 0,
      rawUpload: false,
      source: options?.source ?? 'phone_camera',
    },
  };
}

export function getMetaWearablePrivacyReadiness() {
  return {
    policyVersion: META_WEARABLE_PRIVACY_POLICY_VERSION,
    maxDimension: MAX_DIMENSION,
    detector: 'ml-kit-face-detection',
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
