import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertValidForegroundMaskFrame,
  assertValidSequence,
  createMask,
  fillRect,
  maskAt,
  masksEqual,
  setMaskAt,
  toRendererMaskProvenance,
  totalCoverage,
  type ForegroundMaskFrame,
} from '../foregroundMask';

test('createMask rejects non-positive or non-integer dimensions', () => {
  assert.throws(() => createMask(0, 10), RangeError);
  assert.throws(() => createMask(10, -1), RangeError);
  assert.throws(() => createMask(1.5, 10), RangeError);
});

test('createMask fills with the given default and matches width*height', () => {
  const mask = createMask(4, 3, 0.5);
  assert.equal(mask.coverage.length, 12);
  assert.ok(mask.coverage.every((v) => v === 0.5));
});

test('maskAt/setMaskAt are bounds-safe and clamp values to [0,1]', () => {
  const mask = createMask(4, 4, 0);
  setMaskAt(mask, 1, 1, 2); // out of range value, should clamp
  assert.equal(maskAt(mask, 1, 1), 1);
  setMaskAt(mask, 2, 2, -5);
  assert.equal(maskAt(mask, 2, 2), 0);
  // Out-of-bounds coordinates read as 0 and write as a no-op rather than throwing.
  assert.equal(maskAt(mask, -1, 0), 0);
  assert.equal(maskAt(mask, 100, 100), 0);
  setMaskAt(mask, -1, 0, 1);
  assert.equal(totalCoverage(mask), 1); // unchanged by the out-of-bounds write
});

test('fillRect clamps to mask bounds rather than writing out of range', () => {
  const mask = createMask(5, 5, 0);
  fillRect(mask, { x: -2, y: -2, w: 4, h: 4 }, 1);
  // Only the in-bounds portion (x:0..2, y:0..2) should be filled.
  assert.equal(totalCoverage(mask), 4);
  assert.equal(maskAt(mask, 0, 0), 1);
  assert.equal(maskAt(mask, 3, 3), 0);
});

test('masksEqual compares dimensions and every coverage value', () => {
  const a = createMask(2, 2, 0.3);
  const b = createMask(2, 2, 0.3);
  assert.ok(masksEqual(a, b));
  setMaskAt(b, 0, 0, 0.9);
  assert.ok(!masksEqual(a, b));
  const c = createMask(3, 2, 0.3);
  assert.ok(!masksEqual(a, c));
});

function baseFrame(overrides: Partial<ForegroundMaskFrame> = {}): ForegroundMaskFrame {
  return {
    timestamp: 0,
    mask: createMask(2, 2, 0.4),
    confidence: 0.9,
    provenance: 'PRECOMPUTED',
    ...overrides,
  };
}

test('assertValidForegroundMaskFrame accepts a well-formed frame', () => {
  assert.doesNotThrow(() => assertValidForegroundMaskFrame(baseFrame()));
});

test('assertValidForegroundMaskFrame rejects a negative or non-finite timestamp', () => {
  assert.throws(() => assertValidForegroundMaskFrame(baseFrame({ timestamp: -1 })), RangeError);
  assert.throws(() => assertValidForegroundMaskFrame(baseFrame({ timestamp: Number.NaN })), RangeError);
});

test('assertValidForegroundMaskFrame rejects an unknown provenance', () => {
  assert.throws(
    () => assertValidForegroundMaskFrame(baseFrame({ provenance: 'GUESSED' as never })),
    RangeError,
  );
});

test('assertValidForegroundMaskFrame rejects out-of-range confidence', () => {
  assert.throws(() => assertValidForegroundMaskFrame(baseFrame({ confidence: 1.1 })), RangeError);
  assert.throws(() => assertValidForegroundMaskFrame(baseFrame({ confidence: -0.1 })), RangeError);
});

test('assertValidForegroundMaskFrame rejects a coverage array whose length disagrees with width*height', () => {
  const mask = createMask(2, 2);
  const bad = { ...mask, coverage: new Float64Array(3) };
  assert.throws(() => assertValidForegroundMaskFrame(baseFrame({ mask: bad })), RangeError);
});

test('assertValidForegroundMaskFrame rejects an out-of-range coverage value', () => {
  const mask = createMask(2, 2);
  mask.coverage[0] = 1.5; // bypassing setMaskAt's clamp on purpose, to exercise the validator
  assert.throws(() => assertValidForegroundMaskFrame(baseFrame({ mask })), RangeError);
});

test('assertValidSequence requires strictly increasing timestamps', () => {
  const a = baseFrame({ timestamp: 0 });
  const b = baseFrame({ timestamp: 100 });
  assert.doesNotThrow(() => assertValidSequence([a, b]));
  assert.throws(() => assertValidSequence([a, a]), RangeError);
  assert.throws(() => assertValidSequence([b, a]), RangeError);
});

test('toRendererMaskProvenance: PRECOMPUTED maps to precomputed, REAL_MODEL and NATIVE_REPLAY map to generated', () => {
  assert.equal(toRendererMaskProvenance('PRECOMPUTED'), 'precomputed');
  assert.equal(toRendererMaskProvenance('REAL_MODEL'), 'generated');
  assert.equal(toRendererMaskProvenance('NATIVE_REPLAY'), 'generated');
});
