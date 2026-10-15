/**
 * Deterministic build-time repair for Elise's approved mouth overlays.
 * The closed/open RGB images already contain registered mouth states, but
 * their alpha mask was left at the RETIRED y=.56 crop. The visible renderer
 * clips y=.70..79, drawing transparent pixels. Relocate ONLY the original
 * alpha mask; never synthesize RGB, assets, audio or an animation clock.
 *
 * Node built-ins only. Called by EAS after dependencies/prebuild, before Metro.
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const FILES = ['avatar_stylist_01_mouth_closed.png', 'avatar_stylist_01_mouth_open.png'];
const ASSETS = path.resolve(__dirname, '..', 'assets', 'stylist-avatars', 'portraits', 'animated');
const MOUTH = { x: 0.39, y: 0.70, width: 0.27, height: 0.09 };
const RETIRED = { ...MOUTH, y: 0.56 };
const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function decodePng(buffer) {
  if (!buffer.subarray(0, 8).equals(PNG_SIG)) throw new Error('Elise overlay: invalid PNG signature');
  let offset = 8, width, height, bitDepth, colorType, interlace;
  const compressed = [];
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    if (offset + length + 12 > buffer.length) throw new Error('Elise overlay: truncated PNG chunk');
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') compressed.push(data);
    if (type === 'IEND') break;
    offset += length + 12;
  }
  // Fail if the approved artwork format changes rather than silently
  // mutating an unsupported PNG or a photo with a different layout.
  if (!width || !height || width > 4096 || height > 4096 || bitDepth !== 8 || colorType !== 6 || interlace !== 0) {
    throw new Error('Elise overlay: expected noninterlaced 8-bit RGBA PNG <=4096px');
  }
  const channels = 4, stride = width * channels;
  const raw = zlib.inflateSync(Buffer.concat(compressed));
  if (raw.length !== (stride + 1) * height) throw new Error('Elise overlay: unexpected decoded length');
  const pixels = Buffer.alloc(stride * height);
  let cursor = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[cursor++];
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
    for (let i = 0; i < stride; i++) {
      const x = raw[cursor++];
      const a = i >= channels ? row[i - channels] : 0;
      const b = prev ? prev[i] : 0;
      const c = prev && i >= channels ? prev[i - channels] : 0;
      let n;
      if (filter === 0) n = 0;
      else if (filter === 1) n = a;
      else if (filter === 2) n = b;
      else if (filter === 3) n = (a + b) >>> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p-a), pb = Math.abs(p-b), pc = Math.abs(p-c);
        n = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else throw new Error('Elise overlay: unsupported PNG filter');
      row[i] = (x + n) & 255;
    }
  }
  return { width, height, pixels };
}

const CRC = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC[n] = c >>> 0;
}
function chunk(type, data) {
  const b = Buffer.alloc(data.length + 12);
  b.writeUInt32BE(data.length, 0); b.write(type, 4, 4, 'ascii'); data.copy(b, 8);
  let crc = 0xffffffff;
  for (let i = 4; i < b.length - 4; i++) crc = CRC[(crc ^ b[i]) & 255] ^ (crc >>> 8);
  b.writeUInt32BE((crc ^ 0xffffffff) >>> 0, b.length - 4);
  return b;
}
function encodePng({ width, height, pixels }) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA; filter 0; no interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
function bounds(region, width, height) {
  return { x0: Math.round(region.x * width), x1: Math.round((region.x+region.width) * width),
    y0: Math.round(region.y * height), y1: Math.round((region.y+region.height) * height) };
}
function alphaCoverage(image, box) {
  let active = 0, total = 0;
  for (let y=box.y0; y<box.y1; y++) for (let x=box.x0; x<box.x1; x++) {
    if (image.pixels[(y*image.width+x)*4+3] >= 32) active++;
    total++;
  }
  return total ? active/total : 0;
}
function rgbDigest(image) {
  const hash = createHash('sha256');
  const rgb = Buffer.alloc(image.width * image.height * 3);
  for (let i = 0, j = 0; i < image.pixels.length; i += 4) {
    rgb[j++] = image.pixels[i]; rgb[j++] = image.pixels[i+1]; rgb[j++] = image.pixels[i+2];
  }
  return hash.update(rgb).digest('hex');
}
function repair(buffer) {
  const image = decodePng(buffer);
  const target = bounds(MOUTH, image.width, image.height);
  const former = bounds(RETIRED, image.width, image.height);
  if (target.x0 !== former.x0 || target.x1 !== former.x1 || target.y1-target.y0 !== former.y1-former.y0) {
    throw new Error('Elise overlay: mouth and retired crop sizes must match');
  }
  const originalRgb = rgbDigest(image);
  const before = alphaCoverage(image, target);
  let modified = false;
  if (before < 0.08) {
    const sourceCoverage = alphaCoverage(image, former);
    if (sourceCoverage < 0.08) throw new Error('Elise overlay: missing approved old alpha mask; manual artwork repair required');
    for (let y = target.y0; y < target.y1; y++) for (let x = target.x0; x < target.x1; x++) {
      const dest = (y * image.width + x) * 4 + 3;
      const src = ((former.y0 + y - target.y0) * image.width + x) * 4 + 3;
      image.pixels[dest] = image.pixels[src];
    }
    modified = true;
  }
  const coverage = alphaCoverage(image, target);
  if (coverage < 0.08) throw new Error('Elise overlay: mouth is still invisible after alpha repair');
  if (rgbDigest(image) !== originalRgb) throw new Error('Elise overlay: RGB changed; refusing build');
  const output = modified ? encodePng(image) : buffer;
  if (modified && rgbDigest(decodePng(output)) !== originalRgb) throw new Error('Elise overlay: PNG roundtrip modified RGB');
  if (modified && alphaCoverage(decodePng(output), target) < 0.08) throw new Error('Elise overlay: PNG roundtrip lost mouth alpha');
  return { output, modified, before, coverage, rgbSha256: originalRgb };
}
function run(assetDir = ASSETS) {
  // Compute BOTH variants first; do not partially repair a single frame if
  // the other fails format/registration validation.
  const prepared = FILES.map(name => ({ name, file: path.join(assetDir, name),
    original: fs.readFileSync(path.join(assetDir, name)) }));
  const results = prepared.map(item => ({ ...item, ...repair(item.original) }));
  const originalDimensions = prepared.map(item => {
    const image = decodePng(item.original);
    return [image.width, image.height];
  });
  if (originalDimensions[0][0] !== originalDimensions[1][0] ||
      originalDimensions[0][1] !== originalDimensions[1][1]) {
    throw new Error('Elise overlay: closed/open dimensions disagree');
  }
  for (const item of results) if (item.modified) fs.writeFileSync(item.file, item.output);
  const summary = results.map(item => ({ name: item.name, modified: item.modified,
    coverageBefore: item.before, coverageAfter: item.coverage, rgbSha256: item.rgbSha256 }));
  console.log('[Elise mouth alpha]', JSON.stringify(summary));
  return summary;
}
if (require.main === module) run();
module.exports = { decodePng, encodePng, bounds, alphaCoverage, rgbDigest, repair, run, MOUTH, RETIRED };
