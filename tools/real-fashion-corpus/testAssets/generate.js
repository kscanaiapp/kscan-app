'use strict';

/**
 * PIPELINE_TEST_ASSET generator (mission section 26).
 *
 * These bytes are PROCEDURALLY GENERATED. They are not photographs, they are
 * not of any garment, and they carry no ground truth. Their only job is to
 * prove the corpus infrastructure works: corrupt-image detection, hash
 * mismatch, duplicate detection, pair validation, EXIF rejection.
 *
 * Mission section 26 is absolute about what they may never do:
 *   - enter the real corpus
 *   - count toward corpus N
 *   - appear in a real metric
 *   - be mislabeled as real
 * The real-corpus validator rejects them by tier, and invariant test 42.1
 * proves it.
 *
 * The PNGs produced here are genuine, fully decodable PNG files (real IHDR,
 * real zlib-compressed IDAT scanlines, real per-chunk CRC-32). The JPEGs are
 * structurally valid JPEG *containers* - correct SOI, APP1, SOFn frame
 * header, SOS and EOI - with placeholder entropy-coded data. That is exactly
 * enough to exercise the container walk, the EXIF carriers and the integrity
 * checks, which is all a pipeline-test asset is for. It is stated plainly
 * here so nobody later mistakes one for a picture.
 */

const zlib = require('node:zlib');
const { crc32 } = require('../lib/imageIntegrity');
const { PNG_SIGNATURE } = require('../lib/exif');

/* ------------------------------------------------------------------ *
 * PNG
 * ------------------------------------------------------------------ */

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData), 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/**
 * A real, decodable 8-bit RGB PNG. `pattern(x, y)` returns [r, g, b] so a
 * caller can make two visually different assets (and therefore two different
 * hashes) without any randomness - determinism matters for hash tests.
 */
function makePng({ width = 8, height = 8, pattern = (x, y) => [(x * 32) % 256, (y * 32) % 256, 128], extraChunks = [] } = {}) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type 2 = truecolour RGB
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter type 0 (None) for this scanline
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pattern(x, y);
      raw[offset] = r & 0xff;
      raw[offset + 1] = g & 0xff;
      raw[offset + 2] = b & 0xff;
      offset += 3;
    }
  }

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    ...extraChunks,
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/** A PNG carrying an XMP text chunk that claims a GPS location. */
function makePngWithXmpLocation(options = {}) {
  const xmp =
    'XML:com.adobe.xmp\0\0\0\0\0' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description exif:GPSLatitude="51,30.000N" exif:GPSLongitude="0,7.000W"/></rdf:RDF></x:xmpmeta>';
  return makePng({ ...options, extraChunks: [pngChunk('iTXt', Buffer.from(xmp, 'latin1'))] });
}

/** A PNG whose IDAT CRC has been corrupted - genuine bit-rot, detectable. */
function makeCorruptCrcPng(options = {}) {
  const png = makePng(options);
  const copy = Buffer.from(png);
  // Flip the last byte of the IDAT chunk's CRC. The IEND chunk is a fixed
  // 12 bytes at the end, so the IDAT CRC's final byte sits 13 bytes back.
  copy[copy.length - 13] ^= 0xff;
  return copy;
}

/** A PNG truncated mid-stream, as a half-finished upload would be. */
function makeTruncatedPng(options = {}) {
  const png = makePng(options);
  return png.subarray(0, Math.max(20, png.length - 20));
}

/* ------------------------------------------------------------------ *
 * TIFF / EXIF blocks
 * ------------------------------------------------------------------ */

const TIFF_TYPE_ASCII = 2;
const TIFF_TYPE_SHORT = 3;
const TIFF_TYPE_LONG = 4;
const TIFF_TYPE_RATIONAL = 5;

/**
 * Build a big-endian TIFF block from a declarative IFD description.
 * Entries whose value does not fit in four bytes are spilled to a data area
 * laid out immediately after the IFDs, exactly as a real encoder would.
 */
