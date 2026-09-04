import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createImage, getPixel, rgba, setPixel } from '@kscan-live-vto/static-renderer';
import {
  GAMMA_EXPOSURE_GUARDRAILS,
  applyGammaExposureAdjustment,
  computeGammaExposureAdjustment,
  meanLuminanceOfOpaquePixels,
} from '../gammaExposure';

test('computeGammaExposureAdjustment returns gamma 1 (no-op) when scene and garment luminance already match', () => {
  const adjustment = computeGammaExposureAdjustment({ meanLuminance: 0.5 }, 0.5);
  assert.equal(adjustment.gamma, 1);
  assert.equal(adjustment.clamped, false);
});

test('a darker scene than the garment nudges gamma below 1 (brightens); a brighter scene nudges it above 1', () => {
  const darkerScene = computeGammaExposureAdjustment({ meanLuminance: 0.2 }, 0.5);
  assert.ok(darkerScene.gamma < 1);
  const brighterScene = computeGammaExposureAdjustment({ meanLuminance: 0.8 }, 0.5);
  assert.ok(brighterScene.gamma > 1);
});

test('gamma is always clamped within GAMMA_EXPOSURE_GUARDRAILS, and clamped is reported honestly', () => {
  const extreme = computeGammaExposureAdjustment({ meanLuminance: 1 }, 0);
  assert.ok(extreme.gamma <= GAMMA_EXPOSURE_GUARDRAILS.maxGamma);
  assert.equal(extreme.clamped, true);

  const extremeOther = computeGammaExposureAdjustment({ meanLuminance: 0 }, 1);
  assert.ok(extremeOther.gamma >= GAMMA_EXPOSURE_GUARDRAILS.minGamma);
  assert.equal(extremeOther.clamped, true);
});

test('applyGammaExposureAdjustment with gamma 1 is a no-op on color channels', () => {
  const image = createImage(2, 1, rgba(0, 0, 0, 0));
  setPixel(image, 0, 0, rgba(100, 150, 200, 255));
  applyGammaExposureAdjustment(image, { gamma: 1, clamped: false });
  assert.deepEqual(getPixel(image, 0, 0), { r: 100, g: 150, b: 200, a: 255 });
});

test('applyGammaExposureAdjustment never touches fully transparent pixels', () => {
  const image = createImage(1, 1, rgba(0, 0, 0, 0));
  setPixel(image, 0, 0, rgba(123, 45, 67, 0));
  applyGammaExposureAdjustment(image, { gamma: 1.1, clamped: false });
  assert.deepEqual(getPixel(image, 0, 0), { r: 123, g: 45, b: 67, a: 0 });
});

test('applyGammaExposureAdjustment preserves alpha exactly while adjusting color channels', () => {
  const image = createImage(1, 1, rgba(0, 0, 0, 0));
  setPixel(image, 0, 0, rgba(128, 128, 128, 200));
  applyGammaExposureAdjustment(image, { gamma: 0.9, clamped: false });
  const after = getPixel(image, 0, 0);
  assert.equal(after.a, 200);
  assert.notEqual(after.r, 128); // gamma != 1 must actually change the value
});

test('gamma below 1 brightens a midtone pixel; gamma above 1 darkens it', () => {
  const brighten = createImage(1, 1, rgba(0, 0, 0, 0));
  setPixel(brighten, 0, 0, rgba(128, 128, 128, 255));
  applyGammaExposureAdjustment(brighten, { gamma: 0.9, clamped: false });
  assert.ok(getPixel(brighten, 0, 0).r > 128);

  const darken = createImage(1, 1, rgba(0, 0, 0, 0));
  setPixel(darken, 0, 0, rgba(128, 128, 128, 255));
  applyGammaExposureAdjustment(darken, { gamma: 1.1, clamped: false });
  assert.ok(getPixel(darken, 0, 0).r < 128);
});

test('meanLuminanceOfOpaquePixels ignores fully transparent pixels and averages the rest', () => {
  const image = createImage(2, 1, rgba(0, 0, 0, 0));
  setPixel(image, 0, 0, rgba(255, 255, 255, 255)); // luminance ~1
  setPixel(image, 1, 0, rgba(255, 255, 255, 0)); // transparent, ignored
  // Rec. 709 weight sum is 1.0 in exact decimal but not always in IEEE754
  // floating point, so compare within a tight epsilon rather than strict-equal.
  assert.ok(Math.abs(meanLuminanceOfOpaquePixels(image) - 1) < 1e-9);
});

test('meanLuminanceOfOpaquePixels returns 0 for an entirely transparent image (no divide-by-zero)', () => {
  const image = createImage(3, 3, rgba(0, 0, 0, 0));
  assert.equal(meanLuminanceOfOpaquePixels(image), 0);
});
