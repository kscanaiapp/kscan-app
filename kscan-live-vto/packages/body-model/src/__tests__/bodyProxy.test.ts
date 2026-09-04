import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyBodyFrame, type BodyFrame, type Landmark } from '@kscan-live-vto/contract';
import { BodyProxyCalibrator, deriveBodyProxy } from '../bodyProxy';

function present(u: number, v: number, confidence = 0.95): Landmark {
  return { present: true, point: { u, v }, confidence };
}

function frameWithShouldersOnly(): BodyFrame {
  return {
    ...emptyBodyFrame(1000),
    leftShoulder: present(0.35, 0.3),
    rightShoulder: present(0.65, 0.3),
  };
}

function fullUpperBodyFrame(): BodyFrame {
  return {
    ...emptyBodyFrame(1000),
    leftShoulder: present(0.35, 0.3),
    rightShoulder: present(0.65, 0.3),
    leftHip: present(0.38, 0.7),
    rightHip: present(0.62, 0.7),
    leftElbow: present(0.3, 0.45),
    rightElbow: present(0.7, 0.45),
    leftWrist: present(0.28, 0.6),
    rightWrist: present(0.72, 0.6),
  };
}

test('deriveBodyProxy returns null when shoulders are absent (no fabricated geometry)', () => {
  assert.equal(deriveBodyProxy(emptyBodyFrame(0)), null);
});

test('deriveBodyProxy computes shoulderWidth and leaves optional fields null when landmarks are missing', () => {
  const proxy = deriveBodyProxy(frameWithShouldersOnly());
  assert.ok(proxy);
  assert.ok(Math.abs(proxy!.shoulderWidth - 0.3) < 1e-9);
  assert.equal(proxy!.hipWidth, null);
  assert.equal(proxy!.torsoHeight, null);
  assert.equal(proxy!.leftUpperArmVector, null);
  assert.equal(proxy!.cameraRelativeScale, null);
});

test('deriveBodyProxy computes arm vectors normalized by shoulder-width scale', () => {
  const proxy = deriveBodyProxy(fullUpperBodyFrame());
  assert.ok(proxy);
  assert.ok(proxy!.leftUpperArmVector);
  assert.ok(proxy!.torsoHeight !== null && proxy!.torsoHeight > 0);
  assert.ok(proxy!.hipWidth !== null && proxy!.hipWidth > 0);
});

test('deriveBodyProxy: level shoulders yield ~0 torso orientation', () => {
  const proxy = deriveBodyProxy(frameWithShouldersOnly());
  assert.ok(Math.abs(proxy!.torsoOrientation) < 1e-9);
});

test('deriveBodyProxy: right shoulder higher (smaller v) yields positive orientation', () => {
  const frame: BodyFrame = {
    ...emptyBodyFrame(0),
    leftShoulder: present(0.35, 0.35),
    rightShoulder: present(0.65, 0.25),
  };
  const proxy = deriveBodyProxy(frame);
  assert.ok(proxy!.torsoOrientation > 0);
});

test('BodyProxyCalibrator: relativeScaleFor is null before calibration, ratio after', () => {
  const calibrator = new BodyProxyCalibrator();
  assert.equal(calibrator.isCalibrated, false);
  assert.equal(calibrator.relativeScaleFor(0.3), null);

  calibrator.calibrate(0.3);
  assert.equal(calibrator.isCalibrated, true);
  assert.ok(Math.abs(calibrator.relativeScaleFor(0.3)! - 1.0) < 1e-9);
  assert.ok(Math.abs(calibrator.relativeScaleFor(0.6)! - 2.0) < 1e-9); // twice as close -> ~2x scale

  calibrator.reset();
  assert.equal(calibrator.isCalibrated, false);
});

test('deriveBodyProxy uses the calibrator when supplied', () => {
  const calibrator = new BodyProxyCalibrator();
  calibrator.calibrate(0.3);
  const proxy = deriveBodyProxy(frameWithShouldersOnly(), calibrator);
  assert.ok(Math.abs(proxy!.cameraRelativeScale! - 1.0) < 1e-9);
});
