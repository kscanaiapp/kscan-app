import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRIVACY_STAGE_COPY,
  USER_VISIBLE_PRIVACY_STAGES,
  assertNoZeroKnowledgeClaim,
  describePrivacyStage,
  describeReturnToLive,
} from '../privacyStateModel';

test('LIVE_LOCAL always describes as LIVE_PREVIEW regardless of bridgeInFlight', () => {
  assert.equal(describePrivacyStage('LIVE_LOCAL', false).stage, 'LIVE_PREVIEW');
  assert.equal(describePrivacyStage('LIVE_LOCAL', true).stage, 'LIVE_PREVIEW');
});

test('CAPTURE_CONSENT and STILL_CAPTURED both describe as PHOTOREAL_REQUESTED (still fully local)', () => {
  assert.equal(describePrivacyStage('CAPTURE_CONSENT', false).stage, 'PHOTOREAL_REQUESTED');
  assert.equal(describePrivacyStage('STILL_CAPTURED', false).stage, 'PHOTOREAL_REQUESTED');
});

test('GENERATIVE_HANDOFF_READY describes as PHOTOREAL_REQUESTED until the bridge is actually in flight, then PHOTOREAL_PROCESSING', () => {
  assert.equal(describePrivacyStage('GENERATIVE_HANDOFF_READY', false).stage, 'PHOTOREAL_REQUESTED');
  assert.equal(describePrivacyStage('GENERATIVE_HANDOFF_READY', true).stage, 'PHOTOREAL_PROCESSING');
});

test('describeReturnToLive is its own distinct stage, not identical to the steady-state LIVE_PREVIEW description', () => {
  const returned = describeReturnToLive();
  assert.equal(returned.stage, 'RETURN_TO_LIVE');
  assert.notEqual(returned.detail, PRIVACY_STAGE_COPY.LIVE_PREVIEW.detail);
});

test('every stage has a non-empty headline and detail', () => {
  for (const stage of USER_VISIBLE_PRIVACY_STAGES) {
    const copy = PRIVACY_STAGE_COPY[stage];
    assert.ok(copy.headline.trim().length > 0);
    assert.ok(copy.detail.trim().length > 0);
  }
});

test('assertNoZeroKnowledgeClaim passes every candidate string in this module', () => {
  for (const stage of USER_VISIBLE_PRIVACY_STAGES) {
    const copy = PRIVACY_STAGE_COPY[stage];
    assert.doesNotThrow(() => assertNoZeroKnowledgeClaim(copy.headline));
    assert.doesNotThrow(() => assertNoZeroKnowledgeClaim(copy.detail));
  }
});

test('assertNoZeroKnowledgeClaim actually catches a zero-knowledge claim (case-insensitive, hyphen-optional)', () => {
  assert.throws(() => assertNoZeroKnowledgeClaim('This is a zero-knowledge system.'), RangeError);
  assert.throws(() => assertNoZeroKnowledgeClaim('Fully Zero Knowledge processing.'), RangeError);
  assert.doesNotThrow(() => assertNoZeroKnowledgeClaim('Processing happens on this device.'));
});
