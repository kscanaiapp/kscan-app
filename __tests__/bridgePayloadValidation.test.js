const test = require('node:test');
const assert = require('node:assert/strict');

const {
  validateBridgePayload,
  isValidBridgePayload,
  InvalidCapturePayloadError,
  JPEG_DATA_URL_PREFIX,
} = require('../services/bridge/validateBridgePayload.ts');
const { bridgeFixtures } = require('../services/bridge/bridgeFixtures.ts');

test('accepts a valid JPEG data URL', () => {
  const result = validateBridgePayload(bridgeFixtures.validJpegDataUrl);
  assert.equal(result, bridgeFixtures.validJpegDataUrl);
  assert.ok(result.startsWith(JPEG_DATA_URL_PREFIX));
});

test('trims leading/trailing whitespace and returns the normalized payload', () => {
  const padded = `  ${bridgeFixtures.validJpegDataUrl}\n`;
  const result = validateBridgePayload(padded);
  assert.equal(result, bridgeFixtures.validJpegDataUrl);
});

test('rejects raw base64 without the data URL prefix', () => {
  assert.throws(
    () => validateBridgePayload(bridgeFixtures.rawBase64WithoutPrefix),
    (error) => error instanceof InvalidCapturePayloadError && error.code === 'INVALID_CAPTURE_RESPONSE'
  );
});

test('rejects PNG data URLs', () => {
  assert.throws(
    () => validateBridgePayload(bridgeFixtures.wrongMimePrefix),
    (error) => error.code === 'INVALID_CAPTURE_RESPONSE'
  );
});

test('rejects text/plain data URLs', () => {
  assert.throws(
    () => validateBridgePayload(bridgeFixtures.textPlainPrefix),
    (error) => error.code === 'INVALID_CAPTURE_RESPONSE'
  );
});

test('rejects a prefix with no payload after the comma', () => {
  assert.throws(
    () => validateBridgePayload(bridgeFixtures.prefixOnlyNoPayload),
    (error) => error.code === 'INVALID_CAPTURE_RESPONSE'
  );
});

test('rejects empty string', () => {
  assert.throws(
    () => validateBridgePayload(bridgeFixtures.emptyString),
    (error) => error.code === 'INVALID_CAPTURE_RESPONSE'
  );
});

test('rejects non-string payloads', () => {
  for (const value of [bridgeFixtures.nonStringPayload, null, undefined, {}, [], true]) {
    assert.throws(
      () => validateBridgePayload(value),
      (error) => error.code === 'INVALID_CAPTURE_RESPONSE'
    );
  }
});

test('case-sensitive prefix: uppercase variant is rejected', () => {
  assert.throws(
    () => validateBridgePayload('DATA:IMAGE/JPEG;BASE64,abc'),
    (error) => error.code === 'INVALID_CAPTURE_RESPONSE'
  );
});

test('malformed JPEG-prefixed payload passes syntax validation (decode failure is downstream)', () => {
  const result = validateBridgePayload(bridgeFixtures.malformedJpegPrefixedPayload);
  assert.equal(result, bridgeFixtures.malformedJpegPrefixedPayload);
});

test('error messages never expose the payload contents', () => {
  const secretishPayload = 'data:image/png;base64,SECRET_PAYLOAD_BYTES_12345';
  try {
    validateBridgePayload(secretishPayload);
    assert.fail('expected validation to throw');
  } catch (error) {
    assert.ok(!error.message.includes('SECRET_PAYLOAD_BYTES_12345'));
    assert.ok(!error.message.includes(secretishPayload));
  }
});

test('isValidBridgePayload mirrors the throwing validator', () => {
  assert.equal(isValidBridgePayload(bridgeFixtures.validJpegDataUrl), true);
  assert.equal(isValidBridgePayload(bridgeFixtures.rawBase64WithoutPrefix), false);
  assert.equal(isValidBridgePayload(bridgeFixtures.nonStringPayload), false);
});