function buildTiff({ ifd0 = [], gps = null }) {
  const header = Buffer.alloc(8);
  header.write('MM', 0, 'latin1');
  header.writeUInt16BE(0x002a, 2);
  header.writeUInt32BE(8, 4);

  const entries = [...ifd0];
  const gpsEntries = gps || [];

  const ifd0Size = 2 + entries.length * 12 + 4 + (gps ? 12 : 0);
  const gpsIfdOffset = gps ? 8 + ifd0Size : null;
  const gpsIfdSize = gps ? 2 + gpsEntries.length * 12 + 4 : 0;
  let dataOffset = 8 + ifd0Size + gpsIfdSize;

  const dataParts = [];

  function encodeEntry(entry, target, position) {
    target.writeUInt16BE(entry.tag, position);
    target.writeUInt16BE(entry.type, position + 2);
    const values = Array.isArray(entry.value) ? entry.value : [entry.value];

    if (entry.type === TIFF_TYPE_ASCII) {
      const bytes = Buffer.from(`${entry.value}\0`, 'latin1');
      target.writeUInt32BE(bytes.length, position + 4);
      if (bytes.length <= 4) {
        bytes.copy(target, position + 8);
      } else {
        target.writeUInt32BE(dataOffset, position + 8);
        dataParts.push(bytes);
        dataOffset += bytes.length;
      }
      return;
    }

    target.writeUInt32BE(values.length, position + 4);
    if (entry.type === TIFF_TYPE_SHORT && values.length === 1) {
      target.writeUInt16BE(values[0], position + 8);
      return;
    }
    if (entry.type === TIFF_TYPE_LONG && values.length === 1) {
      target.writeUInt32BE(values[0], position + 8);
      return;
    }
    if (entry.type === TIFF_TYPE_RATIONAL) {
      const bytes = Buffer.alloc(values.length * 8);
      values.forEach(([numerator, denominator], index) => {
        bytes.writeUInt32BE(numerator, index * 8);
        bytes.writeUInt32BE(denominator, index * 8 + 4);
      });
      target.writeUInt32BE(dataOffset, position + 8);
      dataParts.push(bytes);
      dataOffset += bytes.length;
      return;
    }
    throw new Error(`unsupported test-asset TIFF entry: tag ${entry.tag}`);
  }

  const ifd0Buffer = Buffer.alloc(ifd0Size);
  const totalIfd0Entries = entries.length + (gps ? 1 : 0);
  ifd0Buffer.writeUInt16BE(totalIfd0Entries, 0);
  entries.forEach((entry, index) => encodeEntry(entry, ifd0Buffer, 2 + index * 12));
  if (gps) {
    const position = 2 + entries.length * 12;
    ifd0Buffer.writeUInt16BE(0x8825, position);
    ifd0Buffer.writeUInt16BE(TIFF_TYPE_LONG, position + 2);
    ifd0Buffer.writeUInt32BE(1, position + 4);
    ifd0Buffer.writeUInt32BE(gpsIfdOffset, position + 8);
  }
  ifd0Buffer.writeUInt32BE(0, 2 + totalIfd0Entries * 12);

  const gpsBuffer = gps ? Buffer.alloc(gpsIfdSize) : Buffer.alloc(0);
  if (gps) {
    gpsBuffer.writeUInt16BE(gpsEntries.length, 0);
    gpsEntries.forEach((entry, index) => encodeEntry(entry, gpsBuffer, 2 + index * 12));
    gpsBuffer.writeUInt32BE(0, 2 + gpsEntries.length * 12);
  }

  return Buffer.concat([header, ifd0Buffer, gpsBuffer, ...dataParts]);
}

/** An EXIF block carrying a GPS IFD - the thing mission section 17 forbids. */
function buildExifWithGps({ make = 'TestPhone', model = 'TestModel 1', orientation = 6 } = {}) {
  return buildTiff({
    ifd0: [
      { tag: 0x010f, type: TIFF_TYPE_ASCII, value: make },
      { tag: 0x0110, type: TIFF_TYPE_ASCII, value: model },
      { tag: 0x0112, type: TIFF_TYPE_SHORT, value: orientation },
    ],
    gps: [
      { tag: 0x0001, type: TIFF_TYPE_ASCII, value: 'N' },
      { tag: 0x0002, type: TIFF_TYPE_RATIONAL, value: [[51, 1], [30, 1], [0, 1]] },
      { tag: 0x0003, type: TIFF_TYPE_ASCII, value: 'W' },
      { tag: 0x0004, type: TIFF_TYPE_RATIONAL, value: [[0, 1], [7, 1], [0, 1]] },
    ],
  });
}

/** The same EXIF block with no GPS IFD - device metadata only, which is allowed. */
function buildExifWithoutGps({ make = 'TestPhone', model = 'TestModel 1', orientation = 6 } = {}) {
  return buildTiff({
    ifd0: [
      { tag: 0x010f, type: TIFF_TYPE_ASCII, value: make },
      { tag: 0x0110, type: TIFF_TYPE_ASCII, value: model },
      { tag: 0x0112, type: TIFF_TYPE_SHORT, value: orientation },
    ],
  });
}

/* ------------------------------------------------------------------ *
 * JPEG
 * ------------------------------------------------------------------ */

function jpegSegment(marker, payload) {
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xff00 | marker, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([header, payload]);
}

/**
 * A structurally valid JPEG container. See the module header: the entropy-
 * coded payload is a placeholder, which is all a pipeline-test asset needs.
 */
