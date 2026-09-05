import test from 'node:test';
import assert from 'node:assert/strict';
import { createImage, setPixel, getPixel } from '../src/pixels';
import { DecodeError, MAX_DIMENSION_PX, MAX_TOTAL_PIXELS, decodeImageBytes, detectFormat, encodePng } from '../src/codec';
import { encodeSyntheticWebp } from './testUtils/webpTestEncoder';

// ── Valid decode round-trips (addendum §8) ──────────────────────────────────

test('encodePng/decodeImageBytes round-trips pixel data exactly', async () => {
  const img = createImage(4, 3);
  setPixel(img, 0, 0, 255, 0, 0, 255);
  setPixel(img, 3, 2, 0, 255, 0, 128);
  const bytes = encodePng(img);
  const decoded = await decodeImageBytes(bytes);
  assert.equal(decoded.format, 'png');
  assert.equal(decoded.image.width, 4);
  assert.equal(decoded.image.height, 3);
  assert.deepEqual(getPixel(decoded.image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(decoded.image, 3, 2), [0, 255, 0, 128]);
});

test('valid JPEG decodes to the correct dimensions', async () => {
  // jpeg-js's own encoder — a real JPEG bitstream, not a fixture file.
  const jpegjs = await import('jpeg-js');
  const width = 6;
  const height = 4;
  const data = Buffer.alloc(width * height * 4, 0);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = 200;
    data[i * 4 + 1] = 60;
    data[i * 4 + 2] = 30;
    data[i * 4 + 3] = 255;
  }
  const encoded = jpegjs.encode({ data, width, height }, 90);
  const decoded = await decodeImageBytes(encoded.data);
  assert.equal(decoded.format, 'jpeg');
  assert.equal(decoded.image.width, width);
  assert.equal(decoded.image.height, height);
});

test('valid WebP decodes to the correct dimensions and format (addendum Primary Repair A)', async () => {
  const width = 10;
  const height = 8;
  const webpBytes = await encodeSyntheticWebp(width, height, [12, 200, 90, 255]);
  assert.equal(detectFormat(webpBytes), 'webp');
  const decoded = await decodeImageBytes(webpBytes);
  assert.equal(decoded.format, 'webp');
  assert.equal(decoded.image.width, width);
  assert.equal(decoded.image.height, height);
  // Lossy WebP — allow encode drift, but the decoded pixel must be close to the source color.
  const [r, g, b] = getPixel(decoded.image, 5, 4);
  assert.ok(Math.abs(r - 12) < 20, `red channel drifted too far: ${r}`);
  assert.ok(Math.abs(g - 200) < 20, `green channel drifted too far: ${g}`);
  assert.ok(Math.abs(b - 90) < 20, `blue channel drifted too far: ${b}`);
});

test('detectFormat recognizes PNG, JPEG, WebP, and AVIF magic bytes and rejects garbage', () => {
  const png = encodePng(createImage(1, 1));
  assert.equal(detectFormat(png), 'png');
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.equal(detectFormat(jpegMagic), 'jpeg');
  const webpMagic = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);
  assert.equal(detectFormat(webpMagic), 'webp');
  const avifMagic = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('avif')]);
  assert.equal(detectFormat(avifMagic), 'avif');
  assert.equal(detectFormat(Buffer.from([1, 2, 3, 4])), null);
});

