import { colorDistance, getPixel, type RgbaImage } from './pixels';

export interface BackgroundEstimate {
  color: [number, number, number];
  /** Population stddev of border-ring pixel color distance from the median color — a uniformity proxy. */
  uniformity: number;
  borderSampleCount: number;
}

/** Median color of a thin ring around the image border. Median (not mean) resists a garment sliver touching the edge. */
export function estimateBackgroundColor(img: RgbaImage, marginFraction = 0.04): BackgroundEstimate {
  const marginX = Math.max(1, Math.round(img.width * marginFraction));
  const marginY = Math.max(1, Math.round(img.height * marginFraction));
  const samples: [number, number, number][] = [];

  for (let x = 0; x < img.width; x++) {
    for (const y of [0, img.height - 1]) {
      samples.push(getPixel(img, x, y).slice(0, 3) as [number, number, number]);
    }
  }
  for (let y = marginY; y < img.height - marginY; y++) {
    for (const x of [0, img.width - 1]) {
      samples.push(getPixel(img, x, y).slice(0, 3) as [number, number, number]);
    }
  }
  // Also include a thin ring just inside the border, in case the outermost
  // row/column is a compression artifact or vignette edge.
  for (let x = marginX; x < img.width - marginX; x += Math.max(1, Math.floor(marginX / 2))) {
    samples.push(getPixel(img, x, marginY).slice(0, 3) as [number, number, number]);
    samples.push(getPixel(img, x, img.height - 1 - marginY).slice(0, 3) as [number, number, number]);
  }

  const median = (values: number[]): number => {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  };
  const color: [number, number, number] = [
    median(samples.map((s) => s[0])),
    median(samples.map((s) => s[1])),
    median(samples.map((s) => s[2])),
  ];

  const distances = samples.map((s) => colorDistance(s, color));
  const mean = distances.reduce((a, b) => a + b, 0) / distances.length;
  const variance = distances.reduce((a, b) => a + (b - mean) * (b - mean), 0) / distances.length;

  return { color, uniformity: Math.sqrt(variance), borderSampleCount: samples.length };
}

/** Boolean foreground mask: pixel differs from the estimated background color by more than `threshold`. */
export function computeForegroundMask(img: RgbaImage, bg: BackgroundEstimate, threshold = 42): Uint8Array {
  const mask = new Uint8Array(img.width * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const [r, g, b] = getPixel(img, x, y);
      mask[y * img.width + x] = colorDistance([r, g, b], bg.color) > threshold ? 1 : 0;
    }
  }
  return mask;
}

/** Simple RGB-heuristic skin-tone detector (Kovac et al. style bounds). Coarse proxy only — not a face/person detector, never claimed as one. */
export function isLikelySkinPixel(r: number, g: number, b: number): boolean {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return (
    r > 95 &&
    g > 40 &&
    b > 20 &&
    max - min > 15 &&
    Math.abs(r - g) > 15 &&
    r > g &&
    r > b
  );
}

export function computeSkinRatio(img: RgbaImage, mask: Uint8Array): number {
  let skinCount = 0;
  let maskCount = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] !== 1) continue;
    maskCount++;
    const base = i * 4;
    if (isLikelySkinPixel(img.data[base], img.data[base + 1], img.data[base + 2])) skinCount++;
  }
  if (maskCount === 0) return 0;
  return skinCount / maskCount;
}
