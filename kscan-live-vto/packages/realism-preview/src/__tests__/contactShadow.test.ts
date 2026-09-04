import { test } from 'node:test';
import assert from 'node:assert/strict';

import { cloneImage, createImage, getPixel, rgba, setPixel } from '@kscan-live-vto/static-renderer';
import {
  SHADOW_GUARDRAILS,
  applyContactShadow,
  applyContactShadows,
  standardCollarAndShoulderShadowRegions,
} from '../contactShadow';

test('a shadow region darkens its center by roughly its intensity and never inverts to brightening', () => {
  const image = createImage(20, 20, rgba(0, 0, 0, 0));
  for (let y = 0; y < 20; y += 1) for (let x = 0; x < 20; x += 1) setPixel(image, x, y, rgba(200, 200, 200, 255));
  applyContactShadow(image, { x: 5, y: 5, w: 10, h: 10, intensity: 0.1 });
  const center = getPixel(image, 10, 10);
  assert.ok(center.r < 200, 'the region center must be darkened');
  assert.ok(center.r >= 200 * (1 - SHADOW_GUARDRAILS.maxIntensity) - 1, 'darkening must respect the guardrail even for an in-bounds intensity request');
});

test('intensity is clamped to SHADOW_GUARDRAILS.maxIntensity even when a caller asks for more', () => {
  const image = createImage(10, 10, rgba(0, 0, 0, 0));
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) setPixel(image, x, y, rgba(100, 100, 100, 255));
  applyContactShadow(image, { x: 0, y: 0, w: 10, h: 10, intensity: 0.9 }); // way over the guardrail
  const center = getPixel(image, 5, 5);
  const minAllowed = 100 * (1 - SHADOW_GUARDRAILS.maxIntensity);
  assert.ok(center.r >= minAllowed - 1, `expected r >= ${minAllowed}, got ${center.r}`);
});

test('a shadow never paints onto a fully transparent pixel (no shadow beyond the garment/background edge)', () => {
  const image = createImage(10, 10, rgba(0, 0, 0, 0)); // entirely transparent
  applyContactShadow(image, { x: 0, y: 0, w: 10, h: 10, intensity: 0.14 });
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) assert.deepEqual(getPixel(image, x, y), { r: 0, g: 0, b: 0, a: 0 });
  }
});

test('a shadow only ever darkens color channels and never changes alpha', () => {
  const image = createImage(10, 10, rgba(0, 0, 0, 0));
  for (let y = 0; y < 10; y += 1) for (let x = 0; x < 10; x += 1) setPixel(image, x, y, rgba(50, 60, 70, 200));
  applyContactShadow(image, { x: 2, y: 2, w: 6, h: 6, intensity: 0.14 });
  for (let y = 0; y < 10; y += 1) {
    for (let x = 0; x < 10; x += 1) {
      const px = getPixel(image, x, y);
      assert.equal(px.a, 200);
      assert.ok(px.r <= 50 && px.g <= 60 && px.b <= 70, 'no channel may ever increase');
    }
  }
});

test('a near-white garment stays visibly white after every standard collar/shoulder shadow region -- never dirtied', () => {
  const image = createImage(60, 60, rgba(0, 0, 0, 0));
  for (let y = 0; y < 60; y += 1) for (let x = 0; x < 60; x += 1) setPixel(image, x, y, rgba(250, 250, 248, 255));
  const before = cloneImage(image);

  applyContactShadows(image, standardCollarAndShoulderShadowRegions({ leftX: 10, rightX: 50, topY: 5 }));

  for (let y = 0; y < 60; y += 1) {
    for (let x = 0; x < 60; x += 1) {
      const b = getPixel(before, x, y);
      const a = getPixel(image, x, y);
      const minAllowed = 1 - SHADOW_GUARDRAILS.maxIntensity;
      assert.ok(a.r >= b.r * minAllowed - 1, `pixel (${x},${y}) red channel darkened past the guardrail`);
      assert.ok(a.g >= b.g * minAllowed - 1, `pixel (${x},${y}) green channel darkened past the guardrail`);
      assert.ok(a.b >= b.b * minAllowed - 1, `pixel (${x},${y}) blue channel darkened past the guardrail`);
    }
  }
});

test('standardCollarAndShoulderShadowRegions produces exactly three regions: one collar band, two shoulder patches', () => {
  const regions = standardCollarAndShoulderShadowRegions({ leftX: 0, rightX: 100, topY: 0 });
  assert.equal(regions.length, 3);
  for (const r of regions) {
    assert.ok(r.intensity > 0 && r.intensity <= SHADOW_GUARDRAILS.maxIntensity * 10); // sanity: a reasonable pre-clamp value
    assert.ok(r.w > 0 && r.h > 0);
  }
});

test('a zero-size or non-positive region is a safe no-op rather than a crash', () => {
  const image = createImage(4, 4, rgba(0, 0, 0, 0));
  setPixel(image, 1, 1, rgba(10, 10, 10, 255));
  assert.doesNotThrow(() => applyContactShadow(image, { x: 0, y: 0, w: 0, h: 0, intensity: 0.1 }));
  assert.doesNotThrow(() => applyContactShadow(image, { x: 0, y: 0, w: -5, h: 3, intensity: 0.1 }));
});
