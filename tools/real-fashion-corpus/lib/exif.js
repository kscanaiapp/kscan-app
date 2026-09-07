'use strict';

/**
 * EXIF / embedded-metadata policy (mission section 17).
 *
 *   "Device metadata may be extracted from EXIF when useful. Before corpus
 *    storage: STRIP GPS, STRIP LOCATION METADATA, STRIP UNNECESSARY
 *    IDENTIFIERS. QC must reject an asset retaining location EXIF."
 *
 * Zero dependencies, by design: this repository has not authorized an image
 * library, and a privacy control that cannot be read end-to-end by a reviewer
 * is not much of a control. Everything here is a byte walk over documented
 * container formats.
 *
 * Three carriers of location are inspected, because stripping only the
 * obvious one is how location survives sanitization in practice:
 *
 *   1. EXIF GPS IFD          - the well-known one (TIFF tag 0x8825).
 *   2. XMP                   - Adobe's XML sidecar, embedded in JPEG APP1 or
 *                              a PNG iTXt chunk, carrying exif:GPSLatitude.
 *   3. IPTC-IIM (JPEG APP13) - Photoshop's block, carrying city / sublocation
 *                              / province / country as plain text.
 *
 * This module reports and strips; it never silently "fixes" a file in place.
 */

const EXIF_POLICY_VERSION = require('./constants').EXIF_POLICY_VERSION;

/* ------------------------------------------------------------------ *
 * TIFF / EXIF
 * ------------------------------------------------------------------ */

const TAG_GPS_IFD_POINTER = 0x8825;
const TAG_EXIF_IFD_POINTER = 0x8769;
const TAG_ORIENTATION = 0x0112;
const TAG_MAKE = 0x010f;
const TAG_MODEL = 0x0110;
const TAG_IMAGE_WIDTH = 0x0100;
const TAG_IMAGE_HEIGHT = 0x0101;

/** Byte length of one TIFF value of each type code. */
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };

class TiffReader {
  constructor(buffer, littleEndian) {
    this.buf = buffer;
    this.le = littleEndian;
  }

  u16(offset) {
    if (offset + 2 > this.buf.length) throw new RangeError('tiff_read_out_of_bounds');
    return this.le ? this.buf.readUInt16LE(offset) : this.buf.readUInt16BE(offset);
  }

  u32(offset) {
    if (offset + 4 > this.buf.length) throw new RangeError('tiff_read_out_of_bounds');
    return this.le ? this.buf.readUInt32LE(offset) : this.buf.readUInt32BE(offset);
  }
}

/**
 * Read one IFD's entries. Returns { entries: [{tag,type,count,valueOffset}],
 * nextIfdOffset }. Bounded and defensive: a malformed EXIF block must produce
 * a parse error we can report, never an exception that escapes QC.
 */
function readIfd(reader, offset) {
  const count = reader.u16(offset);
  // A wildly large entry count is corruption, not a 65535-tag image.
  if (count > 4096) throw new RangeError('tiff_ifd_entry_count_implausible');
  const entries = [];
  for (let i = 0; i < count; i += 1) {
    const base = offset + 2 + i * 12;
    entries.push({
      tag: reader.u16(base),
      type: reader.u16(base + 2),
      count: reader.u32(base + 4),
      valueOffset: base + 8,
    });
  }
  return { entries, nextIfdOffset: reader.u32(offset + 2 + count * 12) };
}

/** Resolve an entry's value bytes, following the offset when it does not fit inline. */
function entryBytes(reader, entry) {
  const size = (TYPE_SIZE[entry.type] || 1) * entry.count;
  if (size <= 4) return reader.buf.subarray(entry.valueOffset, entry.valueOffset + size);
  const pointer = reader.u32(entry.valueOffset);
  if (pointer + size > reader.buf.length) throw new RangeError('tiff_value_out_of_bounds');
  return reader.buf.subarray(pointer, pointer + size);
}

function entryAsAscii(reader, entry) {
  try {
    return entryBytes(reader, entry).toString('latin1').replace(/\0+$/, '').trim();
  } catch {
    return null;
  }
}

function entryAsNumber(reader, entry) {
  try {
    if (entry.type === 3) return reader.u16(entry.valueOffset);
    if (entry.type === 4) return reader.u32(entry.valueOffset);
  } catch {
    /* fall through */
  }
  return null;
}

/**
 * Parse a TIFF block (the payload of an EXIF APP1 segment after "Exif\0\0",
 * or of a PNG eXIf chunk).
 */
