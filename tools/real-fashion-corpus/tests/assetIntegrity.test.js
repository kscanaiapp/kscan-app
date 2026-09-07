'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { inspectImage, sha256Hex } = require('../lib/imageIntegrity');
const { inspectMetadata, stripLocationMetadata, detectFormat } = require('../lib/exif');
const {
  makePng,
  makeJpeg,
  buildExifWithGps,
  buildExifWithoutGps,
  buildIptcWithLocation,
  buildScenarioAssets,
  XMP_WITH_GPS,
} = require('../../real-fashion-corpus/testAssets/generate');

const assets = buildScenarioAssets();

/* ------------------------------------------------------------------ *
 * The generator produces genuinely valid images
 * ------------------------------------------------------------------ */

test('TEST ASSETS: the generated PNG is a real, decodable PNG (zlib round-trips its IDAT)', () => {
  // If this ever fails, every downstream integrity test is testing garbage.
  const png = makePng({ width: 8, height: 8 });
  const inspected = inspectImage(png);
  assert.equal(inspected.readable, true, `findings: ${inspected.findings.join(', ')}`);
  assert.deepEqual(inspected.dimensions, { width: 8, height: 8 });

  // Independently confirm the IDAT really is a valid zlib stream of the right
  // uncompressed length (height * (1 filter byte + width * 3 channels)).
  const idatStart = png.indexOf(Buffer.from('IDAT', 'latin1')) + 4;
  const idatLength = png.readUInt32BE(idatStart - 8);
  const inflated = zlib.inflateSync(png.subarray(idatStart, idatStart + idatLength));
  assert.equal(inflated.length, 8 * (1 + 8 * 3));
});

test('TEST ASSETS: the generated JPEG container parses and reports its declared dimensions', () => {
  const inspected = inspectImage(makeJpeg({ width: 64, height: 48 }));
  assert.equal(inspected.readable, true, `findings: ${inspected.findings.join(', ')}`);
  assert.deepEqual(inspected.dimensions, { width: 64, height: 48 });
});

/* ------------------------------------------------------------------ *
 * Corrupt / unreadable detection (invariant 42 / mission section 27)
 * ------------------------------------------------------------------ */

test('INTEGRITY: a PNG with a corrupted chunk CRC is rejected as corrupt', () => {
  const inspected = inspectImage(assets.corruptCrcPng.bytes);
  assert.equal(inspected.readable, false);
  assert.ok(
    inspected.findings.some((f) => f.startsWith('png_chunk_crc_mismatch')),
    `expected a CRC mismatch finding, got ${JSON.stringify(inspected.findings)}`,
  );
});

test('INTEGRITY: a truncated PNG is rejected', () => {
  const inspected = inspectImage(assets.truncatedPng.bytes);
  assert.equal(inspected.readable, false);
  assert.ok(inspected.findings.length > 0);
});

test('INTEGRITY: a JPEG whose scan never terminates with EOI is rejected', () => {
  const inspected = inspectImage(assets.truncatedJpeg.bytes);
  assert.equal(inspected.readable, false);
  assert.ok(inspected.findings.includes('jpeg_scan_never_terminates_with_eoi'));
});

test('INTEGRITY: an HTML error page saved with an image name is rejected', () => {
  // The classic silent corruption: a failed download saved as a .jpg.
  const inspected = inspectImage(assets.notAnImage.bytes);
  assert.equal(inspected.readable, false);
  assert.equal(inspected.format, null);
  assert.ok(inspected.findings.includes('unrecognised_container_signature'));
});

test('INTEGRITY: a zero-byte file is rejected and named as such', () => {
  const inspected = inspectImage(assets.emptyFile.bytes);
  assert.equal(inspected.readable, false);
  assert.ok(inspected.findings.includes('zero_byte_file'));
});

test('INTEGRITY: trailing bytes appended after IEND are detected', () => {
  const tampered = Buffer.concat([makePng(), Buffer.from('appended', 'utf8')]);
  const inspected = inspectImage(tampered);
  assert.equal(inspected.readable, false);
  assert.ok(inspected.findings.some((f) => f.includes('trailing_bytes_after_iend')));
});

test('INTEGRITY: hashing is deterministic and content-addressed', () => {
  const a = makePng({ width: 8, height: 8 });
  const b = makePng({ width: 8, height: 8 });
  const different = makePng({ width: 8, height: 8, pattern: () => [1, 2, 3] });
  assert.equal(sha256Hex(a), sha256Hex(b), 'identical construction must hash identically');
  assert.notEqual(sha256Hex(a), sha256Hex(different), 'different pixels must hash differently');
});

/* ------------------------------------------------------------------ *
 * EXIF / location detection (invariant 42.2, mission section 17)
 * ------------------------------------------------------------------ */

test('EXIF: a JPEG carrying a GPS IFD is detected as location-bearing', () => {
  const result = inspectMetadata(assets.jpegWithGpsExif.bytes);
  assert.equal(result.ok, true, `error: ${result.error}`);
  assert.equal(result.locationPresent, true);
  assert.deepEqual(result.locationCarriers, ['EXIF_GPS_IFD']);
});

test('EXIF: device make/model and orientation are still readable (they are allowed)', () => {
  // Mission section 17 permits extracting device metadata; only location goes.
  const result = inspectMetadata(assets.jpegWithGpsExif.bytes);
  assert.equal(result.device.make, 'TestPhone');
  assert.equal(result.device.model, 'TestModel 1');
  assert.equal(result.orientation, 6);
});

