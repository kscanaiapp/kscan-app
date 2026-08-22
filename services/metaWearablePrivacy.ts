import FaceDetection from '@react-native-ml-kit/face-detection';
import { Directory, File, Paths } from 'expo-file-system';
import * as ImageManipulator from 'expo-image-manipulator';
import { ImageFormat, Skia } from '@shopify/react-native-skia';

export const META_WEARABLE_PRIVACY_POLICY_VERSION = 'kscan.privacy.mobile.v1';
const MAX_DIMENSION = 800;
const JPEG_QUALITY = 82;
const MASK_MARGIN_X = 0.16;
const MASK_MARGIN_UP = 0.2;
const MASK_MARGIN_DOWN = 0.1;

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
    source: 'phone_camera';
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

type FaceFrame = { left: number; top: number; width: number; height: number };

function isLocalUri(uri: unknown): uri is string {
  return typeof uri === 'string' && /^(?:file|content):\/\//iu.test(uri);
}

function validateFrame(value: unknown, width: number, height: number): FaceFrame | null {
  if (!value || typeof value !== 'object') return null;
  const frame = value as Record<string, unknown>;
  const left = Number(frame.left);
  const top = Number(frame.top);
  const faceWidth = Number(frame.width);
  const faceHeight = Number(frame.height);
  if (![left, top, faceWidth, faceHeight].every(Number.isFinite) || faceWidth <= 0 || faceHeight <= 0) return null;
  if (left < -1 || top < -1 || left + faceWidth > width + 1 || top + faceHeight > height + 1) return null;
  return { left, top, width: faceWidth, height: faceHeight };
}

function maskRect(frame: FaceFrame, width: number, height: number) {
  const x = Math.max(0, frame.left - frame.width * MASK_MARGIN_X);
  const y = Math.max(0, frame.top - frame.height * MASK_MARGIN_UP);
  const right = Math.min(width, frame.left + frame.width * (1 + MASK_MARGIN_X));
  const bottom = Math.min(height, frame.top + frame.height * (1 + MASK_MARGIN_DOWN));
  return Skia.XYWHRect(x, y, Math.max(1, right - x), Math.max(1, bottom - y));
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
      source: 'phone_camera',
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
