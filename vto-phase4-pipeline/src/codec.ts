import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import * as jpegjs from 'jpeg-js';
import { createImage, type RgbaImage } from './pixels';
import { sha256Hex } from './hashing';
import type { SystemErrorCode } from './types';

export type ImageFormat = 'png' | 'jpeg' | 'webp';
/** A format Gate E can positively identify but does not decode (addendum §A3). */
export type IdentifiedUnsupportedFormat = 'avif';

/**
 * Thrown by `decodeImageBytes`/`loadImageFile` for every decode-class
 * failure. Carries a `SystemErrorCode` directly so `sourceLoad.ts` never
 * has to string-match a message to classify the failure (Gate E
 * certification repair GATE-E-INT-002, addendum §7/§12).
 */
export class DecodeError extends Error {
  readonly code: Extract<SystemErrorCode, 'DECODE_FAILED' | 'UNSUPPORTED_IMAGE_FORMAT'>;
  readonly format?: string;
  constructor(code: DecodeError['code'], message: string, format?: string) {
    super(message);
    this.name = 'DecodeError';
    this.code = code;
    this.format = format;
  }
}

/**
 * Resource-safety guard (addendum §9/§A5): reject unreasonable image
 * resources BEFORE uncontrolled pixel allocation. These are explicitly a
 * safety/resource ceiling, not a garment-quality threshold — a real garment
 * photo is never anywhere near 8192px or 64 megapixels; a file claiming to
 * be is either hostile or corrupt. No existing repository precedent sets a
 * stricter authoritative guard for this pipeline, so this is a conservative
 * starting point per the addendum, adjustable only with repository
 * precedent or measured real-product evidence.
 */
export const MAX_DIMENSION_PX = 8192;
export const MAX_TOTAL_PIXELS = 64_000_000; // 64 megapixels

export function detectFormat(bytes: Buffer): ImageFormat | IdentifiedUnsupportedFormat | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'jpeg';
  }
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && // "RIFF"
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 // "WEBP"
  ) {
    return 'webp';
  }
  // ISOBMFF "ftyp" box with an avif/avis brand, per the AVIF spec — checked
  // at the fixed offset every ISOBMFF file uses (size[4] + 'ftyp'[4] + major_brand[4]).
  if (
    bytes.length >= 12 &&
    bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 // "ftyp"
  ) {
    const brand = bytes.slice(8, 12).toString('ascii');
    if (brand === 'avif' || brand === 'avis') return 'avif';
  }
  return null;
}

/** Reads only the PNG IHDR chunk (bytes 16-23) — no full decode, no pixel allocation. */
function peekPngDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Scans JPEG markers for the first SOF (start-of-frame) segment, which carries dimensions — no full decode. */
function peekJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i++;
      continue;
    }
    const marker = bytes[i + 1];
    // SOF0-SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry dimensions at a fixed offset.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(i + 5), width: bytes.readUInt16BE(i + 7) };
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const segmentLength = bytes.readUInt16BE(i + 2);
    if (segmentLength < 2) return null;
    i += 2 + segmentLength;
  }
  return null;
}

/** Parses VP8/VP8X/VP8L chunk headers per the WebP container spec — no full decode. */
function peekWebpDimensions(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 30) return null;
  const chunkType = bytes.slice(12, 16).toString('ascii');
  try {
    if (chunkType === 'VP8X') {
      return { width: bytes.readUIntLE(24, 3) + 1, height: bytes.readUIntLE(27, 3) + 1 };
    }
    if (chunkType === 'VP8 ') {
      // Lossy: 3-byte start code at +23, then 2-byte LE width/height with 2 high bits of scale (masked off).
      return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
    }
    if (chunkType === 'VP8L') {
      // Lossless: 1 signature byte (0x2f) then a packed 14+14 bit width-1/height-1.
      const bits = bytes.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
  } catch {
    return null;
  }
  return null;
}

