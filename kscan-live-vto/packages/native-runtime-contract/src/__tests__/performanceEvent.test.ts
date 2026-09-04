import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADAPTIVE_QUALITY_LEVELS,
  NON_PHYSICAL_RUNTIME_DATA_LABEL,
  RUNTIME_ERROR_STATES,
  selectAdaptiveQualityLevel,
  summarizePerformanceRecords,
  toRuntimeErrorEvent,
  type PerformanceRecord,
} from '../performanceEvent';

test('selectAdaptiveQualityLevel accepts every defined level and echoes it back unchanged', () => {
  for (const level of ADAPTIVE_QUALITY_LEVELS) {
    assert.equal(selectAdaptiveQualityLevel(level), level);
  }
});

test('selectAdaptiveQualityLevel rejects an unknown level', () => {
  assert.throws(() => selectAdaptiveQualityLevel('ULTRA' as never), RangeError);
});

function record(metric: PerformanceRecord['metric'], value: number): PerformanceRecord {
  return {
    timestamp: 0,
    platform: 'ios',
    session_id: 'sess-1',
    metric,
    value,
    unit: 'ms',
    frame_source: 'NATIVE_REPLAY',
    perception_provenance: 'NATIVE_REPLAY',
    quality_level: 'FULL',
  };
}

test('summarizePerformanceRecords computes count/min/max/mean for a matching metric only', () => {
  const records = [
    record('render_latency_ms', 10),
    record('render_latency_ms', 20),
    record('perception_latency_ms', 999), // different metric, must be excluded
  ];
  const summary = summarizePerformanceRecords(records, 'render_latency_ms');
  assert.deepEqual(summary, { metric: 'render_latency_ms', count: 2, min: 10, max: 20, mean: 15 });
});

test('summarizePerformanceRecords returns a zero-count shape rather than throwing when nothing matches', () => {
  const summary = summarizePerformanceRecords([], 'dropped_frame_ratio');
  assert.deepEqual(summary, { metric: 'dropped_frame_ratio', count: 0, min: null, max: null, mean: null });
});

test('NON_PHYSICAL_RUNTIME_DATA_LABEL names emulator/simulator and explicitly disclaims device performance', () => {
  assert.match(NON_PHYSICAL_RUNTIME_DATA_LABEL, /EMULATOR/);
  assert.match(NON_PHYSICAL_RUNTIME_DATA_LABEL, /NOT DEVICE PERFORMANCE/);
});

test('toRuntimeErrorEvent never leaks the native detail parameter into the returned event', () => {
  const event = toRuntimeErrorEvent('CAMERA_UNAVAILABLE', 'Camera is unavailable.', true, 'AVFoundation error -11852 (very specific vendor detail)');
  assert.deepEqual(event, { state: 'CAMERA_UNAVAILABLE', message: 'Camera is unavailable.', recoverable: true });
  assert.ok(!JSON.stringify(event).includes('AVFoundation'));
});

test('every RUNTIME_ERROR_STATES value round-trips through toRuntimeErrorEvent', () => {
  for (const state of RUNTIME_ERROR_STATES) {
    const event = toRuntimeErrorEvent(state, 'x', false);
    assert.equal(event.state, state);
  }
});