// ── Decode failure matrix (addendum §7/§8: must fail closed as SYSTEM_ERROR, never REJECTED:EXTRACTION_UNRELIABLE, never LIVE2D_ELIGIBLE) ──

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for unrecognized bytes', async () => {
  await assert.rejects(() => decodeImageBytes(Buffer.from([1, 2, 3])), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for zero-byte input', async () => {
  await assert.rejects(() => decodeImageBytes(Buffer.alloc(0)), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for truncated PNG (valid signature, no full IHDR)', async () => {
  const truncated = encodePng(createImage(2, 2)).subarray(0, 10);
  await assert.rejects(() => decodeImageBytes(truncated), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for corrupt PNG (valid IHDR, garbage IDAT)', async () => {
  const valid = encodePng(createImage(4, 4));
  const corrupt = Buffer.from(valid);
  // Flip bytes well past IHDR (chunk data begins at 8+8+13+4=33) to corrupt the compressed IDAT stream
  // while leaving the IHDR-derived dimensions (read by peekPngDimensions) intact.
  for (let i = 40; i < Math.min(corrupt.length, 60); i++) corrupt[i] = 0xff ^ corrupt[i];
  await assert.rejects(() => decodeImageBytes(corrupt), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for corrupt JPEG (valid SOI/SOF, truncated scan data)', async () => {
  const jpegjs = await import('jpeg-js');
  const width = 4;
  const height = 4;
  const data = Buffer.alloc(width * height * 4, 128);
  const encoded = jpegjs.encode({ data, width, height }, 80);
  const truncated = encoded.data.subarray(0, Math.floor(encoded.data.length * 0.4));
  await assert.rejects(() => decodeImageBytes(truncated), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for corrupt WebP (valid RIFF/WEBP magic, garbage VP8 payload)', async () => {
  const valid = await encodeSyntheticWebp(6, 6);
  const corrupt = Buffer.from(valid);
  for (let i = 20; i < Math.min(corrupt.length, 40); i++) corrupt[i] = 0xff ^ corrupt[i];
  await assert.rejects(() => decodeImageBytes(corrupt), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(UNSUPPORTED_IMAGE_FORMAT, format=AVIF) for AVIF — distinct from DECODE_FAILED (addendum §A3)', async () => {
  const avifLike = Buffer.concat([Buffer.alloc(4), Buffer.from('ftyp'), Buffer.from('avif'), Buffer.alloc(4)]);
  await assert.rejects(() => decodeImageBytes(avifLike), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'UNSUPPORTED_IMAGE_FORMAT');
    assert.equal(err.format, 'AVIF');
    return true;
  });
});

test('decodeImageBytes throws DecodeError(DECODE_FAILED) for wrong-extension/MIME-mismatch bytes (JPEG magic, PNG-shaped rest)', async () => {
  // Bytes that start with a JPEG SOI but are not a real JPEG stream at all.
  const mismatched = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(50, 0)]);
  assert.equal(detectFormat(mismatched), 'jpeg');
  await assert.rejects(() => decodeImageBytes(mismatched), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    return true;
  });
});

// ── Resource-safety guard (addendum §9/§A5) ─────────────────────────────────

test('decodeImageBytes rejects a PNG header claiming dimensions over the max-dimension guard, before any pixel allocation', async () => {
  const oversizedWidth = MAX_DIMENSION_PX + 1000;
  const header = Buffer.alloc(24);
  header.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  header.writeUInt32BE(oversizedWidth, 16);
  header.writeUInt32BE(100, 20);
  await assert.rejects(() => decodeImageBytes(header), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    assert.match(err.message, /exceeds max dimension/);
    return true;
  });
});

test('decodeImageBytes rejects a PNG header within per-dimension limits but over the total-pixel-count guard', async () => {
  // 8000 x 8000 = 64,000,000 — exactly at MAX_TOTAL_PIXELS; +1 row pushes it over while each dimension alone stays under MAX_DIMENSION_PX.
  const width = 8000;
  const height = Math.floor(MAX_TOTAL_PIXELS / width) + 1;
  assert.ok(width <= MAX_DIMENSION_PX && height <= MAX_DIMENSION_PX, 'test premise: both dimensions individually legal');
  assert.ok(width * height > MAX_TOTAL_PIXELS, 'test premise: total pixel count over the guard');
  const header = Buffer.alloc(24);
  header.write('\x89PNG\r\n\x1a\n', 0, 'binary');
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  await assert.rejects(() => decodeImageBytes(header), (err: unknown) => {
    assert.ok(err instanceof DecodeError);
    assert.equal(err.code, 'DECODE_FAILED');
    assert.match(err.message, /exceeds max 64,000,000px/);
    return true;
  });
});

test('a real image comfortably inside the resource-safety guard still decodes normally', async () => {
  const decoded = await decodeImageBytes(encodePng(createImage(200, 150)));
  assert.equal(decoded.image.width, 200);
  assert.equal(decoded.image.height, 150);
});
