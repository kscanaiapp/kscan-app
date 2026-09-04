import { createImage, type RgbaImage } from './pixels';
import { addNoise, fillBackground, fillHorizontalStripes, fillPolygon, fillRect, makeRng } from './drawing';
import { rotateImage } from './pixels';

export interface GarmentPreset {
  shoulderHalfWidth: number;
  sleeveHalfWidth: number;
  armpitHalfWidth: number;
  torsoHalfWidth: number;
  hemHalfWidth: number;
}

export const STRUCTURED_PRESET: GarmentPreset = {
  shoulderHalfWidth: 92,
  sleeveHalfWidth: 128,
  armpitHalfWidth: 66,
  torsoHalfWidth: 80,
  hemHalfWidth: 82,
};

export const SOFT_KNIT_PRESET: GarmentPreset = {
  shoulderHalfWidth: 88,
  sleeveHalfWidth: 112,
  armpitHalfWidth: 78,
  torsoHalfWidth: 82,
  hemHalfWidth: 90,
};

export function tshirtPolygon(canvasWidth: number, canvasHeight: number, preset: GarmentPreset): [number, number][] {
  const cx = canvasWidth / 2;
  const topY = canvasHeight * 0.12;
  const sleeveY = canvasHeight * 0.22;
  const armpitY = canvasHeight * 0.4;
  const tumY = canvasHeight * 0.75;
  const hemY = canvasHeight * 0.9;
  const neckHalfWidth = preset.shoulderHalfWidth * 0.3;

  return [
    [cx - neckHalfWidth, topY - 8],
    [cx - preset.shoulderHalfWidth, topY],
    [cx - preset.sleeveHalfWidth, sleeveY],
    [cx - preset.armpitHalfWidth, armpitY],
    [cx - preset.torsoHalfWidth, tumY],
    [cx - preset.hemHalfWidth, hemY],
    [cx + preset.hemHalfWidth, hemY],
    [cx + preset.torsoHalfWidth, tumY],
    [cx + preset.armpitHalfWidth, armpitY],
    [cx + preset.sleeveHalfWidth, sleeveY],
    [cx + preset.shoulderHalfWidth, topY],
    [cx + neckHalfWidth, topY - 8],
  ];
}

export interface SyntheticGarmentSpec {
  seed: number;
  canvasWidth?: number;
  canvasHeight?: number;
  backgroundColor: [number, number, number];
  backgroundNoise?: number;
  preset?: GarmentPreset;
  garmentColor: [number, number, number];
  logo?: { color: [number, number, number] };
  stripes?: { color: [number, number, number]; orientation: 'horizontal' | 'vertical' };
  tiltDegrees?: number;
  addSkinBlob?: boolean;
  scatterExtraObjects?: boolean;
}

export interface SyntheticGarmentResult {
  image: RgbaImage;
  garmentPolygon: [number, number][];
  logoBBoxNormalized?: { x0: number; y0: number; x1: number; y1: number };
}

const SKIN_TONE: [number, number, number] = [222, 176, 148];

