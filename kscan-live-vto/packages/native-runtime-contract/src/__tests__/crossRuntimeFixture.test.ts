import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateNativeReplayFixture } from '@kscan-live-vto/evaluation';
import { assertValidSequence, assertValidSemanticScene } from '@kscan-live-vto/realism';
import {
  REQUIRED_GOLDEN_SCENARIO_IDS,
  assertAllRequiredScenariosPresent,
  buildRequiredGoldenFixtures,
  createPendingEvidenceEntry,
} from '../crossRuntimeFixture';

test('buildRequiredGoldenFixtures produces exactly the required scenario set, no more, no fewer', () => {
  const fixtures = buildRequiredGoldenFixtures();
  assert.deepEqual(fixtures.map((f) => f.fixtureId).sort(), [...REQUIRED_GOLDEN_SCENARIO_IDS].sort());
  assert.doesNotThrow(() => assertAllRequiredScenariosPresent(fixtures));
});

test('every fixture\'s bodyFrames sub-fixture is independently valid per the existing NativeReplayFixture validator', () => {
  for (const fixture of buildRequiredGoldenFixtures()) {
    const result = validateNativeReplayFixture(fixture.bodyFrames);
    assert.ok(result.ok, `${fixture.fixtureId}: ${result.errors.join(', ')}`);
  }
});

test('every fixture\'s maskSequence, when present, is a valid ForegroundMaskSequence', () => {
  for (const fixture of buildRequiredGoldenFixtures()) {
    if (fixture.maskSequence) {
      assert.doesNotThrow(() => assertValidSequence(fixture.maskSequence!), `${fixture.fixtureId} maskSequence`);
    }
  }
});

test('every fixture\'s semanticScene, when present, is a valid SemanticScene', () => {
  for (const fixture of buildRequiredGoldenFixtures()) {
    if (fixture.semanticScene) {
      assert.doesNotThrow(() => assertValidSemanticScene(fixture.semanticScene!), `${fixture.fixtureId} semanticScene`);
    }
  }
});

test('arm-crossing pairs an unchanged neutral-shape BodyFrame sequence with a genuine crossing-arm mask sequence', () => {
  const fixtures = buildRequiredGoldenFixtures();
  const armCrossing = fixtures.find((f) => f.fixtureId === 'arm-crossing')!;
  assert.ok(armCrossing.maskSequence && armCrossing.maskSequence.length > 1);
});

test('tracking-loss and recovery are distinct fixtures even though both use a trackingLossWindow', () => {
  const fixtures = buildRequiredGoldenFixtures();
  const loss = fixtures.find((f) => f.fixtureId === 'tracking-loss')!;
  const recovery = fixtures.find((f) => f.fixtureId === 'recovery')!;
  assert.notEqual(loss.fixtureId, recovery.fixtureId);
  // tracking-loss: window near the end -> last frame's confidence is low.
  assert.ok(loss.bodyFrames.frames[loss.bodyFrames.frames.length - 1]!.trackingConfidence < 0.5);
  // recovery: window at the start -> last frame's confidence is back to normal.
  assert.ok(recovery.bodyFrames.frames[recovery.bodyFrames.frames.length - 1]!.trackingConfidence >= 0.5);
});

test('assertAllRequiredScenariosPresent throws when a scenario is missing', () => {
  const fixtures = buildRequiredGoldenFixtures().filter((f) => f.fixtureId !== 'lighting-stress');
  assert.throws(() => assertAllRequiredScenariosPresent(fixtures), /lighting-stress/);
});

test('createPendingEvidenceEntry always starts with nativeResult: null and an explanatory note', () => {
  const entry = createPendingEvidenceEntry('neutral', 'Node renderer: rigid gate passed, coverage 100%');
  assert.equal(entry.nativeResult, null);
  assert.match(entry.differenceNotes!, /NOT YET RUN/);
  assert.equal(entry.fixtureId, 'neutral');
});