function makeJpeg({ width = 64, height = 48, exif = null, xmp = null, iptc = null, comment = null, terminate = true } = {}) {
  const parts = [Buffer.from([0xff, 0xd8])];

  if (exif) parts.push(jpegSegment(0xe1, Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), exif])));
  if (xmp) {
    parts.push(
      jpegSegment(0xe1, Buffer.concat([Buffer.from('http://ns.adobe.com/xap/1.0/\0', 'latin1'), Buffer.from(xmp, 'utf8')])),
    );
  }
  if (iptc) parts.push(jpegSegment(0xed, Buffer.concat([Buffer.from('Photoshop 3.0\0', 'latin1'), iptc])));
  if (comment) parts.push(jpegSegment(0xfe, Buffer.from(comment, 'latin1')));

  // SOF0: precision, height, width, component count, then one component spec.
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 1;
  sof[6] = 1; // component id
  sof[7] = 0x11; // sampling factors
  sof[8] = 0; // quantisation table selector
  parts.push(jpegSegment(0xc0, sof));

  // SOS: component count, one component spec, spectral selection bytes.
  const sos = Buffer.from([0x01, 0x01, 0x00, 0x00, 0x3f, 0x00]);
  parts.push(jpegSegment(0xda, sos));

  // Placeholder entropy-coded data. 0xFF bytes must be byte-stuffed with 0x00
  // in a real scan, so only non-0xFF bytes are used here - that keeps the
  // stream free of accidental markers.
  parts.push(Buffer.alloc(64, 0x7f));
  if (terminate) parts.push(Buffer.from([0xff, 0xd9]));

  return Buffer.concat(parts);
}

/** An IPTC-IIM block declaring a city and a country - location, in plain text. */
function buildIptcWithLocation({ city = 'Testville', country = 'Testland' } = {}) {
  function dataset(number, value) {
    const bytes = Buffer.from(value, 'latin1');
    const header = Buffer.alloc(5);
    header[0] = 0x1c;
    header[1] = 0x02;
    header[2] = number;
    header.writeUInt16BE(bytes.length, 3);
    return Buffer.concat([header, bytes]);
  }
  return Buffer.concat([dataset(90, city), dataset(101, country)]);
}

const XMP_WITH_GPS =
  '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
  '<rdf:Description exif:GPSLatitude="51,30.000N" exif:GPSLongitude="0,7.000W"/></rdf:RDF></x:xmpmeta>';

/* ------------------------------------------------------------------ *
 * Named scenarios
 * ------------------------------------------------------------------ */

/**
 * The canonical set the invariant suite draws on. Every entry is explicitly
 * tiered PIPELINE_TEST_ASSET so nothing here can be mistaken for a capture.
 */
function buildScenarioAssets() {
  return {
    cleanPng: { tier: 'PIPELINE_TEST_ASSET', bytes: makePng({ width: 8, height: 8 }) },
    cleanPngVariant: {
      tier: 'PIPELINE_TEST_ASSET',
      bytes: makePng({ width: 8, height: 8, pattern: (x, y) => [(x * 16) % 256, 200, (y * 8) % 256] }),
    },
    duplicateOfCleanPng: { tier: 'PIPELINE_TEST_ASSET', bytes: makePng({ width: 8, height: 8 }) },
    corruptCrcPng: { tier: 'PIPELINE_TEST_ASSET', bytes: makeCorruptCrcPng({ width: 8, height: 8 }) },
    truncatedPng: { tier: 'PIPELINE_TEST_ASSET', bytes: makeTruncatedPng({ width: 8, height: 8 }) },
    pngWithXmpLocation: { tier: 'PIPELINE_TEST_ASSET', bytes: makePngWithXmpLocation({ width: 8, height: 8 }) },
    cleanJpeg: { tier: 'PIPELINE_TEST_ASSET', bytes: makeJpeg({ exif: buildExifWithoutGps() }) },
    jpegWithGpsExif: { tier: 'PIPELINE_TEST_ASSET', bytes: makeJpeg({ exif: buildExifWithGps() }) },
    jpegWithXmpLocation: { tier: 'PIPELINE_TEST_ASSET', bytes: makeJpeg({ xmp: XMP_WITH_GPS }) },
    jpegWithIptcLocation: { tier: 'PIPELINE_TEST_ASSET', bytes: makeJpeg({ iptc: buildIptcWithLocation() }) },
    truncatedJpeg: { tier: 'PIPELINE_TEST_ASSET', bytes: makeJpeg({ terminate: false }) },
    notAnImage: { tier: 'PIPELINE_TEST_ASSET', bytes: Buffer.from('<html><body>404 Not Found</body></html>', 'utf8') },
    emptyFile: { tier: 'PIPELINE_TEST_ASSET', bytes: Buffer.alloc(0) },
  };
}

module.exports = {
  makePng,
  makePngWithXmpLocation,
  makeCorruptCrcPng,
  makeTruncatedPng,
  makeJpeg,
  buildTiff,
  buildExifWithGps,
  buildExifWithoutGps,
  buildIptcWithLocation,
  buildScenarioAssets,
  pngChunk,
  XMP_WITH_GPS,
};
