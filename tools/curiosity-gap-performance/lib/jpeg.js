'use strict';
/**
 * Minimal JPEG header reader.
 *
 * WHY THIS EXISTS RATHER THAN A DEPENDENCY: §17 forbids adding a package unless
 * unavoidable, and this lab needs exactly one fact from an image — its
 * intrinsic pixel dimensions — so it can compute how the documented
 * `resize({ width: 896 })` transform changes the pixel count. Pulling in sharp
 * or jimp to read two 16-bit integers would be a poor trade, and neither is
 * installed.
 *
 * What this CANNOT do, stated plainly: it cannot re-encode. So it cannot
 * produce the true post-compression byte count for JPEG quality 0.65. That
 * number is PENDING_RUNTIME (see the blocker ledger); what this module gives
 * instead is a real, in-repo-derived bytes-per-pixel anchor from the committed
 * fixtures, which is an OBSERVED range rather than an invented coefficient.
 */

const fs = require('node:fs');

/** SOF markers that carry frame dimensions. SOF4/SOF8/SOF12 are not frame markers. */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

/**
 * Read intrinsic dimensions from a JPEG buffer.
 * Returns { width, height } or throws — a silent 0x0 would poison the model.
 */
function readJpegDimensions(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('readJpegDimensions requires a Buffer');
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    throw new Error('not a JPEG (missing SOI marker)');
  }
  let offset = 2;
  while (offset < buffer.length) {
    if (buffer[offset] !== 0xff) {
      // Resynchronise: fill bytes are legal between segments.
      offset += 1;
      continue;
    }
    let marker = buffer[offset + 1];
    while (marker === 0xff) {
      offset += 1;
      marker = buffer[offset + 1];
    }
    offset += 2;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan
    if (offset + 1 >= buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset);
    if (SOF_MARKERS.has(marker)) {
      // segment: [len:2][precision:1][height:2][width:2]
      const height = buffer.readUInt16BE(offset + 3);
      const width = buffer.readUInt16BE(offset + 5);
      if (width === 0 || height === 0) throw new Error('JPEG reported a zero dimension');
      return { width, height };
    }
    offset += segmentLength;
  }
  throw new Error('no SOF marker found; cannot read JPEG dimensions');
}

/**
 * Apply the Scanner's documented transform to a source image's geometry.
 *
 * `services/imageUtils.js` calls `manipulateAsync(uri, [{ resize: { width: 896 } }], ...)`.
 * expo-image-manipulator's `resize` with only a width sets that width exactly
 * and scales height proportionally — so a source NARROWER than 896px is
 * UPSCALED, not left alone. That asymmetry is a real finding, not a detail:
 * upscaling adds pixels and therefore adds encoded bytes for zero added detail.
 */
function applyScannerResize(source, targetWidth) {
  const scale = targetWidth / source.width;
  const width = targetWidth;
  const height = Math.round(source.height * scale);
  return {
    width,
    height,
    scale,
    pixels: width * height,
    upscaled: scale > 1,
  };
}

function readFixture(filePath) {
  const buffer = fs.readFileSync(filePath);
  const dims = readJpegDimensions(buffer);
  return {
    bytes: buffer.length,
    width: dims.width,
    height: dims.height,
    pixels: dims.width * dims.height,
    bytes_per_pixel: buffer.length / (dims.width * dims.height),
  };
}

module.exports = { readJpegDimensions, applyScannerResize, readFixture, SOF_MARKERS };
