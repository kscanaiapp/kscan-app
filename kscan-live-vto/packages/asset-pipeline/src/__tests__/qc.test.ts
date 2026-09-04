import { test } from 'node:test';
import assert from 'node:assert/strict';
import { composeQcRecord, summarizeQcRecords, DEFAULT_QC_THRESHOLDS, type QcStageConfidences } from '../qc';

function goodInput(overrides: Partial<QcStageConfidences> = {}): QcStageConfidences {
  return {
    shotClass: 'A_FLAT_LAY',
    shotClassConfidence: 0.9,
    segmentationConfidence: 0.85,
    controlPointConfidence: 0.8,
    normalizationConfidence: 0.9,
    logoOrPatternDetected: false,
    colorPreservationScore: 0.9,
    manualAdjustmentApplied: false,
    ...overrides,
  };
}

test('composeQcRecord accepts input that clears every threshold', () => {
  const record = composeQcRecord('fixture-001', goodInput());
  assert.equal(record.verdict, 'ACCEPTED');
  assert.equal(record.reason, 'passed all thresholds automatically');
});

test('composeQcRecord notes manual adjustment in the accepted reason', () => {
  const record = composeQcRecord('fixture-001', goodInput({ manualAdjustmentApplied: true }));
  assert.equal(record.verdict, 'ACCEPTED');
  assert.match(record.reason, /manual adjustment/);
});

test('composeQcRecord rejects and explains a low segmentation confidence', () => {
  const record = composeQcRecord('fixture-002', goodInput({ segmentationConfidence: 0.1 }));
  assert.equal(record.verdict, 'REJECTED');
  assert.match(record.reason, /segmentation confidence/);
});

test('composeQcRecord aggregates every failing dimension into the reason', () => {
  const record = composeQcRecord(
    'fixture-003',
    goodInput({ segmentationConfidence: 0.1, controlPointConfidence: 0.1, normalizationConfidence: 0.1 }),
  );
  assert.equal(record.verdict, 'REJECTED');
  assert.match(record.reason, /segmentation/);
  assert.match(record.reason, /control-point/);
  assert.match(record.reason, /normalization/);
});

test('composeQcRecord ignores color preservation when not measured (null)', () => {
  const record = composeQcRecord('fixture-004', goodInput({ colorPreservationScore: null }));
  assert.equal(record.verdict, 'ACCEPTED');
});

test('composeQcRecord respects custom thresholds', () => {
  const strict = { ...DEFAULT_QC_THRESHOLDS, minSegmentationConfidence: 0.99 };
  const record = composeQcRecord('fixture-005', goodInput(), strict);
  assert.equal(record.verdict, 'REJECTED');
});

test('summarizeQcRecords buckets accept/reject counts per shot class', () => {
  const records = [
    composeQcRecord('a', goodInput({ shotClass: 'A_FLAT_LAY' })),
    composeQcRecord('b', goodInput({ shotClass: 'A_FLAT_LAY', segmentationConfidence: 0.1 })),
    composeQcRecord('c', goodInput({ shotClass: 'B_GHOST_MANNEQUIN' })),
  ];
  const summary = summarizeQcRecords(records);
  assert.deepEqual(summary.A_FLAT_LAY, { accepted: 1, rejected: 1 });
  assert.deepEqual(summary.B_GHOST_MANNEQUIN, { accepted: 1, rejected: 0 });
});