function parseTiffBlock(tiff) {
  const result = {
    parsed: false,
    parseError: null,
    gpsIfdPresent: false,
    gpsTagCount: 0,
    device: { make: null, model: null },
    orientation: null,
    dimensions: null,
  };

  if (!tiff || tiff.length < 8) {
    result.parseError = 'tiff_block_too_short';
    return result;
  }

  const marker = tiff.toString('latin1', 0, 2);
  if (marker !== 'II' && marker !== 'MM') {
    result.parseError = `tiff_bad_byte_order_marker:${marker}`;
    return result;
  }
  const reader = new TiffReader(tiff, marker === 'II');

  try {
    if (reader.u16(2) !== 0x002a) {
      result.parseError = 'tiff_bad_magic';
      return result;
    }
    const ifd0Offset = reader.u32(4);
    const { entries } = readIfd(reader, ifd0Offset);

    let width = null;
    let height = null;
    for (const entry of entries) {
      switch (entry.tag) {
        case TAG_GPS_IFD_POINTER: {
          result.gpsIfdPresent = true;
          // Count the tags actually inside the GPS IFD. A pointer to an empty
          // GPS IFD is still reported as present - the pointer alone is a
          // location-metadata artefact and the policy strips it either way.
          try {
            const gpsOffset = reader.u32(entry.valueOffset);
            result.gpsTagCount = readIfd(reader, gpsOffset).entries.length;
          } catch {
            result.gpsTagCount = 0;
          }
          break;
        }
        case TAG_MAKE:
          result.device.make = entryAsAscii(reader, entry);
          break;
        case TAG_MODEL:
          result.device.model = entryAsAscii(reader, entry);
          break;
        case TAG_ORIENTATION:
          result.orientation = entryAsNumber(reader, entry);
          break;
        case TAG_IMAGE_WIDTH:
          width = entryAsNumber(reader, entry);
          break;
        case TAG_IMAGE_HEIGHT:
          height = entryAsNumber(reader, entry);
          break;
        case TAG_EXIF_IFD_POINTER:
          // Present but not walked: nothing inside the Exif sub-IFD carries
          // location, and walking it would add parse surface for no gain.
          break;
        default:
          break;
      }
    }
    if (width && height) result.dimensions = { width, height };
    result.parsed = true;
  } catch (err) {
    result.parseError = err.message || 'tiff_parse_failed';
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * XMP and IPTC location carriers
 * ------------------------------------------------------------------ */

const XMP_GPS_PATTERNS = [
  /exif:GPSLatitude/i,
  /exif:GPSLongitude/i,
  /exif:GPSAltitude/i,
  /photoshop:City/i,
  /photoshop:State/i,
  /photoshop:Country/i,
  /Iptc4xmpCore:Location/i,
];

function xmpCarriesLocation(text) {
  return XMP_GPS_PATTERNS.some((pattern) => pattern.test(text));
}

/** IPTC-IIM record 2 datasets that describe where a photo was taken. */
const IPTC_LOCATION_DATASETS = new Set([90, 92, 95, 100, 101]);

function iptcCarriesLocation(block) {
  // IPTC-IIM entries: 0x1C, record, dataset, 2-byte length (big endian).
  for (let i = 0; i + 5 <= block.length; i += 1) {
    if (block[i] !== 0x1c) continue;
    const record = block[i + 1];
    const dataset = block[i + 2];
    if (record === 2 && IPTC_LOCATION_DATASETS.has(dataset)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * JPEG segment walk
 * ------------------------------------------------------------------ */

const EXIF_HEADER = Buffer.from('Exif\0\0', 'latin1');
const XMP_HEADER = Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1');
const PHOTOSHOP_HEADER = Buffer.from('Photoshop 3.0\0', 'latin1');

/**
 * Walk a JPEG's marker segments. Yields { marker, headerStart, dataStart,
 * dataEnd } for each APPn/other segment up to the start of scan data.
 */
function walkJpegSegments(buffer) {
  const segments = [];
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) {
    return { ok: false, error: 'jpeg_missing_soi', segments };
  }
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) return { ok: false, error: `jpeg_expected_marker_at_${offset}`, segments };
    let marker = buffer[offset + 1];
    // 0xFF fill bytes are legal padding before a marker.
    let markerOffset = offset + 1;
    while (marker === 0xff && markerOffset + 1 < buffer.length) {
      markerOffset += 1;
      marker = buffer[markerOffset];
    }
    if (marker === 0xd8) {
      offset = markerOffset + 1;
      continue;
    }
    if (marker === 0xd9) {
      segments.push({ marker, headerStart: markerOffset - 1, dataStart: markerOffset + 1, dataEnd: markerOffset + 1 });
      return { ok: true, segments, scanStart: null, endOfImage: markerOffset + 1 };
    }
    if (marker === 0xda) {
      // Start of scan: entropy-coded data follows, which is not marker-parsable.
      const length = buffer.readUInt16BE(markerOffset + 1);
      segments.push({
        marker,
        headerStart: markerOffset - 1,
        dataStart: markerOffset + 3,
        dataEnd: markerOffset + 1 + length,
      });
      return { ok: true, segments, scanStart: markerOffset + 1 + length, endOfImage: null };
    }
    if (markerOffset + 3 > buffer.length) return { ok: false, error: 'jpeg_truncated_segment_header', segments };
    const length = buffer.readUInt16BE(markerOffset + 1);
    if (length < 2) return { ok: false, error: 'jpeg_segment_length_too_small', segments };
    const dataEnd = markerOffset + 1 + length;
    if (dataEnd > buffer.length) return { ok: false, error: 'jpeg_segment_overruns_file', segments };
    segments.push({ marker, headerStart: markerOffset - 1, dataStart: markerOffset + 3, dataEnd });
    offset = dataEnd;
  }
  return { ok: false, error: 'jpeg_ran_off_end', segments };
}

/* ------------------------------------------------------------------ *
 * PNG chunk walk
 * ------------------------------------------------------------------ */

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function walkPngChunks(buffer) {
  const chunks = [];
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, error: 'png_bad_signature', chunks };
  }
  let offset = 8;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) return { ok: false, error: 'png_chunk_overruns_file', chunks };
    chunks.push({ type, start: offset, dataStart, dataEnd, end: dataEnd + 4, length });
    offset = dataEnd + 4;
    if (type === 'IEND') return { ok: true, chunks, trailingBytes: buffer.length - offset };
  }
  return { ok: false, error: 'png_missing_iend', chunks };
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

