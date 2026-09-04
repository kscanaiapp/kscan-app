/**
 * RGBA raster primitives for the headless static renderer.
 *
 * Straight CPU pixel work — no canvas, no GPU, no dependency. Section 6 of
 * the pass brief is explicit that this is an *engineering/evaluation*
 * renderer whose job is to establish semantic golden behavior (control-point
 * mapping, geometry, layering, mirroring, asset interpretation), and that its
 * pixels are NOT the native rasterization baseline. Everything here is
 * chosen for determinism and inspectability over speed.
 */

import { GLYPH_HEIGHT, GLYPH_WIDTH, glyphRows } from './font5x7';
import type { RgbaImage } from './png';

export type { RgbaImage } from './png';

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function rgba(r: number, g: number, b: number, a = 255): Rgba {
  return { r, g, b, a };
}

export function createImage(width: number, height: number, fill: Rgba = rgba(0, 0, 0, 0)): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = fill.r;
    data[i * 4 + 1] = fill.g;
    data[i * 4 + 2] = fill.b;
    data[i * 4 + 3] = fill.a;
  }
  return { width, height, data };
}

export function cloneImage(image: RgbaImage): RgbaImage {
  return { width: image.width, height: image.height, data: new Uint8ClampedArray(image.data) };
}

export function getPixel(image: RgbaImage, x: number, y: number): Rgba {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return rgba(0, 0, 0, 0);
  const i = (y * image.width + x) * 4;
  return { r: image.data[i]!, g: image.data[i + 1]!, b: image.data[i + 2]!, a: image.data[i + 3]! };
}

export function setPixel(image: RgbaImage, x: number, y: number, color: Rgba): void {
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = (y * image.width + x) * 4;
  image.data[i] = color.r;
  image.data[i + 1] = color.g;
  image.data[i + 2] = color.b;
  image.data[i + 3] = color.a;
}

/** Standard source-over alpha compositing, non-premultiplied in/out. */
export function blendPixel(image: RgbaImage, x: number, y: number, src: Rgba): void {
  if (src.a <= 0) return;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return;
  const i = (y * image.width + x) * 4;
  const sa = src.a / 255;
  const da = image.data[i + 3]! / 255;
  const outA = sa + da * (1 - sa);
  if (outA <= 0) {
    image.data[i] = 0;
    image.data[i + 1] = 0;
    image.data[i + 2] = 0;
    image.data[i + 3] = 0;
    return;
  }
  image.data[i] = (src.r * sa + image.data[i]! * da * (1 - sa)) / outA;
  image.data[i + 1] = (src.g * sa + image.data[i + 1]! * da * (1 - sa)) / outA;
  image.data[i + 2] = (src.b * sa + image.data[i + 2]! * da * (1 - sa)) / outA;
  image.data[i + 3] = outA * 255;
}

/**
 * Bilinear sample in pixel coordinates. Out-of-bounds reads clamp to the edge
 * for color but return alpha 0, so sampling past a garment texture's border
 * yields transparency rather than a smeared edge color.
 */
export function sampleBilinear(image: RgbaImage, x: number, y: number): Rgba {
  if (x < -1 || y < -1 || x > image.width || y > image.height) return rgba(0, 0, 0, 0);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;

  const p00 = getPixel(image, x0, y0);
  const p10 = getPixel(image, x0 + 1, y0);
  const p01 = getPixel(image, x0, y0 + 1);
  const p11 = getPixel(image, x0 + 1, y0 + 1);

  const mix = (a: number, b: number, t: number) => a + (b - a) * t;
  const top = (k: keyof Rgba) => mix(p00[k], p10[k], fx);
  const bottom = (k: keyof Rgba) => mix(p01[k], p11[k], fx);
  const at = (k: keyof Rgba) => mix(top(k), bottom(k), fy);

  return { r: at('r'), g: at('g'), b: at('b'), a: at('a') };
}

export interface Point {
  x: number;
  y: number;
}

