/**
 * Product fidelity checks — Phase 3 Sections 15, 18.
 *
 * Complements, rather than replaces, static-renderer's existing
 * `logoDistortion` geometric check (mirroring, aspect-ratio distortion):
 * this module checks COLOR fidelity specifically, since neither
 * `logoDistortion` nor `lighting.ts`'s own guardrails answer "did Phase 3's
 * own new post-processing (gamma/exposure, contact shadow) change what
 * color this product reads as."
 */

import { getPixel, type RgbaImage } from '@kscan-live-vto/static-renderer';

export interface SampledColor {
  r: number;
  g: number;
  b: number;
}

export function samplePixelColor(image: RgbaImage, x: number, y: number): SampledColor {
  const px = getPixel(image, x, y);
  return { r: px.r, g: px.g, b: px.b };
}

function rgbToHueDegrees({ r, g, b }: SampledColor): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0; // achromatic -- hue is undefined, treated as 0 rather than thrown
  let hue: number;
  if (max === rn) hue = ((gn - bn) / delta) % 6;
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  hue *= 60;
  return hue < 0 ? hue + 360 : hue;
}

/** Smallest angular distance between two colors' hues, in degrees, in
 *  [0,180]. Undefined-hue (achromatic) colors compare as hue 0 by
 *  convention -- see rgbToHueDegrees -- so this is not meaningful for two
 *  colors that are both very close to gray; callers comparing a garment's
 *  own known-chromatic reference pixel are unaffected. */
export function hueDeltaDegrees(a: SampledColor, b: SampledColor): number {
  const diff = Math.abs(rgbToHueDegrees(a) - rgbToHueDegrees(b));
  return Math.min(diff, 360 - diff);
}

/**
 * True when every channel of `after` is at least `minRatio` of the
 * corresponding channel in `before` -- a direct operationalization of
 * "reject any solution that visibly dirties light-colored garments": a
 * channel dropping well below its original value is exactly what reads as
 * dirtying, independent of hue math (which is unreliable near-white/gray,
 * exactly where "dirtying" is most visible to a human reviewer).
 */
export function preservesChannelBrightness(before: SampledColor, after: SampledColor, minRatio: number): boolean {
  const ratio = (b: number, a: number) => (b === 0 ? (a === 0 ? 1 : 0) : a / b);
  return (
    ratio(before.r, after.r) >= minRatio
    && ratio(before.g, after.g) >= minRatio
    && ratio(before.b, after.b) >= minRatio
  );
}
