import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PHOTOREAL_FAILURE_CODES, handlePhotorealFailure } from '../failureModes';

test('every defined failure code resolves to LIVE_LOCAL with the session still usable', () => {
  for (const code of PHOTOREAL_FAILURE_CODES) {
    const outcome = handlePhotorealFailure(code);
    assert.equal(outcome.code, code);
    assert.equal(outcome.resultingState, 'LIVE_LOCAL', `${code} must return the session to LIVE_LOCAL`);
    assert.equal(outcome.liveSessionRemainsUsable, true, `${code} must not corrupt the local Live session`);
  }
});

test('there are exactly eight defined failure codes, matching Section 26', () => {
  assert.equal(PHOTOREAL_FAILURE_CODES.length, 8);
  assert.deepEqual([...PHOTOREAL_FAILURE_CODES].sort(), [
    'bridge_contract_mismatch',
    'capture_cancelled',
    'entitlement_missing',
    'feature_disabled',
    'garment_not_eligible',
    'generation_failed',
    'no_usable_still',
    'provider_unavailable',
  ]);
});