/** Even-odd scanline polygon fill. Deterministic, no anti-aliasing. */
export function fillPolygon(image: RgbaImage, points: readonly Point[], color: Rgba): void {
  if (points.length < 3) return;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const yStart = Math.max(0, Math.floor(minY));
  const yEnd = Math.min(image.height - 1, Math.ceil(maxY));

  for (let y = yStart; y <= yEnd; y++) {
    const sampleY = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i]!;
      const b = points[(i + 1) % points.length]!;
      if (a.y === b.y) continue;
      const lower = Math.min(a.y, b.y);
      const upper = Math.max(a.y, b.y);
      if (sampleY < lower || sampleY >= upper) continue;
      crossings.push(a.x + ((sampleY - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const xStart = Math.max(0, Math.ceil(crossings[i]! - 0.5));
      const xEnd = Math.min(image.width - 1, Math.floor(crossings[i + 1]! - 0.5));
      for (let x = xStart; x <= xEnd; x++) blendPixel(image, x, y, color);
    }
  }
}

export function fillDisc(image: RgbaImage, cx: number, cy: number, radius: number, color: Rgba): void {
  const r2 = radius * radius;
  for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
    for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) blendPixel(image, x, y, color);
    }
  }
}

/** Thick line as a quad; used for limbs and overlay strokes. */
export function drawLine(
  image: RgbaImage,
  a: Point,
  b: Point,
  thickness: number,
  color: Rgba,
): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    fillDisc(image, a.x, a.y, thickness / 2, color);
    return;
  }
  const nx = (-dy / length) * (thickness / 2);
  const ny = (dx / length) * (thickness / 2);
  fillPolygon(
    image,
    [
      { x: a.x + nx, y: a.y + ny },
      { x: b.x + nx, y: b.y + ny },
      { x: b.x - nx, y: b.y - ny },
      { x: a.x - nx, y: a.y - ny },
    ],
    color,
  );
  // Round the caps so a limb built from two segments has no notch at the joint.
  fillDisc(image, a.x, a.y, thickness / 2, color);
  fillDisc(image, b.x, b.y, thickness / 2, color);
}

export function fillRect(image: RgbaImage, x0: number, y0: number, w: number, h: number, color: Rgba): void {
  for (let y = Math.floor(y0); y < Math.ceil(y0 + h); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x0 + w); x++) blendPixel(image, x, y, color);
  }
}

export function strokeRect(image: RgbaImage, x0: number, y0: number, w: number, h: number, thickness: number, color: Rgba): void {
  fillRect(image, x0, y0, w, thickness, color);
  fillRect(image, x0, y0 + h - thickness, w, thickness, color);
  fillRect(image, x0, y0, thickness, h, color);
  fillRect(image, x0 + w - thickness, y0, thickness, h, color);
}

/** A cross marker with a contrasting halo, for control-point overlays. */
export function drawMarker(image: RgbaImage, cx: number, cy: number, size: number, color: Rgba, halo: Rgba = rgba(0, 0, 0, 180)): void {
  drawLine(image, { x: cx - size, y: cy }, { x: cx + size, y: cy }, 3, halo);
  drawLine(image, { x: cx, y: cy - size }, { x: cx, y: cy + size }, 3, halo);
  drawLine(image, { x: cx - size, y: cy }, { x: cx + size, y: cy }, 1, color);
  drawLine(image, { x: cx, y: cy - size }, { x: cx, y: cy + size }, 1, color);
}

export interface TextOptions {
  scale?: number;
  color?: Rgba;
  /** Drawn behind the glyphs with 1 glyph-pixel of padding when set. */
  background?: Rgba | null;
}

export function measureText(text: string, scale = 1): { width: number; height: number } {
  return {
    width: text.length * (GLYPH_WIDTH + 1) * scale,
    height: GLYPH_HEIGHT * scale,
  };
}

export function drawText(image: RgbaImage, text: string, x: number, y: number, options: TextOptions = {}): void {
  const scale = options.scale ?? 1;
  const color = options.color ?? rgba(255, 255, 255, 255);
  const size = measureText(text, scale);

  if (options.background) {
    fillRect(image, x - scale, y - scale, size.width + scale * 2, size.height + scale * 2, options.background);
  }

  let cursorX = x;
  for (const char of text) {
    const rows = glyphRows(char);
    if (rows) {
      for (let gy = 0; gy < GLYPH_HEIGHT; gy++) {
        const row = rows[gy]!;
        for (let gx = 0; gx < GLYPH_WIDTH; gx++) {
          if (row[gx] === '#') {
            fillRect(image, cursorX + gx * scale, y + gy * scale, scale, scale, color);
          }
        }
      }
    }
    cursorX += (GLYPH_WIDTH + 1) * scale;
  }
}

/** Perceptual luminance in [0,1] (Rec. 709 coefficients). */
export function luminanceOf(color: Rgba): number {
  return (0.2126 * color.r + 0.7152 * color.g + 0.0722 * color.b) / 255;
}
