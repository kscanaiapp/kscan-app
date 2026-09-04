/**
 * Static renderer bridge compatibility check — emulator-native validation
 * lane, Section 11.
 *
 * "Prove that a BodyFrame produced by the native pipeline can be
 * serialized into the existing deterministic evaluation format and fed
 * into the static preview renderer offline... This is not the final
 * product architecture. It is a compatibility check."
 *
 * No native pipeline ran in this session (see docs/vto-native-device-
 * handoff.md's emulator-lane section — no macOS/Xcode, no Android SDK/
 * emulator reachable from this sandbox's network policy). The BodyFrame
 * used here comes from the existing synthetic person fixture, which is the
 * same stand-in the rest of Section 19's review packages already use. What
 * this test actually proves is narrower and still real: that a BodyFrame
 * which has round-tripped through JSON — exactly the shape crossing a
 * process/session boundary the way a native-pipeline export would — still
 * produces the identical render as the in-memory original. A native
 * BodyFrame is a plain data struct with no methods and no non-JSON-safe
 * fields (see bodyFrame.ts), so this is the whole compatibility surface;
 * it is not a claim that native perception itself was exercised.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BodyFrame } from '@kscan-live-vto/contract';
import { LOGO_TEE, generateSyntheticGarment } from '../fixtures/garment';
import { NEUTRAL_PERSON, generateSyntheticPerson } from '../fixtures/person';
import { renderDeformedStage, renderRigidStage, type RenderInput } from '../renderPreview';
import { encodePng } from '../png';

function jsonRoundTrip(frame: BodyFrame): BodyFrame {
  return JSON.parse(JSON.stringify(frame)) as BodyFrame;
}

function buildInput(bodyFrame: BodyFrame): RenderInput {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const garment = generateSyntheticGarment(LOGO_TEE);
  return {
    fixtureId: person.spec.fixtureId,
    caseId: 'native-bridge-compat',
    personImage: person.image,
    bodyFrame,
    descriptor: garment.descriptor,
    asset: {
      manifest: garment.manifest,
      texture: garment.texture,
      alphaMask: garment.alphaMask,
      logoBoxTexturePx: garment.logoBoxTexturePx,
    },
    foregroundMask: person.foregroundMask,
    maskProvenance: 'precomputed',
    gitSha: 'test',
  };
}

test('a JSON-round-tripped BodyFrame (native-export stand-in) is byte-identical to the original after parsing', () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const roundTripped = jsonRoundTrip(person.bodyFrame);
  assert.deepEqual(roundTripped, person.bodyFrame);
});

test('a JSON-round-tripped BodyFrame renders pixel-identically to the original through the full rigid + deformed pipeline', () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const originalInput = buildInput(person.bodyFrame);
  const exportedInput = buildInput(jsonRoundTrip(person.bodyFrame));

  const originalRigid = renderRigidStage(originalInput);
  const exportedRigid = renderRigidStage(exportedInput);
  assert.ok(originalRigid.ok && exportedRigid.ok, 'both renders must pass the rigid stop gate');
  if (!originalRigid.ok || !exportedRigid.ok) return;

  assert.equal(originalRigid.result.gate.passed, true);
  assert.equal(exportedRigid.result.gate.passed, true);

  const originalDeformed = renderDeformedStage(originalInput, originalRigid.result);
  const exportedDeformed = renderDeformedStage(exportedInput, exportedRigid.result);
  assert.ok(originalDeformed.ok && exportedDeformed.ok, 'both deformed renders must succeed');
  if (!originalDeformed.ok || !exportedDeformed.ok) return;

  // Pixel-identical PNG bytes is the strongest available proof: it means the
  // exported/re-parsed BodyFrame drove every downstream stage (anchors,
  // targets, deformation, compositing, lighting) to numerically identical
  // results, not merely "close" ones.
  assert.deepEqual(encodePng(originalDeformed.result.image), encodePng(exportedDeformed.result.image));
});

test('a BodyFrame with an absent landmark (a real provider condition) still round-trips and renders through the gate', () => {
  const person = generateSyntheticPerson(NEUTRAL_PERSON);
  const withAbsentWrist: BodyFrame = { ...person.bodyFrame, leftWrist: { present: false } };
  const roundTripped = jsonRoundTrip(withAbsentWrist);
  assert.deepEqual(roundTripped, withAbsentWrist);

  const rigid = renderRigidStage(buildInput(roundTripped));
  assert.ok(rigid.ok, 'a missing non-attachment landmark must not fail the rigid stage');
});