function detectFormat(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return 'jpeg';
  if (buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'png';
  return null;
}

/**
 * Inspect a JPEG or PNG for embedded metadata.
 *
 * Returns:
 *   {
 *     format, ok, error,
 *     locationPresent,                  <- the QC-relevant verdict
 *     locationCarriers: [ ... ],        <- WHICH carrier(s), so a rejection is actionable
 *     device: { make, model },
 *     orientation,
 *     exifPresent, xmpPresent, iptcPresent,
 *   }
 */
function inspectMetadata(buffer) {
  const format = detectFormat(buffer);
  const result = {
    format,
    ok: false,
    error: null,
    locationPresent: false,
    locationCarriers: [],
    device: { make: null, model: null },
    orientation: null,
    exifPresent: false,
    xmpPresent: false,
    iptcPresent: false,
    policyVersion: EXIF_POLICY_VERSION,
  };

  if (!format) {
    result.error = 'unsupported_or_unrecognised_container';
    return result;
  }

  const addCarrier = (carrier) => {
    result.locationPresent = true;
    if (!result.locationCarriers.includes(carrier)) result.locationCarriers.push(carrier);
  };

  if (format === 'jpeg') {
    const walk = walkJpegSegments(buffer);
    if (!walk.ok) {
      result.error = walk.error;
      return result;
    }
    for (const segment of walk.segments) {
      const data = buffer.subarray(segment.dataStart, segment.dataEnd);
      if (segment.marker === 0xe1) {
        if (data.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)) {
          result.exifPresent = true;
          const tiff = parseTiffBlock(data.subarray(EXIF_HEADER.length));
          if (tiff.gpsIfdPresent) addCarrier('EXIF_GPS_IFD');
          if (tiff.device.make) result.device.make = tiff.device.make;
          if (tiff.device.model) result.device.model = tiff.device.model;
          if (tiff.orientation !== null) result.orientation = tiff.orientation;
        } else if (data.subarray(0, XMP_HEADER.length).equals(XMP_HEADER)) {
          result.xmpPresent = true;
          if (xmpCarriesLocation(data.toString('utf8'))) addCarrier('XMP_LOCATION');
        }
      } else if (segment.marker === 0xed) {
        if (data.subarray(0, PHOTOSHOP_HEADER.length).equals(PHOTOSHOP_HEADER)) {
          result.iptcPresent = true;
          if (iptcCarriesLocation(data)) addCarrier('IPTC_LOCATION');
        }
      }
    }
    result.ok = true;
    return result;
  }

  const walk = walkPngChunks(buffer);
  if (!walk.ok) {
    result.error = walk.error;
    return result;
  }
  for (const chunk of walk.chunks) {
    const data = buffer.subarray(chunk.dataStart, chunk.dataEnd);
    if (chunk.type === 'eXIf') {
      result.exifPresent = true;
      const tiff = parseTiffBlock(data);
      if (tiff.gpsIfdPresent) addCarrier('EXIF_GPS_IFD');
      if (tiff.device.make) result.device.make = tiff.device.make;
      if (tiff.device.model) result.device.model = tiff.device.model;
      if (tiff.orientation !== null) result.orientation = tiff.orientation;
    } else if (chunk.type === 'iTXt' || chunk.type === 'tEXt' || chunk.type === 'zTXt') {
      const text = data.toString('latin1');
      if (text.startsWith('XML:com.adobe.xmp')) {
        result.xmpPresent = true;
        if (xmpCarriesLocation(text)) addCarrier('XMP_LOCATION');
      }
    }
  }
  result.ok = true;
  return result;
}

