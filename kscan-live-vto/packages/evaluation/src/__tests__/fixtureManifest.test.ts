import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GOLDEN_SEQUENCE_CATEGORIES, isCoverageComplete, type GoldenSequenceManifest } from '../fixtureManifest';

test('isCoverageComplete reports every missing Section 17 category when given none', () => {
  const result = isCoverageComplete([]);
  assert.equal(result.complete, false);
  assert.equal(result.missing.length, GOLDEN_SEQUENCE_CATEGORIES.length);
});

test('isCoverageComplete is true once every category has at least one manifest', () => {
  const manifests: GoldenSequenceManifest[] = GOLDEN_SEQUENCE_CATEGORIES.map((category, i) => ({
    sequenceId: `seq-${i}`,
    category,
    description: 'placeholder',
    nominalFrameRateHz: 30,
    frameCount: 10,
    consent: null,
    synthetic: true,
  }));
  const result = isCoverageComplete(manifests);
  assert.equal(result.complete, true);
  assert.deepEqual(result.missing, []);
});
