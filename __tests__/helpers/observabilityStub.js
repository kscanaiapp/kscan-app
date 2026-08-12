'use strict';

const REQUEST_ID = `ksr_${'a'.repeat(32)}`;
const TRACE_ID = 'b'.repeat(32);
const TRACEPARENT = `00-${TRACE_ID}-${'c'.repeat(16)}-01`;

module.exports = Object.freeze({
  createCorrelationContext: () => ({
    requestId: REQUEST_ID,
    traceId: TRACE_ID,
    traceparent: TRACEPARENT,
    epoch: 0,
  }),
  correlationHeaders: () => ({
    'X-KScan-Request-ID': REQUEST_ID,
    traceparent: TRACEPARENT,
  }),
  emitObservabilityEvent: () => {},
  resetCorrelationContext: () => {},
});
