/**
 * Static compositor (Sections 15, 17).
 *
 * Layer order, and the whole point of this module:
 *
 *   person image  →  virtual garment  →  real foreground limbs/hair  →  (UI)
 *
 * The third layer is what makes an arm crossing the torso look like an arm in
 * front of a shirt rather than a shirt painted over an arm. It is produced
 * here by re-blending the ORIGINAL person pixels back over the composite,
 * weighted by a feathered foreground mask.
 *
 * SEGMENTATION HONESTY (Section 16). This module composites whatever mask it
 * is handed; it does not produce one. When the mask is a fixture mask, the
 * manifest says `maskProvenance: 'precomputed'` and the review package says
 * "SEGMENTATION ENGINE: NOT YET IMPLEMENTED — PRECOMPUTED TEST MASK". What is
 * proven here is that the compositor can express the correct result once a
 * real segmentation engine exists — nothing about automatic segmentation.
 */

import { blendPixel, cloneImage, getPixel, type RgbaImage } from './raster';

export type MaskProvenance = 'precomputed' | 'generated' | 'none';

export interface FeatherSpec {
  /**
   * Feather radius as a fraction of the body's shoulder span, so the softness
   * of an edge is the same *relative to the person* at any resolution.
   * Resolution-specific pixel constants are exactly what Section 15 asks to
   * avoid.
   */
  radiusShoulderSpanFraction: number;
  /** The resolved pixel radius actually used, reported in the manifest. */
  resolvedRadiusPx: number;
}

export const DEFAULT_FEATHER_FRACTION = 0.012;

export function resolveFeather(shoulderSpanPx: number, fraction = DEFAULT_FEATHER_FRACTION): FeatherSpec {
  return {
    radiusShoulderSpanFraction: fraction,
    // Below 1px there is nothing to feather; above that, round to whole
    // pixels so the box blur below is exactly reproducible.
    resolvedRadiusPx: Math.max(1, Math.round(shoulderSpanPx * fraction)),
  };
}

/**
 * Separable box blur of the mask's alpha channel, run twice.
 *
 * Two box passes approximate a triangular kernel, which is enough softness to
 * kill a hard stair-step edge without the "aggressive blur to bury a bad
 * mask" that Section 15 warns against — at the default radius this is a
 * couple of pixels on a 720px-wide frame, and the ragged fixture-mask edges
 * remain visibly ragged underneath it. That is deliberate: the compositor
 * should not be able to disguise mask quality.
 */
export function featherMaskAlpha(mask: RgbaImage, radiusPx: number): Float32Array {
  const { width, height } = mask;
  let current = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) current[i] = mask.data[i * 4 + 3]! / 255;

  const horizontal = (src: Float32Array) => {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dx = -radiusPx; dx <= radiusPx; dx++) {
          const sx = x + dx;
          if (sx < 0 || sx >= width) continue;
          sum += src[y * width + sx]!;
          count += 1;
        }
        out[y * width + x] = count > 0 ? sum / count : 0;
      }
    }
    return out;
  };

  const vertical = (src: Float32Array) => {
    const out = new Float32Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let sum = 0;
        let count = 0;
        for (let dy = -radiusPx; dy <= radiusPx; dy++) {
          const sy = y + dy;
          if (sy < 0 || sy >= height) continue;
          sum += src[sy * width + x]!;
          count += 1;
        }
        out[y * width + x] = count > 0 ? sum / count : 0;
      }
    }
    return out;
  };

  current = vertical(horizontal(current));
  current = vertical(horizontal(current));
  return current;
}

export interface CompositeOptions {
  /** When false, the foreground layer is skipped entirely — the Section 17 CONTROL image. */
  restoreForeground: boolean;
  feather: FeatherSpec;
}

export interface CompositeResult {
  image: RgbaImage;
  /** Pixels where the foreground layer actually overrode garment pixels. */
  foregroundOverGarmentPixels: number;
}

export function compositeStaticPreview(
  person: RgbaImage,
  garmentLayer: RgbaImage,
  foregroundMask: RgbaImage | null,
  options: CompositeOptions,
): CompositeResult {
  const out = cloneImage(person);
  const { width, height } = person;

  // Layer 2: the virtual garment over the person.
  const garmentAlpha = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = getPixel(garmentLayer, x, y);
      garmentAlpha[y * width + x] = g.a / 255;
      if (g.a > 0) blendPixel(out, x, y, g);
    }
  }

  // Layer 3: real foreground limbs back over the garment.
  let foregroundOverGarmentPixels = 0;
  if (options.restoreForeground && foregroundMask) {
    const feathered = featherMaskAlpha(foregroundMask, options.feather.resolvedRadiusPx);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const weight = feathered[y * width + x]!;
        if (weight <= 0.002) continue;
        const original = getPixel(person, x, y);
        blendPixel(out, x, y, { ...original, a: original.a * weight });
        if (garmentAlpha[y * width + x]! > 0.5 && weight > 0.5) foregroundOverGarmentPixels += 1;
      }
    }
  }

  return { image: out, foregroundOverGarmentPixels };
}
