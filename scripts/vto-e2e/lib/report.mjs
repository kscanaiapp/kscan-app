/**
 * Report/evidence hygiene for the VTO E2E harness.
 *
 * Every artifact this harness writes must be safe to upload: hashes, sizes,
 * classifications and status — never payloads. This module is the one place
 * a raw provider/adapter response is touched before it reaches a report, so
 * "never print X" is enforced structurally rather than by convention at each
 * call site.
 */
'use strict';

/** GitHub Actions' own `::add-mask::` convention — printed to stderr only,
 *  never to the stdout stream a report file is built from. */
export function maskLine(secretValue) {
  return `::add-mask::${secretValue}`;
}

/**
 * Reduces a raw vto-generate HTTP response to the evidence shape a report
 * may contain: status class, contract fields, and classification — never
 * the JWT used to call it, never a raw provider body, never a provider task
 * id, never the actual result bytes (only their size/hash/type).
 */
export function sanitizeVtoResponse(response) {
  const body = response.json;
  const evidence = {
    httpStatus: response.status,
    status: typeof body?.status === 'string' ? body.status : null,
    provider: typeof body?.provider === 'string' ? body.provider : null,
    errorCode: typeof body?.error?.code === 'string' ? body.error.code : null,
    retryable: typeof body?.error?.retryable === 'boolean' ? body.error.retryable : null,
  };
  if (body?.status === 'success' && body?.result) {
    const dataUri = typeof body.result.dataUri === 'string' ? body.result.dataUri : '';
    const commaIndex = dataUri.indexOf(',');
    const base64 = commaIndex >= 0 ? dataUri.slice(commaIndex + 1) : '';
    evidence.result = {
      mediaType: body.result.mediaType ?? null,
      isAiVisualization: body.result.isAiVisualization ?? null,
      width: body.result.width ?? null,
      height: body.result.height ?? null,
      latencyMs: body.result.latencyMs ?? null,
      // Approximate decoded byte length from base64 length — never the bytes
      // themselves, and never the data URI.
      approxResultBytes: base64 ? Math.floor((base64.length * 3) / 4) : 0,
      hasNonEmptyMedia: base64.length > 0,
    };
  }
  return evidence;
}

/** Strips exactly the fields a report must never carry, defensively, even if
 *  a caller passes a raw object through by mistake. Belt-and-suspenders over
 *  sanitizeVtoResponse — this is what the final JSON.stringify of any report
 *  should be run through. */
const FORBIDDEN_KEY_PATTERN = /token|jwt|authorization|password|api[-_]?key|secret|task[-_]?id|dataUri|data_uri/i;

export function assertReportSafe(value, path = '$') {
  if (value === null || typeof value !== 'object') return;
  for (const [key, val] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new Error(`report hygiene violation: forbidden key "${key}" at ${path}.${key}`);
    }
    assertReportSafe(val, `${path}.${key}`);
  }
}

export function writeReport(report) {
  assertReportSafe(report);
  return `${JSON.stringify(report, null, 2)}\n`;
}
