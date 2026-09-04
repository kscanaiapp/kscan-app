/**
 * Minimal PNG codec — 8-bit RGBA / RGB, non-interlaced only.
 *
 * Written rather than depended upon: `kscan-live-vto` has zero external
 * runtime dependencies by policy (Section 8.3 / Section 32, enforced by
 * tests/privacy/dependencyBoundary.test.js), and Node's built-in `zlib` is
 * the only hard part of PNG. This covers exactly what the headless static
 * renderer needs — encode an RGBA raster, decode one back — and deliberately
 * nothing else: no interlacing, no palettes, no 16-bit channels, no ancillary
 * chunk handling beyond skipping them.
 *
 * Output is sRGB by convention (an sRGB chunk is written); this codec does no
 * color management of its own.
 */

import { deflateSync, inflateSync } from 'node:zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

export interface RgbaImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major, top-left origin. */
  data: Uint8ClampedArray;
}

export function encodePng(image: RgbaImage): Buffer {
  const { width, height, data } = image;
  if (data.length !== width * height * 4) {
    throw new RangeError(`pixel buffer is ${data.length} bytes, expected ${width * height * 4}`);
  }

  // Filter type 0 (None) on every scanline. Deflate does the work; per-line
  // adaptive filtering would shrink output further but adds a whole failure
  // surface for no benefit at these image sizes.
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1);
    raw[rowStart] = 0;
    for (let i = 0; i < width * 4; i++) raw[rowStart + 1 + i] = data[y * width * 4 + i]!;
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // interlace: none

  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    // sRGB rendering intent 0 (perceptual) — declares the color space the
    // PreviewManifest also reports.
    chunk('sRGB', Buffer.from([0])),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(buffer: Buffer): RgbaImage {
  if (!buffer.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not a PNG');

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idatParts: Buffer[] = [];

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    offset += 12 + length; // length + type + data + crc

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8) throw new Error(`unsupported bit depth ${data[8]} (only 8 is supported)`);
      colorType = data[9]!;
      if (colorType !== 6 && colorType !== 2) {
        throw new Error(`unsupported color type ${colorType} (only 2=RGB and 6=RGBA are supported)`);
      }
      if (data[12] !== 0) throw new Error('interlaced PNG is not supported');
    } else if (type === 'IDAT') {
      idatParts.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (width === 0 || height === 0) throw new Error('PNG has no IHDR');

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idatParts));
  const out = new Uint8ClampedArray(width * height * 4);
  const prior = new Uint8Array(stride);
  const line = new Uint8Array(stride);

  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!;
    for (let i = 0; i < stride; i++) {
      const rawByte = raw[pos + i]!;
      const a = i >= channels ? line[i - channels]! : 0;
      const b = prior[i]!;
      const c = i >= channels ? prior[i - channels]! : 0;
      let value: number;
      switch (filter) {
        case 0: value = rawByte; break;
        case 1: value = rawByte + a; break;
        case 2: value = rawByte + b; break;
        case 3: value = rawByte + ((a + b) >> 1); break;
        case 4: value = rawByte + paethPredictor(a, b, c); break;
        default: throw new Error(`unknown PNG filter ${filter}`);
      }
      line[i] = value & 0xff;
    }
    pos += stride;

    for (let x = 0; x < width; x++) {
      const src = x * channels;
      const dst = (y * width + x) * 4;
      out[dst] = line[src]!;
      out[dst + 1] = line[src + 1]!;
      out[dst + 2] = line[src + 2]!;
      out[dst + 3] = channels === 4 ? line[src + 3]! : 255;
    }
    prior.set(line);
  }

  return { width, height, data: out };
}