export function generateSyntheticGarment(spec: SyntheticGarmentSpec): SyntheticGarmentResult {
  const width = spec.canvasWidth ?? 320;
  const height = spec.canvasHeight ?? 360;
  const preset = spec.preset ?? STRUCTURED_PRESET;
  const img = createImage(width, height);
  fillBackground(img, spec.backgroundColor);

  let polygon = tshirtPolygon(width, height, preset);
  fillPolygon(img, polygon, spec.garmentColor);

  let logoBBoxNormalized: { x0: number; y0: number; x1: number; y1: number } | undefined;
  if (spec.logo) {
    const cx = width / 2;
    const logoW = width * 0.16;
    const logoH = height * 0.12;
    const x0 = Math.round(cx - logoW / 2);
    const y0 = Math.round(height * 0.32);
    fillRect(img, x0, y0, x0 + logoW, y0 + logoH, spec.logo.color);
    logoBBoxNormalized = { x0: x0 / width, y0: y0 / height, x1: (x0 + logoW) / width, y1: (y0 + logoH) / height };
  }

  if (spec.stripes) {
    const region = spec.stripes.orientation === 'horizontal' ? polygon : polygon.map(([x, y]) => [y, x] as [number, number]);
    if (spec.stripes.orientation === 'horizontal') {
      fillHorizontalStripes(img, polygon, spec.garmentColor, spec.stripes.color, Math.max(6, Math.round(height * 0.04)));
    } else {
      // Vertical stripes: draw via transposed coordinates is error-prone with polygon fill; approximate with column bands instead.
      drawVerticalStripes(img, polygon, spec.garmentColor, spec.stripes.color, Math.max(6, Math.round(width * 0.04)));
    }
    void region;
  }

  if (spec.addSkinBlob) {
    const cx = width / 2;
    fillRect(img, Math.round(cx - width * 0.05), 0, Math.round(cx + width * 0.05), Math.round(height * 0.14), SKIN_TONE);
    fillRect(img, Math.round(width * 0.06), Math.round(height * 0.5), Math.round(width * 0.16), Math.round(height * 0.85), SKIN_TONE);
    fillRect(img, Math.round(width * 0.84), Math.round(height * 0.5), Math.round(width * 0.94), Math.round(height * 0.85), SKIN_TONE);
  }

  if (spec.scatterExtraObjects) {
    // Sized/positioned to reliably exceed SHOT_CLASSIFIER_THRESHOLDS.maxSignificantComponentsForAnalyzable
    // (each square well above the 1% "significant" area floor, and far enough apart not to touch each other or the garment).
    const rng = makeRng(spec.seed + 999);
    const slots: [number, number][] = [
      [width * 0.02, height * 0.02],
      [width * 0.8, height * 0.02],
      [width * 0.02, height * 0.44],
      [width * 0.8, height * 0.44],
      [width * 0.02, height * 0.86],
      [width * 0.8, height * 0.86],
    ];
    for (const [ox, oy] of slots) {
      const size = Math.round(Math.min(width, height) * 0.17);
      const color: [number, number, number] = [Math.round(rng() * 255), Math.round(rng() * 255), Math.round(rng() * 255)];
      fillRect(img, Math.round(ox), Math.round(oy), Math.round(ox) + size, Math.round(oy) + size, color);
    }
  }

  if (spec.backgroundNoise) {
    addNoise(img, spec.backgroundNoise, spec.seed);
  }

  let finalImage = img;
  if (spec.tiltDegrees) {
    finalImage = rotateImage(img, (spec.tiltDegrees * Math.PI) / 180, spec.backgroundColor);
  }

  return { image: finalImage, garmentPolygon: polygon, logoBBoxNormalized };
}

function drawVerticalStripes(img: RgbaImage, polygon: [number, number][], base: [number, number, number], stripe: [number, number, number], stripeWidth: number): void {
  fillPolygon(img, polygon, base);
  let minX = Infinity;
  let maxX = -Infinity;
  for (const [x] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  // Re-fill only the stripe columns that fall inside the polygon by re-drawing the polygon clipped per column band.
  for (let bandStart = Math.floor(minX); bandStart < maxX; bandStart += stripeWidth * 2) {
    const clip: [number, number][] = [
      [bandStart, -10],
      [bandStart + stripeWidth, -10],
      [bandStart + stripeWidth, img.height + 10],
      [bandStart, img.height + 10],
    ];
    fillPolygonIntersection(img, polygon, clip, stripe);
  }
}

/** Fills the region covered by BOTH polygons (a coarse clip: rasterize `a`, then re-fill only pixels also inside `b`'s bounding columns). Sufficient for straight vertical clip bands used above. */
function fillPolygonIntersection(img: RgbaImage, a: [number, number][], clipBand: [number, number][], color: [number, number, number]): void {
  const xs = clipBand.map(([x]) => x);
  const bandX0 = Math.max(0, Math.min(...xs));
  const bandX1 = Math.min(img.width, Math.max(...xs));
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of a) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(img.height - 1, Math.ceil(maxY)); y++) {
    const intersections: number[] = [];
    for (let i = 0; i < a.length; i++) {
      const [x1, y1] = a[i];
      const [x2, y2] = a[(i + 1) % a.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const t = (y - y1) / (y2 - y1);
        intersections.push(x1 + t * (x2 - x1));
      }
    }
    intersections.sort((x, y2) => x - y2);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const xStart = Math.max(bandX0, Math.round(intersections[i]));
      const xEnd = Math.min(bandX1, Math.round(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        const idx = (y * img.width + x) * 4;
        img.data[idx] = color[0];
        img.data[idx + 1] = color[1];
        img.data[idx + 2] = color[2];
        img.data[idx + 3] = 255;
      }
    }
  }
}
