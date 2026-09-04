import test from 'node:test';
import assert from 'node:assert/strict';
import { createImage, setPixel, getPixel } from '../src/pixels';
import { decodeImageBytes, detectFormat, encodePng } from '../src/codec';

test('encodePng/decodeImageBytes round-trips pixel data exactly', () => {
  const img = createImage(4, 3);
  setPixel(img, 0, 0, 255, 0, 0, 255);
  setPixel(img, 3, 2, 0, 255, 0, 128);
  const bytes = encodePng(img);
  const decoded = decodeImageBytes(bytes);
  assert.equal(decoded.format, 'png');
  assert.equal(decoded.image.width, 4);
  assert.equal(decoded.image.height, 3);
  assert.deepEqual(getPixel(decoded.image, 0, 0), [255, 0, 0, 255]);
  assert.deepEqual(getPixel(decoded.image, 3, 2), [0, 255, 0, 128]);
});

test('detectFormat recognizes PNG and JPEG magic bytes and rejects garbage', () => {
  const png = encodePng(createImage(1, 1));
  assert.equal(detectFormat(png), 'png');
  const jpegMagic = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  assert.equal(detectFormat(jpegMagic), 'jpeg');
  assert.equal(detectFormat(Buffer.from([1, 2, 3, 4])), null);
});

test('decodeImageBytes throws a labeled error for unrecognized bytes', () => {
  assert.throws(() => decodeImageBytes(Buffer.from([1, 2, 3])), /SOURCE_INVALID/);
});
