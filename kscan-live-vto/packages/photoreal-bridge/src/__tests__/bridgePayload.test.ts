import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildExplicitStillCapture } from '../stillCapture';
import {
  FORBIDDEN_BRIDGE_PAYLOAD_KEYS,
  assertNoLiveStreamFields,
  commerceReferenceFromGarmentDescriptor,
  type PhotorealBridgePayload,
} from '../bridgePayload';

function validCapture() {
  const outcome = buildExplicitStillCapture({ captureId: 'cap-1', userConfirmed: true, localUri: 'file:///x.jpg' });
  if (!outcome.ok) throw new Error('test fixture setup failed');
  return outcome.capture;
}

function validPayload(): PhotorealBridgePayload {
  return {
    capture: validCapture(),
    garment: {
      productRef: 'prod-123',
      imageUrl: 'https://example-retailer.test/garment.jpg',
      category: 'top',
      brand: 'Example Brand',
      commerceSource: 'scan_result',
    },
    origin: 'scan_result',
    requestId: 'req-1',
  };
}

test('a well-formed PhotorealBridgePayload passes the live-stream-field guard', () => {
  assert.doesNotThrow(() => assertNoLiveStreamFields(validPayload()));
});

test('the guard actually catches a poisoned payload -- a forbidden key anywhere, at any depth', () => {
  const poisoned = { ...validPayload(), cameraFrame: new Uint8Array(4) };
  assert.throws(() => assertNoLiveStreamFields(poisoned), /forbidden live-stream field/);
});

test('the guard catches a forbidden key nested inside an otherwise-valid field', () => {
  const poisoned = {
    ...validPayload(),
    garment: { ...validPayload().garment, segmentationMask: 'sneaked-in' },
  };
  assert.throws(() => assertNoLiveStreamFields(poisoned), /segmentationMask/);
});

test('every FORBIDDEN_BRIDGE_PAYLOAD_KEYS entry is individually caught when present as a top-level key', () => {
  for (const key of FORBIDDEN_BRIDGE_PAYLOAD_KEYS) {
    const poisoned = { ...validPayload(), [key]: 'x' };
    assert.throws(() => assertNoLiveStreamFields(poisoned), new RegExp(key), `expected "${key}" to be caught`);
  }
});

test('a valid PhotorealBridgePayload carries exactly the four documented top-level fields', () => {
  const payload = validPayload();
  assert.deepEqual(Object.keys(payload).sort(), ['capture', 'garment', 'origin', 'requestId']);
});

test('commerceReferenceFromGarmentDescriptor requires the commerce-only fields to be supplied explicitly, not fabricated', () => {
  const reference = commerceReferenceFromGarmentDescriptor(
    { productId: 'prod-9', category: 'Tops' },
    { imageUrl: 'https://example-retailer.test/g.jpg', brand: 'Acme', commerceSource: 'commerce_product' },
  );
  assert.deepEqual(reference, {
    productRef: 'prod-9',
    imageUrl: 'https://example-retailer.test/g.jpg',
    category: 'Tops',
    brand: 'Acme',
    commerceSource: 'commerce_product',
  });
});