function dimensionSafetyCheck(width: number, height: number, format: string): void {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new DecodeError('DECODE_FAILED', `${format}: header reports non-positive/invalid dimensions (${width}x${height})`);
  }
  if (width > MAX_DIMENSION_PX || height > MAX_DIMENSION_PX) {
    throw new DecodeError('DECODE_FAILED', `${format}: ${width}x${height} exceeds max dimension ${MAX_DIMENSION_PX}px (resource-safety guard, addendum §A5)`);
  }
  const totalPixels = width * height;
  if (totalPixels > MAX_TOTAL_PIXELS) {
    throw new DecodeError('DECODE_FAILED', `${format}: ${width}x${height} (${totalPixels.toLocaleString()}px) exceeds max ${MAX_TOTAL_PIXELS.toLocaleString()}px (resource-safety guard, addendum §A5)`);
  }
}

export interface DecodedSource {
  image: RgbaImage;
  format: ImageFormat;
  sha256: string;
  byteLength: number;
}

interface JSquashDecodedImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}
interface JSquashWebpDecodeModule {
  init: (module?: WebAssembly.Module) => Promise<void>;
  default: (buffer: Buffer | Uint8Array) => Promise<JSquashDecodedImage>;
}

let webpDecoderModule: JSquashWebpDecodeModule | null = null;
let webpWasmInitPromise: Promise<void> | null = null;

/**
 * `@jsquash/webp` (Apache-2.0, wraps a WASM build of libwebp — no native
 * binary, no network access at decode time). Selected over `sharp`/libvips
 * (per-platform native prebuilds — cross-platform CI/local-dev risk this
 * package has otherwise avoided entirely, see docs/vto-phase4-corpus-
 * discovery.md §4) and over adding a second AVIF-only WASM dependency
 * (addendum §A3 forbids that). See docs/vto-phase4-gate-e-decoder-
 * selection.md for the full evaluation record.
 *
 * Two Node-compatibility fixes were required beyond a plain `npm install`:
 *
 * 1. The package is ESM-only (`"type": "module"`); this package compiles
 *    to CommonJS, and `require()`-ing an ESM package throws
 *    `ERR_REQUIRE_ESM`. A dynamic `import()` is Node's documented
 *    CJS-to-ESM interop path, and TypeScript preserves a dynamic `import()`
 *    as a real dynamic import under `module: "commonjs"` rather than
 *    downleveling it to `require()`.
 * 2. The package's default auto-init (`decode(bytes)` with no prior
 *    `init()`) instantiates its WASM module via `fetch()` of a `file://`
 *    URL, which Node's built-in `fetch` does not support ("not
 *    implemented... yet..." — reproduced during evaluation on Node v24).
 *    This reads the `.wasm` file directly with `readFileSync`, compiles it
 *    with `WebAssembly.compile`, and passes the compiled module to the
 *    library's own documented `init(module)` override — bypassing the
 *    internal fetch entirely. Confirmed against a synthetic (non-retailer)
 *    encode/decode round-trip during decoder evaluation.
 */
async function ensureWebpDecoder(): Promise<JSquashWebpDecodeModule> {
  if (!webpDecoderModule) {
    webpDecoderModule = (await import('@jsquash/webp/decode.js')) as unknown as JSquashWebpDecodeModule;
  }
  if (!webpWasmInitPromise) {
    const module = webpDecoderModule;
    webpWasmInitPromise = (async () => {
      // Compiled output lives at dist/src/codec.js; node_modules sits two
      // levels up from there, at the package root.
      const wasmPath = join(__dirname, '..', '..', 'node_modules', '@jsquash', 'webp', 'codec', 'dec', 'webp_dec.wasm');
      const wasmModule = await WebAssembly.compile(readFileSync(wasmPath));
      await module.init(wasmModule);
    })();
  }
  await webpWasmInitPromise;
  return webpDecoderModule;
}

