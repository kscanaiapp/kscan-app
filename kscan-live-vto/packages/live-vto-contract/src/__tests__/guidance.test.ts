import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_GUIDANCE_THRESHOLDS, selectGuidanceState, type GuidanceTriggers } from '../guidance';

function triggers(overrides: Partial<GuidanceTriggers> = {}): GuidanceTriggers {
  return {
    personDetected: true,
    torsoWidthNormalized: 0.4,
    horizontalOffsetNormalized: 0,
    bothShouldersVisible: true,
    armsOverlappingTorso: false,
    meanLuminance: 0.5,
    backlightDetected: false,
    stableForCapture: true,
    ...overrides,
  };
}

test('selectGuidanceState: no person outranks everything', () => {
  assert.equal(
    selectGuidanceState(triggers({ personDetected: false, torsoWidthNormalized: null, horizontalOffsetNormalized: null })),
    'NO_PERSON',
  );
});

test('selectGuidanceState: too close asks to move back', () => {
  assert.equal(
    selectGuidanceState(triggers({ torsoWidthNormalized: DEFAULT_GUIDANCE_THRESHOLDS.maxTorsoWidthNormalized + 0.1 })),
    'MOVE_BACK',
  );
});

test('selectGuidanceState: too far asks to move closer', () => {
  assert.equal(
    selectGuidanceState(triggers({ torsoWidthNormalized: DEFAULT_GUIDANCE_THRESHOLDS.minTorsoWidthNormalized - 0.05 })),
    'MOVE_CLOSER',
  );
});

test('selectGuidanceState: framing outranks lighting', () => {
  const state = selectGuidanceState(
    triggers({
      torsoWidthNormalized: DEFAULT_GUIDANCE_THRESHOLDS.maxTorsoWidthNormalized + 0.1,
      meanLuminance: 0.01,
    }),
  );
  assert.equal(state, 'MOVE_BACK');
});

test('selectGuidanceState: arms outrank lighting but not framing', () => {
  assert.equal(selectGuidanceState(triggers({ armsOverlappingTorso: true, meanLuminance: 0.01 })), 'MOVE_ARMS_SLIGHTLY_AWAY');
});

test('selectGuidanceState: backlight outranks plain low light', () => {
  assert.equal(selectGuidanceState(triggers({ backlightDetected: true, meanLuminance: 0.01 })), 'BACKLIGHT_DETECTED');
});

test('selectGuidanceState: not stable yet -> HOLD_STILL', () => {
  assert.equal(selectGuidanceState(triggers({ stableForCapture: false })), 'HOLD_STILL');
});

test('selectGuidanceState: everything satisfied -> READY', () => {
  assert.equal(selectGuidanceState(triggers()), 'READY');
});

test('selectGuidanceState: exactly one active state at a time (never overwhelms the user)', () => {
  const state = selectGuidanceState(
    triggers({ bothShouldersVisible: false, armsOverlappingTorso: true, meanLuminance: 0.01, backlightDetected: true }),
  );
  // Only ever one string comes back, and it is the single highest-priority condition.
  assert.equal(state, 'SHOW_BOTH_SHOULDERS');
});
