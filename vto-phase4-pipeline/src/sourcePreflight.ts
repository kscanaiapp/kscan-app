import { computeForegroundMask, computeSkinRatio, estimateBackgroundColor } from './background';
import { labelConnectedComponents, largestComponent } from './components';
import { colorDistance, getPixel, type RgbaImage } from './pixels';

/**
 * Phase 4.2 §25: richer source diagnostics, measured BEFORE any accept or
 * reject decision. Phase 4.1 could say only "resolution was ADEQUATE" —
 * which was true for all four original EASY failures and therefore
 * explained none of them.
 *
 * Everything here is a MEASUREMENT, not a gate. Nothing in this module
 * rejects, normalizes, or reclassifies anything; §26 requires that any
 * threshold derived from these numbers be justified by observed evidence
 * first. Estimated quantities are named `...Proxy` so no reader mistakes a
 * heuristic for ground truth (§16).
 */

/** Area fraction at/above which a connected component is "significant" — same constant the shot classifier already uses, deliberately not a second number. */
export const SIGNIFICANT_COMPONENT_AREA_FRACTION = 0.01;

export interface PaddingEvidence {
  /** Fraction of the image height/width that is uniform-background margin on each side. */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** Max minus min of the four fractions — 0 means perfectly symmetric padding. */
  asymmetry: number;
  /** Total fraction of image area that is uniform-background margin. */
  totalFraction: number;
}

export interface SourcePreflight {
  width: number;
  height: number;
  shortSidePx: number;
  longSidePx: number;
  aspectRatio: number;

  backgroundUniformity: number;
  backgroundColor: [number, number, number];
  /** True when the background is near-white/off-white — the padded-thumbnail signature (§27). */
  backgroundIsNearWhite: boolean;

  /** Fraction of pixels differing from the estimated background colour. */
  foregroundCoverage: number;
  /** EVERY connected foreground component, including single-pixel compression speckle. */
  totalComponentCount: number;
  /** Components at/above `SIGNIFICANT_COMPONENT_AREA_FRACTION` of image area. */
  significantComponentCount: number;
  /** Largest component size / total foreground size. */
  largestComponentRatio: number;
  /** Largest component's bounding-box area / image area. */
  garmentOccupancy: number;
  /** How many of the 4 image edges the largest component touches (crop-completeness proxy). */
  borderContactEdges: number;

  padding: PaddingEvidence;

  /** Population stddev of luma across the whole image, 0-255. */
  contrast: number;
  /** Mean absolute gradient magnitude, normalized to [0,1]. Higher = sharper. A PROXY, not a focus measure. */
  sharpnessProxy: number;
  /** Coarse RGB skin-tone fraction within the foreground mask. A PROXY, not a person detector. */
  skinRatioProxy: number;
}

function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Counts leading rows/columns from each edge whose pixels all sit within `tolerance` of the background colour. */
function measurePadding(img: RgbaImage, bg: [number, number, number], tolerance: number): PaddingEvidence {
  const rowIsBackground = (y: number): boolean => {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b] = getPixel(img, x, y);
      if (colorDistance([r, g, b], bg) > tolerance) return false;
    }
    return true;
  };
  const colIsBackground = (x: number): boolean => {
    for (let y = 0; y < img.height; y++) {
      const [r, g, b] = getPixel(img, x, y);
      if (colorDistance([r, g, b], bg) > tolerance) return false;
    }
    return true;
  };

  let top = 0;
  while (top < img.height && rowIsBackground(top)) top++;
  let bottom = 0;
  while (bottom < img.height - top && rowIsBackground(img.height - 1 - bottom)) bottom++;
  let left = 0;
  while (left < img.width && colIsBackground(left)) left++;
  let right = 0;
  while (right < img.width - left && colIsBackground(img.width - 1 - right)) right++;

  const t = top / img.height;
  const b = bottom / img.height;
  const l = left / img.width;
  const r = right / img.width;
  const fractions = [t, b, l, r];
  const innerW = Math.max(0, img.width - left - right);
  const innerH = Math.max(0, img.height - top - bottom);
  const totalFraction = 1 - (innerW * innerH) / (img.width * img.height);

  return {
    top: round(t),
    bottom: round(b),
    left: round(l),
    right: round(r),
    asymmetry: round(Math.max(...fractions) - Math.min(...fractions)),
    totalFraction: round(totalFraction),
  };
}

