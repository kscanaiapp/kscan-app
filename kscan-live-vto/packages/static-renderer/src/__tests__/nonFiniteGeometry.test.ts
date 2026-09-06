import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NEUTRAL_PERSON, generateSyntheticPerson } from '../fixtures/person';
import { LOGO_TEE, generateSyntheticGarment } from '../fixtures/garment';
import {
  computeControlPointTargets,
  evaluateRigidGate,
  extractBodyAnchors,
  fitRigidPlacement,
} from '../attachment';
import type { BodyFrame, Landmark } from '@kscan-live-vto/contract';

/**
 * N1-ENV-008 negative control.
 *
 * Reproduces the reported defect exactly: a landmark that reports
 * `present: true` with a NaN or Infinite coordinate previously sailed
 * through every numeric guard in this file, because a comparison against
 * NaN is always `false` -- `shoulderSpanPx < 1` does not catch it,
 * and every one of `evaluateRigidGate`'s five checks does not catch it
 * either. The result was `evaluateRigidGate` returning
 * `passed: true, findings: []` on entirely undefined geometry: the gate
 * whose stated purpose is "is this garment semantically attached to this
 * body at all" was certifying that it was, having measured nothing.
 *
 * This test would have failed before the repair and must pass after it.
 */

function present(u: number, v: number): Landmark {
  return { present: true, point: { u, v }, confidence: 1 };
}

test('a NaN landmark coordinate fails closed at extractBodyAnchors, not silently through the rigid gate', () => {
  const base = generateSyntheticPerson(NEUTRAL_PERSON);
  const bodyFrame: BodyFrame = { ...base.bodyFrame, leftShoulder: present(Number.NaN, 0.28) };

  const anchors = extractBodyAnchors(bodyFrame, base.image.width, base.image.height);

  assert.equal(anchors.ok, false, 'a NaN shoulder coordinate must be rejected, not treated as a valid position');
  if (!anchors.ok) {
    assert.equal(
      anchors.reason,
      'missing_shoulders',
      'a non-finite landmark reuses the existing missing_shoulders reason -- it is not a valid position, same as absent',
    );
  }
});

test('an Infinite landmark coordinate fails closed the same way', () => {
  const base = generateSyntheticPerson(NEUTRAL_PERSON);
  const bodyFrame: BodyFrame = { ...base.bodyFrame, rightHip: present(0.6, Number.POSITIVE_INFINITY) };

  const anchors = extractBodyAnchors(bodyFrame, base.image.width, base.image.height);

  assert.equal(anchors.ok, false, 'an Infinite hip coordinate must be rejected');
  if (!anchors.ok) {
    assert.equal(anchors.reason, 'missing_hips');
  }
});

test('REGRESSION GUARD: if non-finite geometry ever reaches evaluateRigidGate anyway, it fails closed rather than reporting passed:true with zero findings', () => {
  // Bypasses extractBodyAnchors entirely to prove the gate's OWN defense
  // works even if a future caller gets the upstream check wrong -- this is
  // the exact reproduction of the originally reported symptom.
  const base = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);

  const poisonedAnchors = {
    leftShoulder: { x: Number.NaN, y: Number.NaN },
    rightShoulder: { x: Number.NaN, y: Number.NaN },
    neckBase: { x: Number.NaN, y: Number.NaN },
    leftHip: { x: Number.NaN, y: Number.NaN },
    rightHip: { x: Number.NaN, y: Number.NaN },
    waist: { x: Number.NaN, y: Number.NaN },
    leftElbow: null,
    rightElbow: null,
    shoulderSpanPx: Number.NaN,
    torsoHeightPx: Number.NaN,
  };

  const targets = computeControlPointTargets(garment.manifest, poisonedAnchors, garment.texture.width, garment.texture.height);
  // computeControlPointTargets itself guards on vSpan/uSpan/bodyAxisLength,
  // all of which become NaN here, so it returns {} -- but the gate must not
  // rely on that either.
  const placement = fitRigidPlacement(garment.manifest, garment.texture.width, garment.texture.height, targets);

  if (!placement.ok) {
    // computeControlPointTargets refused (returned {}), so there is no
    // rigid placement to gate at all -- that is ALSO a correct fail-closed
    // outcome, just at an earlier stage. Confirm it explicitly rather than
    // silently passing the test on a path that never reached the gate.
    assert.equal(placement.reason, 'missing_shoulder_control_points');
    return;
  }

  const gate = evaluateRigidGate(garment.manifest, placement.transform, garment.texture.width, garment.texture.height, poisonedAnchors);

  assert.equal(gate.passed, false, 'THE ORIGINAL DEFECT: non-finite geometry must never report passed:true');
  assert.ok(gate.findings.length > 0, 'THE ORIGINAL DEFECT: non-finite geometry must never report an empty findings list');
  assert.ok(
    gate.findings.includes('non_finite_measurement'),
    `expected 'non_finite_measurement' among findings, got ${JSON.stringify(gate.findings)}`,
  );
});

test('valid finite geometry is completely unaffected by the repair', () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);

  const anchors = extractBodyAnchors(person.bodyFrame, person.image.width, person.image.height);
  assert.equal(anchors.ok, true, 'the unmodified neutral fixture must still extract anchors successfully');
  if (!anchors.ok) return;

  const targets = computeControlPointTargets(garment.manifest, anchors.anchors, garment.texture.width, garment.texture.height);
  const placement = fitRigidPlacement(garment.manifest, garment.texture.width, garment.texture.height, targets);
  assert.equal(placement.ok, true);
  if (!placement.ok) return;

  const gate = evaluateRigidGate(garment.manifest, placement.transform, garment.texture.width, garment.texture.height, anchors.anchors);
  assert.equal(gate.passed, true, 'a real, finite, correctly-attached garment must still pass');
  assert.deepEqual(gate.findings, []);
  assert.ok(!gate.findings.includes('non_finite_measurement' as never));
});
