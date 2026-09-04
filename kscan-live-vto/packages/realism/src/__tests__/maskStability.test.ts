import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMask, fillRect, maskAt, totalCoverage, type ForegroundMaskFrame } from '../foregroundMask';
import {
  confidenceReductionSequence,
  maskDropoutSequence,
  stableForegroundSequence,
  trackingLossSequence,
} from '../sequenceFixtures';
import {
  DEFAULT_MASK_STABILITY_CONFIG,
  holdEpisodeLengths,
  stabilizeSequence,
  type MaskStabilityConfig,
} from '../maskStability';

test('a stable sequence passes through untouched: never held, never failed-safe', () => {
  const out = stabilizeSequence(stableForegroundSequence(6));
  for (const f of out) {
    assert.equal(f.held, false);
    assert.equal(f.trusted, true);
    assert.equal(f.failedSafe, false);
    assert.equal(f.holdFramesUsed, 0);
  }
});

test('a short dropout (within the hold budget) freezes the prior mask exactly -- no single-frame pop, no failedSafe', () => {
  const out = stabilizeSequence(maskDropoutSequence(4, 1, 4));
  const dropoutFrame = out[4]!; // index 4 = the single dropout frame (0-indexed after 4 good frames)
  assert.equal(dropoutFrame.trusted, false);
  assert.equal(dropoutFrame.held, true);
  assert.equal(dropoutFrame.failedSafe, false);
  // The held output must be exactly the last trusted mask, not some
  // in-between or empty value -- that is what "no popping" means concretely.
  const lastTrusted = out[3]!;
  assert.equal(totalCoverage(dropoutFrame.mask), totalCoverage(lastTrusted.mask));
});

test('a dropout longer than the hold budget eventually reports failedSafe, but decays gradually rather than cutting instantly', () => {
  const config: MaskStabilityConfig = { ...DEFAULT_MASK_STABILITY_CONFIG, maxHoldFrames: 3 };
  const out = stabilizeSequence(trackingLossSequence(3, 10, 3), config);
  const lossFrames = out.slice(3, 13); // the 10 low-confidence frames
  const withinBudget = lossFrames.slice(0, 3);
  const overBudget = lossFrames.slice(3);
  for (const f of withinBudget) assert.equal(f.failedSafe, false);
  assert.ok(overBudget.some((f) => f.failedSafe), 'failedSafe should eventually trigger once the hold budget is exceeded');

  // Bounded lag / gradual decay: the very first over-budget frame should
  // still show most of its coverage (not an abrupt cut to near-zero), and
  // decay should be monotonically non-increasing as the episode continues.
  const firstOver = overBudget[0]!;
  const heldTotal = totalCoverage(withinBudget[withinBudget.length - 1]!.mask);
  assert.ok(totalCoverage(firstOver.mask) > heldTotal * 0.5, 'decay must be gradual, not an abrupt cut on the exceeding frame');
  let previousTotal = totalCoverage(firstOver.mask);
  for (const f of overBudget.slice(1)) {
    const t = totalCoverage(f.mask);
    assert.ok(t <= previousTotal + 1e-9, 'decay must not increase again mid-episode');
    previousTotal = t;
  }
});

test('recovery after a hold blends over multiple frames rather than snapping instantly to a different mask', () => {
  // Hand-built so the pre-loss and post-recovery masks are genuinely
  // different in content (not just re-affirming the same rectangle), so a
  // blended intermediate frame is pixel-distinguishable from either source.
  const left = createMask(10, 10, 0);
  fillRect(left, { x: 0, y: 0, w: 4, h: 10 }, 1);
  const right = createMask(10, 10, 0);
  fillRect(right, { x: 6, y: 0, w: 4, h: 10 }, 1);

  const sequence: ForegroundMaskFrame[] = [
    { timestamp: 0, mask: left, confidence: 0.9, provenance: 'PRECOMPUTED' },
    { timestamp: 100, mask: createMask(10, 10, 0), confidence: 0.1, provenance: 'PRECOMPUTED' },
    { timestamp: 200, mask: right, confidence: 0.9, provenance: 'PRECOMPUTED' },
    { timestamp: 300, mask: right, confidence: 0.9, provenance: 'PRECOMPUTED' },
    { timestamp: 400, mask: right, confidence: 0.9, provenance: 'PRECOMPUTED' },
  ];

  const out = stabilizeSequence(sequence, { ...DEFAULT_MASK_STABILITY_CONFIG, transitionBlendPerFrame: 0.34 });
  const recoveryFrame = out[2]!; // first frame back at high confidence, geometry = right
  assert.equal(recoveryFrame.trusted, true);
  assert.equal(recoveryFrame.held, true, 'the first recovered frame should still be mid-transition, not fully live');

  // left and right have equal total coverage (40 each, just at different
  // texels), so comparing SUMS can't detect a blend -- lerp between two
  // equal-sum masks has the same sum at every t. Check an individual texel
  // that is fully-on in `left` and fully-off in `right` instead: a genuine
  // blend leaves it strictly between 0 and 1, where either pure source
  // would leave it exactly 1 (held) or exactly 0 (snapped to new).
  const blendedTexel = maskAt(recoveryFrame.mask, 1, 1); // inside the `left` rectangle (x:0..4), outside `right` (x:6..10)
  assert.ok(blendedTexel > 0 && blendedTexel < 1, `expected a genuine blend at (1,1), got ${blendedTexel}`);

  // Within a few frames (bounded by transitionBlendPerFrame) the stream
  // should fully settle on the live mask.
  const settled = out[out.length - 1]!;
  assert.equal(settled.held, false);
  assert.equal(totalCoverage(settled.mask), totalCoverage(right));
});

test('confidence hysteresis: a dip that stays above the low threshold does not trigger distrust', () => {
  const config: MaskStabilityConfig = {
    ...DEFAULT_MASK_STABILITY_CONFIG,
    confidenceLowThreshold: 0.2,
    confidenceHighThreshold: 0.5,
  };
  // 0.4 stays above confidenceLowThreshold (0.2), so a stream that was
  // already trusted must stay trusted through the dip.
  const out = stabilizeSequence(confidenceReductionSequence(3, 3, 3, 0.4), config);
  for (const f of out) {
    assert.equal(f.trusted, true, 'a dip above the low threshold must never distrust an already-trusted stream');
  }
});

test('confidence hysteresis: a dip that crosses the low threshold does trigger distrust and hold', () => {
  const out = stabilizeSequence(confidenceReductionSequence(3, 3, 3, 0.1));
  const dipFrames = out.slice(3, 6);
  for (const f of dipFrames) {
    assert.equal(f.trusted, false);
    assert.equal(f.held, true);
  }
});

test('holdEpisodeLengths reports one run-length per contiguous held span', () => {
  const flags = [
    { held: false }, { held: true }, { held: true }, { held: false },
    { held: false }, { held: true }, { held: false }, { held: true }, { held: true }, { held: true },
  ];
  assert.deepEqual(holdEpisodeLengths(flags), [2, 1, 3]);
});

test('stabilizeSequence rejects an invalid config', () => {
  assert.throws(
    () => stabilizeSequence(stableForegroundSequence(2), { ...DEFAULT_MASK_STABILITY_CONFIG, confidenceHighThreshold: 0.1, confidenceLowThreshold: 0.5 }),
    RangeError,
  );
  assert.throws(
    () => stabilizeSequence(stableForegroundSequence(2), { ...DEFAULT_MASK_STABILITY_CONFIG, transitionBlendPerFrame: 0 }),
    RangeError,
  );
});