/**
 * Build a minimal EXIF APP1 payload carrying only Orientation.
 *
 * Why bother: stripping the whole EXIF block is the safe privacy move, but it
 * also discards the orientation flag, and a phone photo that was portrait
 * becomes sideways. So the sanitizer keeps exactly one tag and rebuilds the
 * block from scratch rather than editing the original in place - a rebuilt
 * block cannot smuggle a field we failed to notice.
 */
function buildOrientationOnlyExif(orientation) {
  const tiff = Buffer.alloc(26);
  tiff.write('MM', 0, 'latin1'); // big endian
  tiff.writeUInt16BE(0x002a, 2);
  tiff.writeUInt32BE(8, 4); // IFD0 at offset 8
  tiff.writeUInt16BE(1, 8); // one entry
  tiff.writeUInt16BE(TAG_ORIENTATION, 10);
  tiff.writeUInt16BE(3, 12); // SHORT
  tiff.writeUInt32BE(1, 14); // count 1
  tiff.writeUInt16BE(orientation, 18); // inline value, high-order half of the 4-byte slot
  tiff.writeUInt16BE(0, 20);
  tiff.writeUInt32BE(0, 22); // no next IFD
  return Buffer.concat([EXIF_HEADER, tiff]);
}

/**
 * Produce a sanitized copy with every location carrier removed.
 *
 * Returns { ok, buffer, removed: [...], preservedOrientation }.
 * Never mutates the input. Returns ok:false rather than a partially-cleaned
 * buffer if the container cannot be parsed - a half-sanitized image is worse
 * than a refused one.
 */
function stripLocationMetadata(buffer) {
  const format = detectFormat(buffer);
  if (!format) return { ok: false, error: 'unsupported_or_unrecognised_container', removed: [] };

  const removed = [];
  let preservedOrientation = null;

  if (format === 'jpeg') {
    const walk = walkJpegSegments(buffer);
    if (!walk.ok) return { ok: false, error: walk.error, removed };

    const pieces = [Buffer.from([0xff, 0xd8])];
    for (const segment of walk.segments) {
      const data = buffer.subarray(segment.dataStart, segment.dataEnd);
      const whole = buffer.subarray(segment.headerStart, segment.dataEnd);

      if (segment.marker === 0xe1 && data.subarray(0, EXIF_HEADER.length).equals(EXIF_HEADER)) {
        const tiff = parseTiffBlock(data.subarray(EXIF_HEADER.length));
        removed.push('EXIF');
        if (tiff.orientation !== null && tiff.orientation >= 1 && tiff.orientation <= 8) {
          preservedOrientation = tiff.orientation;
          const payload = buildOrientationOnlyExif(tiff.orientation);
          const header = Buffer.alloc(4);
          header.writeUInt16BE(0xffe1, 0);
          header.writeUInt16BE(payload.length + 2, 2);
          pieces.push(header, payload);
        }
        continue;
      }
      if (segment.marker === 0xe1 && data.subarray(0, XMP_HEADER.length).equals(XMP_HEADER)) {
        removed.push('XMP');
        continue;
      }
      if (segment.marker === 0xed && data.subarray(0, PHOTOSHOP_HEADER.length).equals(PHOTOSHOP_HEADER)) {
        removed.push('IPTC');
        continue;
      }
      if (segment.marker === 0xfe) {
        // COM comment: "unnecessary identifiers" under mission section 17.
        removed.push('COMMENT');
        continue;
      }

      pieces.push(whole);
      if (segment.marker === 0xda) {
        // Everything after the scan header is entropy-coded image data; copy verbatim.
        pieces.push(buffer.subarray(segment.dataEnd));
      }
    }
    return { ok: true, buffer: Buffer.concat(pieces), removed, preservedOrientation };
  }

  const walk = walkPngChunks(buffer);
  if (!walk.ok) return { ok: false, error: walk.error, removed };

  const pieces = [PNG_SIGNATURE];
  for (const chunk of walk.chunks) {
    if (chunk.type === 'eXIf') {
      removed.push('EXIF');
      continue;
    }
    if (chunk.type === 'iTXt' || chunk.type === 'tEXt' || chunk.type === 'zTXt') {
      removed.push(`TEXT:${chunk.type}`);
      continue;
    }
    pieces.push(buffer.subarray(chunk.start, chunk.end));
  }
  return { ok: true, buffer: Buffer.concat(pieces), removed, preservedOrientation: null };
}

module.exports = {
  EXIF_POLICY_VERSION,
  inspectMetadata,
  stripLocationMetadata,
  detectFormat,
  walkJpegSegments,
  walkPngChunks,
  parseTiffBlock,
  PNG_SIGNATURE,
};
