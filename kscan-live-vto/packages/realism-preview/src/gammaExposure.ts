/**
 * Gamma/exposure adjustment — Phase 3 Section 13.
 *
 * Section 13 names four distinct output controls: "gain, gamma/exposure
 * adjustment, contrast adjustment, bounded color correction." The existing
 * `@kscan-live-vto/static-renderer`'s `lighting.ts` already implements gain,
 * contrast gain, and a bounded hue/saturation color correction
 * (`computeLightingAdjustment`/`applyLightingAdjustment`, guardrailed by
 * `LIGHTING_GUARDRAILS`, recorded in `PreviewManifest.lightingParameters`,
 * with `unadjustedImage` preserved). Gamma/exposure is the one control that
 * module does not implement: gain scales luminance proportionally, while a
 * gamma curve (`out = in^gamma`) reshapes the response curve, affecting
 * shadows and highlights differently from midtones. This module adds that
 * missing control as a separate, composable step -- it does not modify
 * `lighting.ts`, and a caller applies both in sequence.
 *
 * Same discipline as the existing module: guardrailed, never silent, and
 * explicitly "experimental, not product science."
 */

import { getPixel, setPixel, type LightingState, type RgbaImage } from '@kscan-live-vto/static-renderer';

export const GAMMA_EXPOSURE_GUARDRAILS = {
  minGamma: 0.88,
  maxGamma: 1.14,
} as const;

export interface GammaExposureAdjustment {
  gamma: number;
  clamped: boolean;
}

/**
 * Derives a gamma value from the same scene-luminance signal
 * `estimateLighting` already computes, using the identical "partial
 * correction toward the scene, not a full match" philosophy as the existing
 * module's luminance gain: a scene noticeably darker than the garment's own
 * rendered luminance nudges gamma below 1 (brightens shadows/midtones
 * without blowing out highlights); a brighter scene nudges it above 1.
 */
export function computeGammaExposureAdjustment(
  state: Pick<LightingState, 'meanLuminance'>,
  garmentMeanLuminance: number,
): GammaExposureAdjustment {
  const delta = state.meanLuminance - garmentMeanLuminance;
  // out = in^gamma brightens for gamma < 1 and darkens for gamma > 1 (for in
  // in (0,1)). A darker scene (delta < 0) should brighten, so gamma must
  // move BELOW 1 as delta goes negative -- i.e. gamma tracks delta directly,
  // not inversely.
  const raw = 1 + delta * 0.3;
  const gamma = Math.max(GAMMA_EXPOSURE_GUARDRAILS.minGamma, Math.min(GAMMA_EXPOSURE_GUARDRAILS.maxGamma, raw));
  return { gamma, clamped: gamma !== raw };
}

function channelGamma(value: number, gamma: number): number {
  const normalized = Math.max(0, value / 255);
  return Math.max(0, Math.min(255, Math.pow(normalized, gamma) * 255));
}

/** In-place, non-transparent pixels only -- mirrors
 *  `applyLightingAdjustment`'s own convention so the two compose
 *  predictably: apply the existing gain/contrast/hue step first, then this
 *  one, both on the same garment-layer clone, leaving `unadjustedImage`
 *  untouched exactly as today. */
export function applyGammaExposureAdjustment(layer: RgbaImage, adjustment: GammaExposureAdjustment): void {
  for (let y = 0; y < layer.height; y += 1) {
    for (let x = 0; x < layer.width; x += 1) {
      const px = getPixel(layer, x, y);
      if (px.a === 0) continue;
      setPixel(layer, x, y, {
        r: channelGamma(px.r, adjustment.gamma),
        g: channelGamma(px.g, adjustment.gamma),
        b: channelGamma(px.b, adjustment.gamma),
        a: px.a,
      });
    }
  }
}

/** Mean relative luminance (Rec. 709 weights) of non-transparent pixels
 *  only. A simple reference reading for `computeGammaExposureAdjustment`'s
 *  `garmentMeanLuminance` input -- independent of `estimateLighting`'s own
 *  torso-polygon sampling, which samples the PERSON image, not the garment
 *  layer. */
export function meanLuminanceOfOpaquePixels(image: RgbaImage): number {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const px = getPixel(image, x, y);
      if (px.a === 0) continue;
      sum += (0.2126 * px.r + 0.7152 * px.g + 0.0722 * px.b) / 255;
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}
