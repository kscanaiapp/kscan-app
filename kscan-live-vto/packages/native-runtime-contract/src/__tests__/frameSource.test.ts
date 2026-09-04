import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ForegroundMaskProvenance } from '@kscan-live-vto/realism';
import {
  FRAME_SOURCES,
  PERCEPTION_PROVENANCES,
  RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE,
  VALIDATION_LANE_FRAME_SOURCES,
  assertRealModelProvenanceIsEarned,
  toRuntimeFrameSource,
} from '../frameSource';

test('every validation-lane frame source reconciles to exactly one runtime frame source', () => {
  for (const laneSource of VALIDATION_LANE_FRAME_SOURCES) {
    const runtimeSource = toRuntimeFrameSource(laneSource);
    assert.ok((FRAME_SOURCES as readonly string[]).includes(runtimeSource));
  }
});

test('EMULATOR_CAMERA and SIMULATOR_CAMERA both reconcile to CAMERA; NATIVE_REPLAY_FIXTURE reconciles to NATIVE_REPLAY', () => {
  assert.equal(RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE.EMULATOR_CAMERA, 'CAMERA');
  assert.equal(RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE.SIMULATOR_CAMERA, 'CAMERA');
  assert.equal(RUNTIME_FRAME_SOURCE_BY_VALIDATION_LANE.NATIVE_REPLAY_FIXTURE, 'NATIVE_REPLAY');
});

test('PERCEPTION_PROVENANCES is a strict superset of realism\'s ForegroundMaskProvenance values, plus NONE', () => {
  // ForegroundMaskProvenance is a type, not a value, in @kscan-live-vto/realism --
  // this test instead pins the exact literal set both packages must agree on.
  const maskProvenanceValues = ['REAL_MODEL', 'NATIVE_REPLAY', 'PRECOMPUTED'];
  for (const v of maskProvenanceValues) {
    assert.ok((PERCEPTION_PROVENANCES as readonly string[]).includes(v), `missing ${v}`);
  }
  assert.ok((PERCEPTION_PROVENANCES as readonly string[]).includes('NONE'));
  assert.equal(PERCEPTION_PROVENANCES.length, maskProvenanceValues.length + 1);
});

test('assertRealModelProvenanceIsEarned passes only when every execution property is true', () => {
  assert.doesNotThrow(() =>
    assertRealModelProvenanceIsEarned({ compiled: true, loaded: true, processedRealInput: true, producedOutput: true }),
  );
});

test('assertRealModelProvenanceIsEarned throws and names every missing property', () => {
  assert.throws(
    () => assertRealModelProvenanceIsEarned({ compiled: true, loaded: false, processedRealInput: false, producedOutput: true }),
    /loaded, processedRealInput/,
  );
});

test('assertRealModelProvenanceIsEarned throws when nothing has happened at all', () => {
  assert.throws(
    () => assertRealModelProvenanceIsEarned({ compiled: false, loaded: false, processedRealInput: false, producedOutput: false }),
    RangeError,
  );
});

// Type-only compile check: this line only needs to type-check, proving
// ForegroundMaskProvenance still exists in @kscan-live-vto/realism with the
// name this module's header comment references. No runtime assertion.
void (null as unknown as ForegroundMaskProvenance);
