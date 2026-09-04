/**
 * Contact + collar shadow cues — Phase 3 Section 14.
 *
 * Inexpensive visual-depth approximations only -- explicitly NOT physically
 * accurate shadows, NOT real scene-light estimation, NOT cloth simulation.
 * Operates on the COMPOSITED output image, never the garment layer's own
 * alpha channel, and by multiplicative darkening only: a light-colored
 * garment's own pixels are dimmed proportionally rather than mixed with an
 * additive gray/black overlay, which is what would actually "visibly dirty"
 * it. `SHADOW_GUARDRAILS.maxIntensity` bounds how far even a fully-inside
 * pixel can be darkened.
 */

import { getPixel, setPixel, type RgbaImage } from '@kscan-live-vto/static-renderer';

export interface ShadowRegion {
  /** Axis-aligned rect in image pixel space. Approximate by construction --
   *  a caller derives this from geometry already available to the renderer
   *  (e.g. `RigidStageResult.anchors`' shoulder points), not from any new
   *  body-geometry model. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** [0,1] before clamping. Fraction of luminance removed at the region's
   *  center, before feathering. */
  intensity: number;
}

export const SHADOW_GUARDRAILS = {
  /** Never darken more than this fraction of a pixel's own luminance --
   *  bounded specifically so a light garment pixel reads as "very subtly
   *  shaded," never "dirtied." */
  maxIntensity: 0.14,
  /** Feather fraction of the region's own half-extent: the outer 40% of the
   *  region tapers to zero rather than ending in a hard edge. */
  featherFraction: 0.4,
} as const;

function clampIntensity(intensity: number): number {
  return Math.max(0, Math.min(SHADOW_GUARDRAILS.maxIntensity, intensity));
}

/** Falloff weight in [0,1] for normalized region-local coordinates (u,v) in
 *  [-1,1]x[-1,1], 1 at the region center, tapering to 0 at and beyond the
 *  feathered edge. Chebyshev distance, matching a rectangular region's own
 *  shape rather than an unrelated circular one. */
function falloff(u: number, v: number): number {
  const d = Math.max(Math.abs(u), Math.abs(v));
  const edge = 1 - SHADOW_GUARDRAILS.featherFraction;
  if (d <= edge) return 1;
  if (d >= 1) return 0;
  return 1 - (d - edge) / (1 - edge);
}

/** Applies one shadow region in place. Never paints onto a fully
 *  transparent pixel (nothing to shade behind the garment/background
 *  boundary), and never increases a pixel's alpha -- this function only
 *  ever darkens color channels. */
export function applyContactShadow(image: RgbaImage, region: ShadowRegion): void {
  const intensity = clampIntensity(region.intensity);
  if (intensity <= 0 || region.w <= 0 || region.h <= 0) return;
  const x0 = Math.max(0, Math.floor(region.x));
  const y0 = Math.max(0, Math.floor(region.y));
  const x1 = Math.min(image.width, Math.ceil(region.x + region.w));
  const y1 = Math.min(image.height, Math.ceil(region.y + region.h));
  for (let y = y0; y < y1; y += 1) {
    const v = ((y - region.y) / region.h) * 2 - 1;
    for (let x = x0; x < x1; x += 1) {
      const u = ((x - region.x) / region.w) * 2 - 1;
      const weight = falloff(u, v);
      if (weight <= 0) continue;
      const px = getPixel(image, x, y);
      if (px.a === 0) continue;
      const factor = 1 - intensity * weight;
      setPixel(image, x, y, { r: px.r * factor, g: px.g * factor, b: px.b * factor, a: px.a });
    }
  }
}

export function applyContactShadows(image: RgbaImage, regions: readonly ShadowRegion[]): void {
  for (const region of regions) applyContactShadow(image, region);
}

/**
 * Standard approximate regions for a torso-region render: a thin band just
 * below the collar/neckline, and a small patch at each shoulder outer edge
 * -- expressed as fractions of the garment's own shoulder-span bounding box
 * so a caller only needs to supply that one measurement (already available
 * from `RigidStageResult.anchors` without any new geometry model).
 */
export function standardCollarAndShoulderShadowRegions(shoulderSpan: {
  leftX: number;
  rightX: number;
  topY: number;
}): ShadowRegion[] {
  const span = shoulderSpan.rightX - shoulderSpan.leftX;
  const collarWidth = span * 0.34;
  const collarHeight = Math.max(2, span * 0.05);
  return [
    {
      x: shoulderSpan.leftX + span / 2 - collarWidth / 2,
      y: shoulderSpan.topY,
      w: collarWidth,
      h: collarHeight,
      intensity: 0.1,
    },
    { x: shoulderSpan.leftX, y: shoulderSpan.topY, w: span * 0.12, h: span * 0.06, intensity: 0.07 },
    { x: shoulderSpan.rightX - span * 0.12, y: shoulderSpan.topY, w: span * 0.12, h: span * 0.06, intensity: 0.07 },
  ];
}
