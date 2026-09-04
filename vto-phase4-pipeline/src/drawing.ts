import { createImage, setPixel, type RgbaImage } from './pixels';

export function fillBackground(img: RgbaImage, color: [number, number, number]): void {
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      setPixel(img, x, y, color[0], color[1], color[2], 255);
    }
  }
}

/** Deterministic PRNG (mulberry32) so synthetic fixtures are byte-reproducible across runs. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function addNoise(img: RgbaImage, amount: number, seed: number): void {
  const rng = makeRng(seed);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const i = (y * img.width + x) * 4;
      const delta = (rng() - 0.5) * 2 * amount;
      img.data[i] = clampByte(img.data[i] + delta);
      img.data[i + 1] = clampByte(img.data[i + 1] + delta);
      img.data[i + 2] = clampByte(img.data[i + 2] + delta);
    }
  }
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, v));
}

/** Point-in-polygon scanline fill (even-odd rule), for a simple garment silhouette. */
export function fillPolygon(img: RgbaImage, points: [number, number][], color: [number, number, number]): void {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of points) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(img.height - 1, Math.ceil(maxY)); y++) {
    const intersections: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % points.length];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const t = (y - y1) / (y2 - y1);
        intersections.push(x1 + t * (x2 - x1));
      }
    }
    intersections.sort((a, b) => a - b);
    for (let i = 0; i + 1 < intersections.length; i += 2) {
      const xStart = Math.max(0, Math.round(intersections[i]));
      const xEnd = Math.min(img.width - 1, Math.round(intersections[i + 1]));
      for (let x = xStart; x <= xEnd; x++) {
        setPixel(img, x, y, color[0], color[1], color[2], 255);
      }
    }
  }
}

export function fillRect(img: RgbaImage, x0: number, y0: number, x1: number, y1: number, color: [number, number, number]): void {
  for (let y = Math.max(0, y0); y < Math.min(img.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(img.width, x1); x++) {
      setPixel(img, x, y, color[0], color[1], color[2], 255);
    }
  }
}

export function fillHorizontalStripes(img: RgbaImage, region: [number, number][], colorA: [number, number, number], colorB: [number, number, number], stripeHeight: number): void {
  fillPolygon(img, region, colorA);
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of region) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  for (let y = Math.floor(minY); y < Math.ceil(maxY); y++) {
    if (Math.floor((y - minY) / stripeHeight) % 2 === 1) {
      overlayRowWithinPolygon(img, region, y, colorB);
    }
  }
}

function overlayRowWithinPolygon(img: RgbaImage, points: [number, number][], y: number, color: [number, number, number]): void {
  const intersections: number[] = [];
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i];
    const [x2, y2] = points[(i + 1) % points.length];
    if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
      const t = (y - y1) / (y2 - y1);
      intersections.push(x1 + t * (x2 - x1));
    }
  }
  intersections.sort((a, b) => a - b);
  for (let i = 0; i + 1 < intersections.length; i += 2) {
    const xStart = Math.max(0, Math.round(intersections[i]));
    const xEnd = Math.min(img.width - 1, Math.round(intersections[i + 1]));
    for (let x = xStart; x <= xEnd; x++) {
      setPixel(img, x, y, color[0], color[1], color[2], 255);
    }
  }
}

export { createImage };
