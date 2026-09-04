import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NATIVE_CAPTURE_STATES,
  NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT,
  advanceNativeCaptureState,
  assertCleanFrameForHandoff,
  cancelNativeCapture,
  evaluateCaptureQualityGate,
  PROVISIONAL_CAPTURE_QUALITY_THRESHOLDS,
  type NativeCaptureState,
  type CapturedFrameHandle,
} from '../capturePipeline';

test('the full happy path advances LIVE_RUNNING through every state to GENERATIVE_HANDOFF_READY', () => {
  let state: NativeCaptureState = 'LIVE_RUNNING';
  const path: NativeCaptureState[] = [state];
  for (let i = 0; i < 4; i += 1) {
    const step = advanceNativeCaptureState(state);
    assert.equal(step.ok, true);
    if (step.ok) state = step.to;
    path.push(state);
  }
  assert.deepEqual(path, [
    'LIVE_RUNNING', 'CAPTURE_PRECHECK', 'CAPTURE_PERSON_FRAME', 'CAPTURE_CONFIRMATION', 'GENERATIVE_HANDOFF_READY',
  ]);
});

test('GENERATIVE_HANDOFF_READY is terminal', () => {
  assert.deepEqual(advanceNativeCaptureState('GENERATIVE_HANDOFF_READY'), { ok: false, reason: 'terminal_state' });
});

test('an unknown state is refused distinctly from a terminal one', () => {
  assert.deepEqual(advanceNativeCaptureState('NOT_A_STATE' as never), { ok: false, reason: 'unknown_state' });
});

test('cancellation from any state returns to LIVE_RUNNING', () => {
  for (const state of NATIVE_CAPTURE_STATES) {
    void state; // cancelNativeCapture takes no input by design -- see its own doc
  }
  assert.equal(cancelNativeCapture(), 'LIVE_RUNNING');
});

test('every NativeCaptureState maps to a PhotorealIntentState, and only LIVE_RUNNING maps to LIVE_LOCAL', () => {
  assert.equal(Object.keys(NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT).length, NATIVE_CAPTURE_STATES.length);
  assert.equal(NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT.LIVE_RUNNING, 'LIVE_LOCAL');
  for (const state of NATIVE_CAPTURE_STATES) {
    if (state === 'LIVE_RUNNING') continue;
    assert.notEqual(NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT[state], 'LIVE_LOCAL');
  }
});

test('CAPTURE_PRECHECK and CAPTURE_PERSON_FRAME both collapse onto the JS layer\'s single CAPTURE_CONSENT state', () => {
  assert.equal(NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT.CAPTURE_PRECHECK, 'CAPTURE_CONSENT');
  assert.equal(NATIVE_CAPTURE_STATE_TO_PHOTOREAL_INTENT.CAPTURE_PERSON_FRAME, 'CAPTURE_CONSENT');
});

function handle(kind: CapturedFrameHandle['kind']): CapturedFrameHandle {
  return { captureId: 'cap-1', kind, localUri: 'file:///x.jpg', width: 100, height: 100 };
}

test('assertCleanFrameForHandoff accepts a PERSON_FRAME handle', () => {
  assert.doesNotThrow(() => assertCleanFrameForHandoff(handle('PERSON_FRAME')));
});

test('assertCleanFrameForHandoff refuses a PREVIEW handle -- the composited image must never reach generative VTO', () => {
  assert.throws(() => assertCleanFrameForHandoff(handle('PREVIEW')), /PERSON_FRAME/);
});

function measurements(overrides: Partial<Parameters<typeof evaluateCaptureQualityGate>[0]> = {}) {
  return {
    sharpnessScore: 0.9,
    meanLuminance: 0.5,
    torsoFrameFraction: 0.4,
    trackingConfidence: 0.9,
    ...overrides,
  };
}

test('evaluateCaptureQualityGate passes a well-lit, sharp, framed capture', () => {
  assert.deepEqual(evaluateCaptureQualityGate(measurements()), { ok: true });
});

test('evaluateCaptureQualityGate collects every failing measurement, not just the first', () => {
  const result = evaluateCaptureQualityGate(
    measurements({ sharpnessScore: 0, meanLuminance: 0, torsoFrameFraction: null }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual([...result.reasons].sort(), ['severe_blur', 'severe_underexposure', 'torso_not_framed'].sort());
});

test('evaluateCaptureQualityGate flags overexposure distinctly from underexposure', () => {
  const result = evaluateCaptureQualityGate(measurements({ meanLuminance: 0.99 }));
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.reasons, ['severe_overexposure']);
});

test('evaluateCaptureQualityGate treats a null trackingConfidence as "not relevant" rather than a failure', () => {
  assert.deepEqual(evaluateCaptureQualityGate(measurements({ trackingConfidence: null })), { ok: true });
});

test('evaluateCaptureQualityGate accepts a custom threshold set', () => {
  const strict = { ...PROVISIONAL_CAPTURE_QUALITY_THRESHOLDS, minSharpnessScore: 0.95 };
  const result = evaluateCaptureQualityGate(measurements({ sharpnessScore: 0.9 }), strict);
  assert.equal(result.ok, false);
});
