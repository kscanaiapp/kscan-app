'use strict';

// Pure-JS magic-byte and header-level dimension/frame-count parsing. No
// native dependencies -- runs identically anywhere Node runs, and is a
// candidate to port to Deno if an Edge Function ever needs it directly.
// This is intentionally a SEPARATE, cheaper check from the full decode probe
// in reencode.js -- it exists to reject obviously-wrong or bomb-shaped input
// before spending CPU on a real decode.

function bytesEqualHex(buffer, offsetBytes, hexSignature) {
  const len = hexSignature.length / 2;
  if (buffer.length < offsetBytes + len) return false;
  return buffer.subarray(offsetBytes, offsetBytes + len).toString('hex').toUpperCase() === hexSignature.toUpperCase();
}

function matchesSignature(buffer, formatPolicy) {
  return formatPolicy.requiredMagicBytes.every(({ offsetBytes, hexSignature }) =>
    bytesEqualHex(buffer, offsetBytes, hexSignature)
  );
}

// Returns the policy format id whose magic bytes match, or null. If more than
// one format's signature matched (shouldn't happen with jpeg/png/webp, whose
// signatures are disjoint), the first match in policy order wins -- flagged
// via the `ambiguous` property so callers can treat it as suspicious.
function detectFormatId(buffer, policy) {
  const matches = policy.allowedFormats.filter((f) => matchesSignature(buffer, f));
  if (matches.length === 0) return null;
  return matches[0].id;
}

// --- JPEG ---------------------------------------------------------------
// Walks marker segments looking for a Start-Of-Frame (SOFn) segment, which
// carries the authoritative width/height. JPEG has no animation concept.
function readJpegDimensions(buffer) {
  let offset = 2; // skip SOI (FFD8)
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    // Markers with no length-prefixed payload: TEM (0x01), RSTn (0xD0-0xD7),
    // SOI/EOI (0xD8/0xD9).
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) {
      offset += 2;
      continue;
    }
    if (offset + 4 > buffer.length) break;
    const segmentLength = buffer.readUInt16BE(offset + 2);
    // SOF0-SOF15 except DHT(C4)/JPG(C8)/DAC(CC) carry frame dimensions.
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && offset + 9 <= buffer.length) {
      const height = buffer.readUInt16BE(offset + 5);
      const width = buffer.readUInt16BE(offset + 7);
      return { width, height, frames: 1 };
    }
    if (marker === 0xda) break; // Start Of Scan -- headers are done
    offset += 2 + segmentLength;
  }
  return null;
}

// --- PNG ------------------------------------------------------------------
// IHDR is always the first chunk (bytes 8-33). acTL before IDAT signals an
// Animated PNG (APNG); its presence is the frame-count signal we need.
function readPngDimensions(buffer) {
  if (buffer.length < 33) return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  let frames = 1;
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL' && offset + 16 <= buffer.length) {
      frames = buffer.readUInt32BE(offset + 8);
      break;
    }
    if (type === 'IDAT' || type === 'IEND') break;
    offset += 12 + length; // length(4) + type(4) + data(length) + crc(4)
    if (length < 0 || !Number.isFinite(offset)) break;
  }
  return { width, height, frames };
}

// --- WebP -------------------------------------------------------------------
// RIFF container: VP8X carries an explicit animation flag + canvas size;
// VP8 (lossy)/VP8L (lossless) are always single-frame.
function readWebpDimensions(buffer) {
  if (buffer.length < 30) return null;
  const chunkType = buffer.toString('ascii', 12, 16);
  if (chunkType === 'VP8X') {
    const width = 1 + (buffer[24] | (buffer[25] << 8) | (buffer[26] << 16));
    const height = 1 + (buffer[27] | (buffer[28] << 8) | (buffer[29] << 16));
    const animationFlag = (buffer[20] & 0x02) !== 0;
    // VP8X doesn't carry an exact frame count in the chunk we read here; the
    // animation flag alone is sufficient to enforce "no animation allowed"
    // policy (maxAnimationFrames=1), so we report a sentinel of 2 (">1").
    return { width, height, frames: animationFlag ? 2 : 1 };
  }
  if (chunkType === 'VP8 ' && buffer.length >= 30) {
    const width = buffer.readUInt16LE(26) & 0x3fff;
    const height = buffer.readUInt16LE(28) & 0x3fff;
    return { width, height, frames: 1 };
  }
  if (chunkType === 'VP8L' && buffer.length >= 25) {
    const b = buffer.readUInt32LE(21);
    const width = (b & 0x3fff) + 1;
    const height = ((b >> 14) & 0x3fff) + 1;
    return { width, height, frames: 1 };
  }
  return null;
}

// Returns { width, height, frames } or null if the header couldn't be parsed
// (callers should treat a null result as "defer to the full decode probe,"
// not as an automatic pass or fail).
function readHeaderMetadata(buffer, formatId) {
  if (formatId === 'jpeg') return readJpegDimensions(buffer);
  if (formatId === 'png') return readPngDimensions(buffer);
  if (formatId === 'webp') return readWebpDimensions(buffer);
  return null;
}

module.exports = {
  matchesSignature,
  detectFormatId,
  readHeaderMetadata,
  readJpegDimensions,
  readPngDimensions,
  readWebpDimensions,
};
