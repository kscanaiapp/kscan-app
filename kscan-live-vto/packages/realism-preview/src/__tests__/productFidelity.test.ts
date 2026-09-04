import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImage, getPixel, rgba, setPixel } from '@kscan-live-vto/static-renderer';
import { applyGammaExposureAdjustment } from '../gammaExposure';
import { applyContactShadow } from '../contactShadow';
import {
  hueDeltaDegrees,
  preservesChannelBrightness,
  samplePixelColor,
} from '../productFidelity';

test('hueDeltaDegrees is 0 for identical colors', () => {
  assert.equal(hueDeltaDegrees({ r: 10, g: 200, b: 30 }, { r: 10, g: 200, b: 30 }), 0);
});

test('hueDeltaDegrees is exactly 180 for exact complementary hues (pure red vs pure cyan)', () => {
  assert.equal(hueDeltaDegrees({ r: 255, g: 0, b: 0 }, { r: 0, g: 255, b: 255 }), 180);
});

test('hueDeltaDegrees wraps correctly around 0/360 (near-red vs near-red-the-other-way)', () => {
  // hue ~5deg vs hue ~355deg: true distance is 10, not 350.
  const a = { r: 255, g: 21, b: 0 }; // slightly orange-red
  const b = { r: 255, g: 0, b: 21 }; // slightly magenta-red
  const delta = hueDeltaDegrees(a, b);
  assert.ok(delta < 20, `expected a small wraparound-correct delta, got ${delta}`);
});

test('preservesChannelBrightness passes for an unmodified color and for a small clamped darkening', () => {
  const before = { r: 250, g: 250, b: 248 };
  assert.ok(preservesChannelBrightness(before, before, 0.86));
  const slightlyDarkened = { r: 230, g: 232, b: 228 };
  assert.ok(preservesChannelBrightness(before, slightlyDarkened, 0.86));
});

test('preservesChannelBrightness fails when any single channel drops too far, even if others are fine', () => {
  const before = { r: 250, g: 250, b: 248 };
  const oneChannelCrushed = { r: 250, g: 250, b: 40 }; // blue crushed -- would read as a color shift, not just shading
  assert.ok(!preservesChannelBrightness(before, oneChannelCrushed, 0.86));
});

test('samplePixelColor reads only the RGB channels, ignoring alpha', () => {
  const image = createImage(1, 1, rgba(0, 0, 0, 0));
  setPixel(image, 0, 0, rgba(11, 22, 33, 77));
  assert.deepEqual(samplePixelColor(image, 0, 0), { r: 11, g: 22, b: 33 });
});

test('integration: a light garment sampled before/after gamma + contact shadow keeps a small hue delta and stays within the brightness guardrail', () => {
  const image = createImage(20, 20, rgba(0, 0, 0, 0));
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20; x += 1) setPixel(image, x, y, rgba(235, 232, 225, 255));
  const before = samplePixelColor(image, 10, 10);

  applyGammaExposureAdjustment(image, { gamma: 1.05, clamped: false });
  applyContactShadow(image, { x: 0, y: 0, w: 20, h: 20, intensity: 0.08 });

  const after = samplePixelColor(image, 10, 10);
  assert.ok(hueDeltaDegrees(before, after) < 8, 'combined gamma + shadow must not visibly shift product hue');
  assert.ok(preservesChannelBrightness(before, after, 0.8), 'combined gamma + shadow must not dirty a light garment beyond a generous combined bound');
});