function tryDecodePng(bytes: Buffer): { ok: true; png: PNG } | { ok: false; message: string } {
  try {
    return { ok: true, png: PNG.sync.read(bytes) };
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
}

function tryDecodeJpeg(bytes: Buffer, maxResolutionInMP: number) {
  try {
    return { ok: true as const, decoded: jpegjs.decode(bytes, { useTArray: true, maxResolutionInMP }) };
  } catch (err) {
    return { ok: false as const, message: (err as Error).message };
  }
}

/**
 * Decode PNG, JPEG, or WebP bytes into an RgbaImage — one normalized pixel
 * contract regardless of source format (addendum §6): everything
 * downstream of this function (classification, segmentation,
 * canonicalization, anchors, fidelity) is format-agnostic and always was.
 *
 * AVIF is positively identified but deliberately not decoded (addendum
 * §A3) — throws `DecodeError('UNSUPPORTED_IMAGE_FORMAT', ..., 'avif')`
 * rather than a generic decode failure, so the caller can report it
 * distinctly. Anything else unrecognized, corrupt, truncated, zero-byte,
 * or over the resource-safety ceiling throws `DecodeError('DECODE_FAILED')`.
 */
export async function decodeImageBytes(bytes: Buffer): Promise<DecodedSource> {
  const format = detectFormat(bytes);
  if (format === null) {
    throw new DecodeError('DECODE_FAILED', 'unrecognized image format (no PNG/JPEG/WebP/AVIF signature matched)');
  }
  if (format === 'avif') {
    throw new DecodeError('UNSUPPORTED_IMAGE_FORMAT', 'AVIF is a positively-identified but unsupported format in this pipeline (addendum §A3: no second WASM dependency added in this lane)', 'AVIF');
  }

  const sha256 = sha256Hex(bytes);

  if (format === 'png') {
    const peeked = peekPngDimensions(bytes);
    if (!peeked) throw new DecodeError('DECODE_FAILED', 'png: truncated before IHDR chunk');
    dimensionSafetyCheck(peeked.width, peeked.height, 'png');
    const result = tryDecodePng(bytes);
    if (!result.ok) throw new DecodeError('DECODE_FAILED', `png: decode failed: ${result.message}`);
    const { png } = result;
    const image = createImage(png.width, png.height);
    image.data.set(png.data);
    return { image, format, sha256, byteLength: bytes.length };
  }

  if (format === 'jpeg') {
    const peeked = peekJpegDimensions(bytes);
    if (peeked) dimensionSafetyCheck(peeked.width, peeked.height, 'jpeg');
    const result = tryDecodeJpeg(bytes, MAX_TOTAL_PIXELS / 1_000_000);
    if (!result.ok) throw new DecodeError('DECODE_FAILED', `jpeg: decode failed: ${result.message}`);
    const { decoded } = result;
    dimensionSafetyCheck(decoded.width, decoded.height, 'jpeg');
    const image = createImage(decoded.width, decoded.height);
    image.data.set(decoded.data as Uint8Array);
    return { image, format, sha256, byteLength: bytes.length };
  }

  // webp
  const peeked = peekWebpDimensions(bytes);
  if (!peeked) throw new DecodeError('DECODE_FAILED', 'webp: could not parse VP8/VP8X/VP8L chunk header');
  dimensionSafetyCheck(peeked.width, peeked.height, 'webp');
  const decoder = await ensureWebpDecoder();
  let decoded: JSquashDecodedImage;
  try {
    decoded = await decoder.default(bytes);
  } catch (err) {
    throw new DecodeError('DECODE_FAILED', `webp: decode failed: ${(err as Error).message}`);
  }
  dimensionSafetyCheck(decoded.width, decoded.height, 'webp');
  const image = createImage(decoded.width, decoded.height);
  image.data.set(decoded.data);
  return { image, format, sha256, byteLength: bytes.length };
}

export async function loadImageFile(path: string): Promise<DecodedSource> {
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