test('EXIF: a JPEG with device EXIF but no GPS IFD is NOT location-bearing', () => {
  const result = inspectMetadata(makeJpeg({ exif: buildExifWithoutGps() }));
  assert.equal(result.locationPresent, false);
  assert.equal(result.exifPresent, true);
  assert.equal(result.device.make, 'TestPhone');
});

test('EXIF: location hidden in XMP rather than the GPS IFD is still caught', () => {
  // Stripping only the obvious carrier is how location survives sanitization.
  const result = inspectMetadata(makeJpeg({ xmp: XMP_WITH_GPS }));
  assert.equal(result.locationPresent, true);
  assert.deepEqual(result.locationCarriers, ['XMP_LOCATION']);
});

test('EXIF: location in an IPTC city/country block is caught', () => {
  const result = inspectMetadata(makeJpeg({ iptc: buildIptcWithLocation() }));
  assert.equal(result.locationPresent, true);
  assert.deepEqual(result.locationCarriers, ['IPTC_LOCATION']);
});

test('EXIF: a PNG carrying XMP GPS in an iTXt chunk is caught', () => {
  const result = inspectMetadata(assets.pngWithXmpLocation.bytes);
  assert.equal(result.ok, true, `error: ${result.error}`);
  assert.equal(result.locationPresent, true);
  assert.deepEqual(result.locationCarriers, ['XMP_LOCATION']);
});

test('EXIF: a clean PNG reports no location and no metadata carriers', () => {
  const result = inspectMetadata(makePng());
  assert.equal(result.locationPresent, false);
  assert.equal(result.exifPresent, false);
  assert.equal(result.xmpPresent, false);
});

test('EXIF: all three carriers present at once are all reported, not just the first', () => {
  const jpeg = makeJpeg({ exif: buildExifWithGps(), xmp: XMP_WITH_GPS, iptc: buildIptcWithLocation() });
  const result = inspectMetadata(jpeg);
  assert.equal(result.locationPresent, true);
  assert.deepEqual(result.locationCarriers.sort(), ['EXIF_GPS_IFD', 'IPTC_LOCATION', 'XMP_LOCATION']);
});

/* ------------------------------------------------------------------ *
 * Sanitization
 * ------------------------------------------------------------------ */

test('EXIF SANITIZE: stripping removes every location carrier from a JPEG', () => {
  const dirty = makeJpeg({ exif: buildExifWithGps(), xmp: XMP_WITH_GPS, iptc: buildIptcWithLocation() });
  assert.equal(inspectMetadata(dirty).locationPresent, true);

  const stripped = stripLocationMetadata(dirty);
  assert.equal(stripped.ok, true, `error: ${stripped.error}`);

  const after = inspectMetadata(stripped.buffer);
  assert.equal(after.ok, true, `error: ${after.error}`);
  assert.equal(after.locationPresent, false, `carriers still present: ${after.locationCarriers.join(', ')}`);
  assert.deepEqual(after.locationCarriers, []);
});

test('EXIF SANITIZE: the sanitized JPEG is still a structurally valid image', () => {
  // A privacy control that corrupts the asset it protects is not usable.
  const stripped = stripLocationMetadata(makeJpeg({ width: 64, height: 48, exif: buildExifWithGps() }));
  const inspected = inspectImage(stripped.buffer);
  assert.equal(inspected.readable, true, `findings: ${inspected.findings.join(', ')}`);
  assert.deepEqual(inspected.dimensions, { width: 64, height: 48 });
});

test('EXIF SANITIZE: orientation survives stripping, so a portrait photo stays portrait', () => {
  const stripped = stripLocationMetadata(makeJpeg({ exif: buildExifWithGps({ orientation: 6 }) }));
  assert.equal(stripped.preservedOrientation, 6);
  assert.equal(inspectMetadata(stripped.buffer).orientation, 6);
});

test('EXIF SANITIZE: device make/model are dropped as unnecessary identifiers', () => {
  // Mission section 17 says strip unnecessary identifiers. The device the
  // corpus cares about is the one RECORDED in the case metadata, which is
  // reviewable; a serial-adjacent EXIF string embedded in shipped bytes is not.
  const stripped = stripLocationMetadata(makeJpeg({ exif: buildExifWithGps() }));
  const after = inspectMetadata(stripped.buffer);
  assert.equal(after.device.make, null);
  assert.equal(after.device.model, null);
});

test('EXIF SANITIZE: a PNG loses its XMP chunk and stays a valid PNG', () => {
  const stripped = stripLocationMetadata(assets.pngWithXmpLocation.bytes);
  assert.equal(stripped.ok, true);
  assert.equal(inspectMetadata(stripped.buffer).locationPresent, false);
  assert.equal(inspectImage(stripped.buffer).readable, true);
});

test('EXIF SANITIZE: an unparseable container is REFUSED, never half-cleaned', () => {
  const result = stripLocationMetadata(assets.notAnImage.bytes);
  assert.equal(result.ok, false);
  assert.equal(result.buffer, undefined, 'a refused sanitization must not hand back a buffer');
});

test('EXIF SANITIZE: stripping is idempotent - a clean file survives a second pass unchanged', () => {
  const once = stripLocationMetadata(makeJpeg({ exif: buildExifWithGps() }));
  const twice = stripLocationMetadata(once.buffer);
  assert.equal(twice.ok, true);
  assert.equal(sha256Hex(once.buffer), sha256Hex(twice.buffer));
});

test('FORMAT: detectFormat recognises exactly the two supported containers', () => {
  assert.equal(detectFormat(makePng()), 'png');
  assert.equal(detectFormat(makeJpeg()), 'jpeg');
  assert.equal(detectFormat(Buffer.from('GIF89a...........', 'latin1')), null);
  assert.equal(detectFormat(Buffer.alloc(0)), null);
});
