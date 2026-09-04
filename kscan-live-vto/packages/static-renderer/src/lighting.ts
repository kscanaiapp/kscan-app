/**
 * Lighting baseline (Section 18) — deliberately narrow.
 *
 * Estimate scene luminance, contrast and an approximate color cast from the
 * person image, then apply a RESTRAINED adjustment to the garment layer so a
 * bright-scene garment does not sit on a dim person looking pasted on.
 *
 * GUARDRAILS, stated as experiment bounds and not as product science:
 *   - hue shift clamped to ±15°
 *   - saturation change clamped to ±20%
 *   - luminance gain clamped to a modest band
 * Every applied parameter is reported in the PreviewManifest, and every
 * review case renders BOTH an unadjusted and an adjusted image so a human can
 * see exactly what the adjustment did to the product's color. Protecting
 * product color matters more than matching the scene: a garment whose color
 * the customer cannot trust is worse than one that looks slightly pasted on.
 */

import { getPixel, luminanceOf, type Point, type Rgba, type RgbaImage } from './raster';

export interface LightingState {
  meanLuminance: number;
  /** Standard deviation of luminance over the sampled region, in [0,1]. */
  contrast: number;
  /** Per-channel mean normalized so the average channel is 1.0. >1 means that channel dominates. */
  colorCast: { r: number; g: number; b: number };
  sampledPixels: number;
}

/** Samples the torso quad only: the background is not where the garment goes. */
export function estimateLighting(person: RgbaImage, region: readonly Point[]): LightingState {
  let sumL = 0;
  let sumL2 = 0;
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of region) {
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }

  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(person.height - 1, Math.ceil(maxY)); y++) {
    for (let x = Math.max(0, Math.floor(minX)); x <= Math.min(person.width - 1, Math.ceil(maxX)); x++) {
      if (!pointInPolygon({ x: x + 0.5, y: y + 0.5 }, region)) continue;
      const px = getPixel(person, x, y);
      const l = luminanceOf(px);
      sumL += l;
      sumL2 += l * l;
      sumR += px.r;
      sumG += px.g;
      sumB += px.b;
      count += 1;
    }
  }

  if (count === 0) {
    return { meanLuminance: 0.5, contrast: 0, colorCast: { r: 1, g: 1, b: 1 }, sampledPixels: 0 };
  }

  const meanL = sumL / count;
  const variance = Math.max(0, sumL2 / count - meanL * meanL);
  const meanR = sumR / count;
  const meanG = sumG / count;
  const meanB = sumB / count;
  const meanChannel = (meanR + meanG + meanB) / 3 || 1;

  return {
    meanLuminance: meanL,
    contrast: Math.sqrt(variance),
    colorCast: { r: meanR / meanChannel, g: meanG / meanChannel, b: meanB / meanChannel },
    sampledPixels: count,
  };
}

export function pointInPolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i]!;
    const b = polygon[j]!;
    if (a.y > point.y !== b.y > point.y && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

export interface LightingAdjustment {
  luminanceGain: number;
  contrastGain: number;
  hueShiftDegrees: number;
  saturationScale: number;
  clampedFields: string[];
}

/** Experimental guardrails — see the module header. Not product science. */
export const LIGHTING_GUARDRAILS = {
  maxHueShiftDegrees: 15,
  maxSaturationDelta: 0.2,
  minLuminanceGain: 0.85,
  maxLuminanceGain: 1.15,
  minContrastGain: 0.9,
  maxContrastGain: 1.1,
} as const;

/**
 * Derives a restrained adjustment from the scene estimate.
 *
 * The reference point (0.5 luminance / neutral cast) is the assumption the
 * garment texture was authored under; the adjustment nudges the garment
 * toward the scene by a FRACTION of the difference, never all of it. Moving
 * all the way would make the garment take on the room's color, which is the
 * "destroyed garment color" failure Section 18 names.
 */
export function computeLightingAdjustment(state: LightingState): LightingAdjustment {
  const clampedFields: string[] = [];
  const clamp = (value: number, min: number, max: number, field: string): number => {
    if (value < min) {
      clampedFields.push(field);
      return min;
    }
    if (value > max) {
      clampedFields.push(field);
      return max;
    }
    return value;
  };

  // Only follow 40% of the way toward the scene's luminance.
  const rawLuminanceGain = 1 + (state.meanLuminance - 0.5) * 0.4;
  const rawContrastGain = 1 + (state.contrast - 0.18) * 0.5;

  // Color cast → a small hue rotation toward the dominant channel, and a
  // saturation nudge proportional to how far from neutral the scene is.
  const castStrength = Math.hypot(state.colorCast.r - 1, state.colorCast.b - 1);
  const hueDirection = state.colorCast.r >= state.colorCast.b ? 1 : -1;
  const rawHueShift = hueDirection * castStrength * 40;
  const rawSaturation = 1 - castStrength * 0.3;

  return {
    luminanceGain: clamp(rawLuminanceGain, LIGHTING_GUARDRAILS.minLuminanceGain, LIGHTING_GUARDRAILS.maxLuminanceGain, 'luminanceGain'),
    contrastGain: clamp(rawContrastGain, LIGHTING_GUARDRAILS.minContrastGain, LIGHTING_GUARDRAILS.maxContrastGain, 'contrastGain'),
    hueShiftDegrees: clamp(rawHueShift, -LIGHTING_GUARDRAILS.maxHueShiftDegrees, LIGHTING_GUARDRAILS.maxHueShiftDegrees, 'hueShiftDegrees'),
    saturationScale: clamp(
      rawSaturation,
      1 - LIGHTING_GUARDRAILS.maxSaturationDelta,
      1 + LIGHTING_GUARDRAILS.maxSaturationDelta,
      'saturationScale',
    ),
    clampedFields,
  };
}

function rgbToHsl(r: number, g: number, b: number): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) h = ((bn - rn) / d + 2) * 60;
  else h = ((rn - gn) / d + 4) * 60;
  return { h, s, l };
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const hue = ((h % 360) + 360) % 360;
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255 };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  const hk = hue / 360;
  return { r: channel(hk + 1 / 3) * 255, g: channel(hk) * 255, b: channel(hk - 1 / 3) * 255 };
}

export function adjustGarmentPixel(color: Rgba, adjustment: LightingAdjustment): Rgba {
  const { h, s, l } = rgbToHsl(color.r, color.g, color.b);
  const adjustedL = Math.min(1, Math.max(0, (l - 0.5) * adjustment.contrastGain + 0.5) * adjustment.luminanceGain);
  const adjustedS = Math.min(1, Math.max(0, s * adjustment.saturationScale));
  const { r, g, b } = hslToRgb(h + adjustment.hueShiftDegrees, adjustedS, Math.min(1, Math.max(0, adjustedL)));
  return { r, g, b, a: color.a };
}

/** Applies the adjustment in place to every non-transparent pixel of a layer. */
export function applyLightingAdjustment(layer: RgbaImage, adjustment: LightingAdjustment): void {
  for (let i = 0; i < layer.width * layer.height; i++) {
    const a = layer.data[i * 4 + 3]!;
    if (a === 0) continue;
    const adjusted = adjustGarmentPixel(
      { r: layer.data[i * 4]!, g: layer.data[i * 4 + 1]!, b: layer.data[i * 4 + 2]!, a },
      adjustment,
    );
    layer.data[i * 4] = adjusted.r;
    layer.data[i * 4 + 1] = adjusted.g;
    layer.data[i * 4 + 2] = adjusted.b;
  }
}