export function computeSourcePreflight(img: RgbaImage): SourcePreflight {
  const bg = estimateBackgroundColor(img);
  const mask = computeForegroundMask(img, bg);
  const totalPixels = img.width * img.height;

  let foregroundCount = 0;
  for (let i = 0; i < mask.length; i++) foregroundCount += mask[i];

  const { components } = labelConnectedComponents(mask, img.width, img.height);
  const significant = components.filter((c) => c.size / totalPixels >= SIGNIFICANT_COMPONENT_AREA_FRACTION);
  const largest = largestComponent(components);

  const largestRatio = largest ? largest.size / Math.max(1, foregroundCount) : 0;
  const occupancy = largest
    ? ((largest.maxX - largest.minX + 1) * (largest.maxY - largest.minY + 1)) / totalPixels
    : 0;
  const borderContactEdges = largest
    ? [largest.minY <= 1, largest.maxY >= img.height - 2, largest.minX <= 1, largest.maxX >= img.width - 2].filter(Boolean).length
    : 0;

  // Contrast: population stddev of luma.
  let sum = 0;
  for (let i = 0; i < totalPixels; i++) sum += luma(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
  const mean = sum / totalPixels;
  let varSum = 0;
  for (let i = 0; i < totalPixels; i++) {
    const d = luma(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]) - mean;
    varSum += d * d;
  }
  const contrast = Math.sqrt(varSum / totalPixels);

  // Sharpness proxy: mean absolute forward gradient magnitude, /255 so it lands in [0,1].
  let gradSum = 0;
  let gradCount = 0;
  for (let y = 0; y < img.height - 1; y++) {
    for (let x = 0; x < img.width - 1; x++) {
      const i = (y * img.width + x) * 4;
      const c = luma(img.data[i], img.data[i + 1], img.data[i + 2]);
      const ir = (y * img.width + x + 1) * 4;
      const id = ((y + 1) * img.width + x) * 4;
      const gx = luma(img.data[ir], img.data[ir + 1], img.data[ir + 2]) - c;
      const gy = luma(img.data[id], img.data[id + 1], img.data[id + 2]) - c;
      gradSum += Math.sqrt(gx * gx + gy * gy);
      gradCount++;
    }
  }
  const sharpnessProxy = gradCount > 0 ? Math.min(1, gradSum / gradCount / 255) : 0;

  const [br, bgc, bb] = bg.color;
  const backgroundIsNearWhite = br >= 225 && bgc >= 225 && bb >= 225;

  return {
    width: img.width,
    height: img.height,
    shortSidePx: Math.min(img.width, img.height),
    longSidePx: Math.max(img.width, img.height),
    aspectRatio: round(img.width / Math.max(1, img.height)),
    backgroundUniformity: round(bg.uniformity),
    backgroundColor: bg.color,
    backgroundIsNearWhite,
    foregroundCoverage: round(foregroundCount / totalPixels),
    totalComponentCount: components.length,
    significantComponentCount: significant.length,
    largestComponentRatio: round(largestRatio),
    garmentOccupancy: round(occupancy),
    borderContactEdges,
    padding: measurePadding(img, bg.color, 42),
    contrast: round(contrast),
    sharpnessProxy: round(sharpnessProxy),
    skinRatioProxy: round(computeSkinRatio(img, mask)),
  };
}

function round(v: number): number {
  return Math.round(v * 10000) / 10000;
}
