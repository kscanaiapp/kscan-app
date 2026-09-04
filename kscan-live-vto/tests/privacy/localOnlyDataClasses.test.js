'use strict';

/**
 * Section 13 regression guard: the LOCAL_ONLY_DURING_LIVE list in
 * @kscan-live-vto/contract enumerates every data class that must never
 * leave the device while privacy phase === 'live'. This test only proves
 * the list hasn't silently shrunk (e.g. someone "cleaning up" an
 * apparently-unused export deletes an entry along with it) — it cannot
 * verify real network traffic; see dependencyBoundary.test.js and
 * docs/vto-risk-register.md RISK 8 for that limitation.
 *
 * Requires packages/live-vto-contract to already be built (npm run
 * build/test at the workspace root does this before running tests/privacy).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const REQUIRED_LOCAL_ONLY_CLASSES = [
  'cameraFrame',
  'faceImagery',
  'bodyImagery',
  'poseLandmarks',
  'segmentationMask',
  'bodyProxy',
  'cameraDerivedGeometry',
  'lightingAnalysis',
  'captureReplayBuffer',
];

test('LOCAL_ONLY_DURING_LIVE still covers every Section 13 data class', () => {
  const contractDist = path.resolve(__dirname, '..', '..', 'packages', 'live-vto-contract', 'dist', 'index.js');
  const { LOCAL_ONLY_DURING_LIVE } = require(contractDist);

  assert.ok(Array.isArray(LOCAL_ONLY_DURING_LIVE));
  for (const dataClass of REQUIRED_LOCAL_ONLY_CLASSES) {
    assert.ok(
      LOCAL_ONLY_DURING_LIVE.includes(dataClass),
      `LOCAL_ONLY_DURING_LIVE is missing required data class "${dataClass}"`,
    );
  }
});

test('FORBIDDEN_EVENT_PAYLOAD_KEYS still blocks raw frame/mask/landmark keys from crossing the JS/native boundary', () => {
  const contractDist = path.resolve(__dirname, '..', '..', 'packages', 'live-vto-contract', 'dist', 'index.js');
  const { FORBIDDEN_EVENT_PAYLOAD_KEYS } = require(contractDist);

  for (const key of ['frame', 'pixels', 'mask', 'landmarks', 'bodyFrame']) {
    assert.ok(FORBIDDEN_EVENT_PAYLOAD_KEYS.includes(key), `expected "${key}" to be a forbidden event payload key`);
  }
});
