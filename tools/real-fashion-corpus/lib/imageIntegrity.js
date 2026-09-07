'use strict';

/**
 * Asset structural integrity (mission section 27, design DM-04).
 *
 * QC must make it impossible to SILENTLY accept an unreadable or corrupt
 * asset. This module answers "is this file structurally a real image of the
 * format it claims", with zero dependencies, by walking documented container
 * structure:
 *
 *   JPEG - SOI, a full marker-segment walk, a real SOFn frame header for
 *          dimensions, and a terminating EOI. Catches truncation, a saved
 *          HTML error page renamed .jpg, and garbage appended or prepended.
 *   PNG  - signature, a full chunk walk with PER-CHUNK CRC-32 VERIFICATION,
 *          IHDR first, IEND last. The CRC check is genuine bit-rot detection,
 *          not an inference.
 *
 * What it deliberately does NOT do is judge whether a photograph is blurry,
 * badly lit, or of the wrong garment. That is a human QC judgment, recorded
 * as such, rather than a number this module would have to invent.
 */

const crypto = require('node:crypto');
const { walkJpegSegments, walkPngChunks, detectFormat, PNG_SIGNATURE } = require('./exif');

/* ------------------------------------------------------------------ *
 * CRC-32 (PNG's polynomial, table-driven)
 * ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/* ------------------------------------------------------------------ *
 * JPEG
 * ------------------------------------------------------------------ */

/** SOF markers that carry a frame header. SOF4/SOF8/SOF12 are not frame markers. */
const SOF_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function inspectJpeg(buffer) {
  const findings = [];
  const walk = walkJpegSegments(buffer);
  if (!walk.ok) {
    return { readable: false, format: 'jpeg', dimensions: null, findings: [walk.error] };
  }

  let dimensions = null;
  for (const segment of walk.segments) {
    if (!SOF_MARKERS.has(segment.marker)) continue;
    // SOFn payload: precision(1), height(2), width(2), components(1)...
    const data = buffer.subarray(segment.dataStart, segment.dataEnd);
    if (data.length < 5) {
      findings.push('jpeg_sof_frame_header_truncated');
      break;
    }
    dimensions = { height: data.readUInt16BE(1), width: data.readUInt16BE(3) };
    break;
  }

  if (!dimensions) findings.push('jpeg_no_sof_frame_header');

  // The scan must actually terminate with EOI. A truncated upload - the most
  // common real corruption - stops mid-scan with no EOI.
  if (walk.scanStart !== null && walk.scanStart !== undefined) {
    const tail = buffer.subarray(walk.scanStart);
    let hasEoi = false;
    for (let i = 0; i + 1 < tail.length; i += 1) {
      if (tail[i] === 0xff && tail[i + 1] === 0xd9) {
        hasEoi = true;
        break;
      }
    }
    if (!hasEoi) findings.push('jpeg_scan_never_terminates_with_eoi');
    if (tail.length === 0) findings.push('jpeg_scan_data_is_empty');
  } else if (walk.endOfImage === null || walk.endOfImage === undefined) {
    findings.push('jpeg_no_scan_and_no_eoi');
  }

  return {
    readable: findings.length === 0,
    format: 'jpeg',
    dimensions,
    findings,
  };
}

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

function inspectPng(buffer) {
  const findings = [];
  const walk = walkPngChunks(buffer);
  if (!walk.ok) {
    return { readable: false, format: 'png', dimensions: null, findings: [walk.error] };
  }

  if (walk.chunks.length === 0 || walk.chunks[0].type !== 'IHDR') {
    findings.push('png_first_chunk_is_not_ihdr');
  }
  if (walk.chunks[walk.chunks.length - 1].type !== 'IEND') {
    findings.push('png_last_chunk_is_not_iend');
  }
  if (walk.trailingBytes > 0) {
    findings.push(`png_${walk.trailingBytes}_trailing_bytes_after_iend`);
  }
  if (!walk.chunks.some((chunk) => chunk.type === 'IDAT')) {
    findings.push('png_no_idat_chunk_carries_no_image_data');
  }

  // Per-chunk CRC-32. This is the real integrity check.
  for (const chunk of walk.chunks) {
    const declared = buffer.readUInt32BE(chunk.dataEnd);
    const computed = crc32(buffer.subarray(chunk.dataStart - 4, chunk.dataEnd));
    if (declared !== computed) {
      findings.push(
        `png_chunk_crc_mismatch:${chunk.type}:declared=${declared.toString(16)}:computed=${computed.toString(16)}`,
      );
    }
  }

  let dimensions = null;
  const ihdr = walk.chunks.find((chunk) => chunk.type === 'IHDR');
  if (ihdr && ihdr.length >= 8) {
    dimensions = { width: buffer.readUInt32BE(ihdr.dataStart), height: buffer.readUInt32BE(ihdr.dataStart + 4) };
    if (dimensions.width === 0 || dimensions.height === 0) findings.push('png_ihdr_declares_zero_dimension');
  } else {
    findings.push('png_ihdr_missing_or_truncated');
  }

  return { readable: findings.length === 0, format: 'png', dimensions, findings };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function sha256Hex(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Inspect an image buffer.
 *
 * Returns { readable, format, dimensions, byteSize, sha256, findings }.
 * `findings` is empty exactly when `readable` is true, and every entry is a
 * machine-readable reason string suitable for an auditable QC rejection.
 */
function inspectImage(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return { readable: false, format: null, dimensions: null, byteSize: 0, sha256: null, findings: ['not_a_buffer'] };
  }
  if (buffer.length === 0) {
    return { readable: false, format: null, dimensions: null, byteSize: 0, sha256: sha256Hex(buffer), findings: ['zero_byte_file'] };
  }

  const format = detectFormat(buffer);
  const base = { byteSize: buffer.length, sha256: sha256Hex(buffer) };

  if (format === 'jpeg') return { ...inspectJpeg(buffer), ...base };
  if (format === 'png') return { ...inspectPng(buffer), ...base };

  return {
    readable: false,
    format: null,
    dimensions: null,
    ...base,
    findings: ['unrecognised_container_signature'],
  };
}

module.exports = { inspectImage, sha256Hex, crc32, PNG_SIGNATURE };
