import { readFileSync, writeFileSync } from 'node:fs';
import { PNG } from 'pngjs';
import * as jpegjs from 'jpeg-js';
import { createImage, type RgbaImage } from './pixels';
import { sha256Hex } from './hashing';

export type ImageFormat = 'png' | 'jpeg';

export function detectFormat(bytes: Buffer): ImageFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  return null;
}

export interface DecodedSource {
  image: RgbaImage;
  format: ImageFormat;
  sha256: string;
  byteLength: number;
}

/**
 * Decode PNG or JPEG bytes into an RgbaImage. See
 * docs/vto-phase4-corpus-discovery.md §4 for why `pngjs`/`jpeg-js` were
 * added (no server-side image decode capability existed anywhere in this
 * repository, and the two real, already-authorized fixture sets this lane
 * evaluates — assets/qa_fixtures/*.jpg and any future real corpus — include
 * both formats).
 */
export function decodeImageBytes(bytes: Buffer): DecodedSource {
  const format = detectFormat(bytes);
  if (!format) {
    throw new Error('SOURCE_INVALID: unrecognized image format (only PNG/JPEG supported)');
  }
  const sha256 = sha256Hex(bytes);

  if (format === 'png') {
    const png = PNG.sync.read(bytes);
    const image = createImage(png.width, png.height);
    image.data.set(png.data);
    return { image, format, sha256, byteLength: bytes.length };
  }

  const decoded = jpegjs.decode(bytes, { useTArray: true, maxResolutionInMP: 100 });
  const image = createImage(decoded.width, decoded.height);
  image.data.set(decoded.data as Uint8Array);
  return { image, format, sha256, byteLength: bytes.length };
}

export function loadImageFile(path: string): DecodedSource {
  const bytes = readFileSync(path);
  return decodeImageBytes(bytes);
}

export function encodePng(image: RgbaImage): Buffer {
  const png = new PNG({ width: image.width, height: image.height });
  png.data.set(image.data);
  return PNG.sync.write(png);
}

export function writePngFile(path: string, image: RgbaImage): void {
  writeFileSync(path, encodePng(image));
}
