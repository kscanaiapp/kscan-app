/**
 * Sanitized Scanner latency instrumentation.
 *
 * Records coarse timing markers for the multi-item Scanner pipeline so
 * developers and the hostile-validation stage can compare stage timings.
 *
 * Never logs image data, base64 payloads, tokens, secrets, actor identifiers,
 * or full digests. Markers carry only an event name, a scan generation
 * number, an optional small numeric detail, and a monotonic timestamp.
 */

export type ScanLatencyEvent =
  | 'scan_submit'
  | 'image_preparation_complete'
  | 'first_detection_request_sent'
  | 'all_detection_requests_sent'
  | 'first_detection_response'
  | 'all_detection_responses_settled'
  | 'candidate_normalization_complete'
  | 'candidate_review_first_paint'
  | 'selection_cta_pressed'
  | 'first_selected_request_sent'
  | 'first_selected_result_rendered'
  | 'subsequent_result_rendered'
  | 'queue_complete';

export type ScanLatencyMarker = {
  event: ScanLatencyEvent;
  generation: number;
  at: number;
  detail?: number;
};

const MAX_MARKERS = 200;
const markers: ScanLatencyMarker[] = [];

function now(): number {
  const perf = (globalThis as { performance?: { now?: () => number } }).performance;
  if (perf && typeof perf.now === 'function') return perf.now();
  return Date.now();
}

export function recordScanLatencyMarker(
  event: ScanLatencyEvent,
  generation: number,
  detail?: number,
): void {
  const marker: ScanLatencyMarker = {
    event,
    generation,
    at: now(),
    ...(typeof detail === 'number' && Number.isFinite(detail) ? { detail } : {}),
  };
  markers.push(marker);
  if (markers.length > MAX_MARKERS) markers.splice(0, markers.length - MAX_MARKERS);
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.log(
      `[KSCAN_LATENCY] ${marker.event} gen=${marker.generation} at=${marker.at.toFixed(1)}` +
      (marker.detail !== undefined ? ` detail=${marker.detail}` : ''),
    );
  }
}

/** Snapshot for developer inspection; never contains payload data. */
export function getScanLatencyMarkers(): ReadonlyArray<ScanLatencyMarker> {
  return markers.slice();
}

export function clearScanLatencyMarkers(): void {
  markers.length = 0;
}
