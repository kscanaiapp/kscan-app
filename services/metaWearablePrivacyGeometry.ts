// Pure, native-module-free logic extracted from metaWearablePrivacy.ts so it
// can be unit tested with plain `node --test` (this repo has no Jest/native-
// module-mocking harness). Everything else in that file touches Skia,
// ML-Kit, or expo-file-system and can only be meaningfully exercised on a
// device/emulator.

export type FaceFrame = { left: number; top: number; width: number; height: number };
export type MaskRect = { x: number; y: number; width: number; height: number };

export const MASK_MARGIN_X = 0.16;
export const MASK_MARGIN_UP = 0.2;
export const MASK_MARGIN_DOWN = 0.1;

export function isLocalUri(uri: unknown): uri is string {
  return typeof uri === 'string' && /^(?:file|content):\/\//iu.test(uri);
}

/**
 * Validates a detector-reported face frame against the image's own bounds.
 * A frame with non-finite coordinates, non-positive size, or that extends
 * meaningfully outside the source image is rejected — this is the guard
 * that keeps a malformed or adversarial detector response from producing a
 * garbage mask (or none at all) rather than blocking the capture.
 */
export function validateFrame(value: unknown, width: number, height: number): FaceFrame | null {
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

/**
 * Computes the (clamped, margin-expanded) mask rectangle for one validated
 * face frame. Margins are asymmetric — more headroom above than below —
 * because a detector's face box typically excludes hair/forehead, which
 * would otherwise stay unmasked.
 */
export function computeMaskRect(frame: FaceFrame, width: number, height: number): MaskRect {
  const x = Math.max(0, frame.left - frame.width * MASK_MARGIN_X);
  const y = Math.max(0, frame.top - frame.height * MASK_MARGIN_UP);
  const right = Math.min(width, frame.left + frame.width * (1 + MASK_MARGIN_X));
  const bottom = Math.min(height, frame.top + frame.height * (1 + MASK_MARGIN_DOWN));
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) };
}
