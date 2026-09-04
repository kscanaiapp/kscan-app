import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHOTOREAL_INTENT_STATES,
  PHOTOREAL_INTENT_TRANSITIONS,
  PHOTOREAL_STATE_TO_PRIVACY_PHASE,
  requestPhotorealCapture,
  returnToLive,
  type PhotorealIntentState,
} from '../photorealIntent';

test('the full happy path advances LIVE_LOCAL -> CAPTURE_CONSENT -> STILL_CAPTURED -> GENERATIVE_HANDOFF_READY, one explicit call at a time', () => {
  let state: PhotorealIntentState = 'LIVE_LOCAL';
  const path: PhotorealIntentState[] = [state];
  for (let i = 0; i < 3; i += 1) {
    const result = requestPhotorealCapture(state);
    assert.equal(result.ok, true);
    if (result.ok) state = result.to;
    path.push(state);
  }
  assert.deepEqual(path, ['LIVE_LOCAL', 'CAPTURE_CONSENT', 'STILL_CAPTURED', 'GENERATIVE_HANDOFF_READY']);
});

test('GENERATIVE_HANDOFF_READY is terminal within this contract: calling requestPhotorealCapture again is refused, not silently advanced', () => {
  const result = requestPhotorealCapture('GENERATIVE_HANDOFF_READY');
  assert.deepEqual(result, { ok: false, reason: 'terminal_state' });
});

test('an unrecognized state is refused distinctly from a terminal one', () => {
  const result = requestPhotorealCapture('SOMETHING_ELSE' as never);
  assert.deepEqual(result, { ok: false, reason: 'unknown_state' });
});

test('every transition requires explicit user action, and there are exactly three (one per state boundary)', () => {
  assert.equal(PHOTOREAL_INTENT_TRANSITIONS.length, 3);
  for (const t of PHOTOREAL_INTENT_TRANSITIONS) assert.equal(t.requiresExplicitUserAction, true);
});

test('every PHOTOREAL_INTENT_STATES member maps to a known LiveVTOPrivacyPhase, and only LIVE_LOCAL maps to the live phase', () => {
  const values = Object.values(PHOTOREAL_STATE_TO_PRIVACY_PHASE);
  assert.equal(values.length, PHOTOREAL_INTENT_STATES.length);
  assert.equal(PHOTOREAL_STATE_TO_PRIVACY_PHASE.LIVE_LOCAL, 'live');
  for (const state of PHOTOREAL_INTENT_STATES) {
    if (state === 'LIVE_LOCAL') continue;
    assert.notEqual(PHOTOREAL_STATE_TO_PRIVACY_PHASE[state], 'live', `${state} must not map back onto the local-only privacy phase`);
  }
});

test('returnToLive always yields LIVE_LOCAL, unconditionally', () => {
  assert.equal(returnToLive(), 'LIVE_LOCAL');
});
