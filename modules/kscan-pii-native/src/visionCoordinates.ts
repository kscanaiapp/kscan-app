// Apple Vision → K Scan coordinate conversion: the SPECIFICATION.
//
// ── WHAT THIS FILE IS ───────────────────────────────────────────────────────
//
// The executable statement of a conversion that actually runs in Swift, inside
// IOSPersonDetector. It exists because the conversion is one line of arithmetic
// that is very easy to get wrong, very easy to apply twice, and — when wrong —
// produces a failure that looks like a broken detector rather than a flipped
// axis: every garment region lands upside down on the body.
//
// So the rule is written down once, here, in a form a test can execute without
// a Mac; both implementations are then checked against the SAME vector file,
// `test-vectors/vision-coordinate-parity.json`:
//
//   Node   __tests__/mirrorIosVisionParity.test.js       (runs today)
//   Swift  ios/Tests/VisionCoordinateParityTests.swift   (runs under Xcode)
//
// ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
//
// It is NOT on the runtime path. The pipeline never calls it: coordinates cross
// the bridge already converted. Calling it on a native result would apply the
// flip a second time, which is the exact bug it exists to prevent.

/** Vision's convention: origin bottom-left, y increasing upward. */
export type VisionRect = { x: number; y: number; width: number; height: number };

/** K Scan's convention: origin top-left, y increasing downward. */
export type TopLeftRect = { x: number; y: number; width: number; height: number };

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Flip a Vision rect into top-left space.
 *
 * `top = 1 - y - height` is the whole conversion. Everything else is clamping.
 *
 * CLAMPING KEEPS THE PERSON. Vision routinely returns a box that runs past the
 * frame — a mirror selfie cut off at the thigh is the single most common real
 * input this feature has. The EDGES are clamped and the detection is kept;
 * rejecting an overflowing box would reject the normal case.
 *
 * Returns null only for a rect with no area, which is not a person.
 */
export function visionRectToTopLeft(rect: VisionRect): TopLeftRect | null {
  // CLAMP THE EDGES, THEN MEASURE — never clamp an origin and keep the raw
  // extent. A box overflowing the TOP of the frame has a negative top edge; if
  // the top is clamped to 0 while the height is kept, the region is not clipped
  // but SLID DOWN the body by the amount that overflowed, and a head-cropped
  // subject's "upper body" lands on their waist.
  //
  // This is exactly how the Android half already builds its rects
  // (NormalizedRect.fromPixels), which is what makes the two platforms agree.
  const left = clamp01(Number(rect?.x));
  const right = clamp01(Number(rect?.x) + Number(rect?.width));
  const top = clamp01(1 - Number(rect?.y) - Number(rect?.height));
  const bottom = clamp01(1 - Number(rect?.y));
  const width = right - left;
  const height = bottom - top;
  if (!(width > 0) || !(height > 0)) return null;
  return { x: left, y: top, width, height };
}

/**
 * Flip a Vision point into top-left space.
 *
 * `x` IS DELIBERATELY UNTOUCHED. A front-camera capture is already mirrored in
 * PIXELS before this module ever sees it — mirrorSourcePreparation re-encodes
 * the picker's asset — so mirroring x here would flip an already-flipped image
 * and put the user's left shoulder on their right.
 */
export function visionPointToTopLeft(point: { x: number; y: number }): { x: number; y: number } {
  return { x: clamp01(point?.x), y: clamp01(1 - Number(point?.y)) };
}
