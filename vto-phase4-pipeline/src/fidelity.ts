import { getPixel, type RgbaImage } from './pixels';
import type { MetricResult, ProductFidelityQaResult } from './types';

/**
 * Ground-truth hints are supplied ONLY by the synthetic fixture generator,
 * which authored the source image and therefore genuinely knows the true
 * fill color / logo placement (task section 36 forbids treating the
 * pipeline's own output as its own ground truth — these hints come from
 * *outside* the pipeline, from whoever drew the fixture). For every other
 * source (AUTHORIZED FIXTURE real photos, any future real-corpus image),
 * no hints exist and the corresponding metric is honestly reported
 * NO_REFERENCE.
 */
export interface FidelityReferenceHints {
  knownFillColor?: [number, number, number];
  /** Normalized [0,1] bbox of a drawn logo patch, in the ORIGINAL (pre-crop) source image. */
  knownLogoBBoxNormalized?: { x0: number; y0: number; x1: number; y1: number };
  knownLogoColor?: [number, number, number];
  knownPatternOrientation?: 'horizontal' | 'vertical';
}

export function meanMaskedColor(img: RgbaImage): [number, number, number] | null {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a > 127) {
        sr += r;
        sg += g;
        sb += b;
        count++;
      }
    }
  }
  if (count === 0) return null;
  return [sr / count, sg / count, sb / count];
}

function colorDelta(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/** Boundary-pixel count (4-connectivity: any alpha>127 pixel with a non-garment or out-of-bounds neighbor). */
function perimeterPixelCount(mask: RgbaImage): number {
  let perimeter = 0;
  const isGarment = (x: number, y: number) => {
    if (x < 0 || y < 0 || x >= mask.width || y >= mask.height) return false;
    return getPixel(mask, x, y)[3] > 127;
  };
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      if (!isGarment(x, y)) continue;
      if (!isGarment(x - 1, y) || !isGarment(x + 1, y) || !isGarment(x, y - 1) || !isGarment(x, y + 1)) {
        perimeter++;
      }
    }
  }
  return perimeter;
}

function detectStripeOrientation(img: RgbaImage): 'horizontal' | 'vertical' | 'indeterminate' {
  // Compare the variance of row-mean luminance vs column-mean luminance:
  // horizontal stripes vary strongly row-to-row but little column-to-column, and vice versa.
  const rowMeans: number[] = [];
  const colMeans: number[] = [];
  for (let y = 0; y < img.height; y++) {
    let sum = 0;
    let count = 0;
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a > 127) {
        sum += 0.299 * r + 0.587 * g + 0.114 * b;
        count++;
      }
    }
    rowMeans.push(count > 0 ? sum / count : NaN);
  }
  for (let x = 0; x < img.width; x++) {
    let sum = 0;
    let count = 0;
    for (let y = 0; y < img.height; y++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a > 127) {
        sum += 0.299 * r + 0.587 * g + 0.114 * b;
        count++;
      }
    }
    colMeans.push(count > 0 ? sum / count : NaN);
  }
  const variance = (values: number[]) => {
    const valid = values.filter((v) => !Number.isNaN(v));
    if (valid.length < 2) return 0;
    const mean = valid.reduce((a, b) => a + b, 0) / valid.length;
    return valid.reduce((a, b) => a + (b - mean) ** 2, 0) / valid.length;
  };
  const rowVar = variance(rowMeans);
  const colVar = variance(colMeans);
  if (Math.max(rowVar, colVar) < 4) return 'indeterminate';
  return rowVar > colVar ? 'horizontal' : 'vertical';
}

export function computeProductFidelity(
  canonicalTexture: RgbaImage,
  canonicalAlpha: RgbaImage,
  maskPixelCount: number,
  bboxPixelCount: number,
  hints?: FidelityReferenceHints,
): ProductFidelityQaResult {
  const fillRatio = bboxPixelCount > 0 ? maskPixelCount / bboxPixelCount : 0;
  const perimeter = perimeterPixelCount(canonicalAlpha);
  const compactness = maskPixelCount > 0 ? (perimeter * perimeter) / (4 * Math.PI * maskPixelCount) : Infinity;

  const failureReasons: string[] = [];
  if (fillRatio < 0.15) failureReasons.push('silhouette fill ratio implausibly low (<0.15) — likely a bad segmentation, not a real garment silhouette');
  if (compactness > 8) failureReasons.push('silhouette boundary implausibly irregular (compactness > 8) — likely segmentation noise');

  let color: MetricResult;
  const measuredColor = meanMaskedColor(canonicalTexture);
  if (hints?.knownFillColor && measuredColor) {
    const delta = colorDelta(measuredColor, hints.knownFillColor);
    color = { computable: true, referenceClass: 'REFERENCE_AVAILABLE', value: delta, detail: `mean masked color delta from known synthetic fill color: ${delta.toFixed(2)}` };
    if (delta > 20) failureReasons.push(`color fidelity failed: measured color delta ${delta.toFixed(2)} exceeds tolerance 20`);
  } else {
    color = { computable: false, referenceClass: 'NO_REFERENCE', detail: 'no independent ground-truth color exists for this source; only the pipeline\'s own extraction is available, which cannot certify its own fidelity' };
  }

  let logo: MetricResult;
  if (hints?.knownLogoColor) {
    const logoPixelCount = countPixelsNearColor(canonicalTexture, hints.knownLogoColor, 24);
    const present = logoPixelCount > 8;
    logo = {
      computable: true,
      referenceClass: 'REFERENCE_AVAILABLE',
      value: present ? 1 : 0,
      detail: present
        ? `logo-colored region survived extraction (${logoPixelCount} matching px)`
        : 'logo-colored region not found in extracted texture — logo likely lost or miscolored',
    };
    if (!present) failureReasons.push('PATTERN_UNRECOVERABLE: known logo color not detected in extracted texture');
  } else {
    logo = { computable: false, referenceClass: 'NO_REFERENCE', detail: 'no independent ground truth for logo placement/appearance exists for this source' };
  }

  let pattern: MetricResult;
  if (hints?.knownPatternOrientation) {
    const detected = detectStripeOrientation(canonicalTexture);
    const match = detected === hints.knownPatternOrientation;
    pattern = {
      computable: true,
      referenceClass: 'REFERENCE_AVAILABLE',
      value: match ? 1 : 0,
      detail: `known orientation=${hints.knownPatternOrientation}, detected=${detected}`,
    };
    if (!match) failureReasons.push(`pattern orientation mismatch: expected ${hints.knownPatternOrientation}, detected ${detected}`);
  } else {
    pattern = { computable: false, referenceClass: 'NO_REFERENCE', detail: 'no independent ground truth for pattern structure exists for this source' };
  }

  return {
    silhouette: { fillRatio, compactness, maskToBboxAreaNote: 'fillRatio/compactness are intrinsic self-consistency measures, not a comparison to an external reference mask' },
    color,
    logo,
    pattern,
    passed: failureReasons.length === 0,
    failureReasons,
  };
}

function countPixelsNearColor(img: RgbaImage, color: [number, number, number], tolerance: number): number {
  let count = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b, a] = getPixel(img, x, y);
      if (a <= 127) continue;
      const d = Math.sqrt((r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2);
      if (d <= tolerance) count++;
    }
  }
  return count;
}
