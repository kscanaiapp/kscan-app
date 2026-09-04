/**
 * Minimal RGBA raster primitives. The shape mirrors the concept (not the
 * code — that workspace is unreachable from this branch, see
 * docs/vto-phase4-source-authority.md) of `kscan-live-vto/packages/
 * static-renderer/src/raster.ts`'s `RgbaImage`.
 */
export interface RgbaImage {
  width: number;
  height: number;
  /** Row-major, 4 bytes/pixel (R,G,B,A), A in [0,255]. */
  data: Uint8ClampedArray;
}

export function createImage(width: number, height: number): RgbaImage {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) };
}

export function getPixel(img: RgbaImage, x: number, y: number): [number, number, number, number] {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
}

export function setPixel(img: RgbaImage, x: number, y: number, r: number, g: number, b: number, a: number): void {
  const i = (y * img.width + x) * 4;
  img.data[i] = r;
  img.data[i + 1] = g;
  img.data[i + 2] = b;
  img.data[i + 3] = a;
}

export function cloneImage(img: RgbaImage): RgbaImage {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
}

export function colorDistance(
  a: [number, number, number],
  b: [number, number, number],
): number {
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(dr * dr + dg * dg + db * db);
}

/** Crop to a bounding box, clamped to image bounds. */
export function cropImage(img: RgbaImage, x0: number, y0: number, x1: number, y1: number): RgbaImage {
  const cx0 = Math.max(0, Math.min(img.width - 1, x0));
  const cy0 = Math.max(0, Math.min(img.height - 1, y0));
  const cx1 = Math.max(cx0 + 1, Math.min(img.width, x1));
  const cy1 = Math.max(cy0 + 1, Math.min(img.height, y1));
  const w = cx1 - cx0;
  const h = cy1 - cy0;
  const out = createImage(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b, a] = getPixel(img, cx0 + x, cy0 + y);
      setPixel(out, x, y, r, g, b, a);
    }
  }
  return out;
}

/**
 * Nearest-neighbor rotation about the image center, by `radians`. Used only
 * for bounded, small (typically <15deg) rectification. Out-of-bounds
 * samples (the corners a rotation always leaves unfilled) default to fully
 * transparent — correct when rotating an already-cropped garment cutout,
 * where "nothing here" must mean "not garment." Pass `fillColor` when
 * rotating a whole flat scene with a real background (e.g. synthetic
 * fixture generation) so the rotation doesn't leave spurious opaque
 * corner triangles that a downstream segmenter would mistake for extra
 * objects.
 */
export function rotateImage(img: RgbaImage, radians: number, fillColor?: [number, number, number]): RgbaImage {
  const out = createImage(img.width, img.height);
  const cx = img.width / 2;
  const cy = img.height / 2;
  const cos = Math.cos(-radians);
  const sin = Math.sin(-radians);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const srcX = Math.round(cx + dx * cos - dy * sin);
      const srcY = Math.round(cy + dx * sin + dy * cos);
      if (srcX >= 0 && srcX < img.width && srcY >= 0 && srcY < img.height) {
        const [r, g, b, a] = getPixel(img, srcX, srcY);
        setPixel(out, x, y, r, g, b, a);
      } else if (fillColor) {
        setPixel(out, x, y, fillColor[0], fillColor[1], fillColor[2], 255);
      }
    }
  }
  return out;
}
