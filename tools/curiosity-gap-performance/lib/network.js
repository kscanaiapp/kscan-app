'use strict';
/**
 * Upload / transport model.
 *
 * K Scan does not upload a file. It uploads a JSON document with the JPEG
 * base64-encoded inside it (`supabase.functions.invoke` with
 * `body: { imageBase64, ... }`). That single fact makes payload size a
 * first-class TTFAR axis rather than a footnote, because base64 costs a fixed
 * 4/3 expansion plus JSON string escaping on top of the compressed JPEG.
 *
 * EVIDENCE DISCIPLINE:
 *   payload bytes  — PROVEN for a given fixture/profile: we apply the real
 *                    documented transform and count actual bytes.
 *   bandwidth, RTT — always MODELED. There is no network measurement in this
 *                    lane and inventing one is forbidden (§C).
 *   upload time    — therefore always MODELED (combineEvidence).
 */

const { combineEvidence } = require('./evidence');

/** base64 expands 3 bytes to 4, padded up to a multiple of 4. */
function base64Length(byteLength) {
  if (!Number.isInteger(byteLength) || byteLength < 0) {
    throw new TypeError('base64Length requires a non-negative integer byte length');
  }
  return 4 * Math.ceil(byteLength / 3);
}

/**
 * Bytes on the wire for the scan request.
 *
 * The base64 alphabet (A-Za-z0-9+/=) contains no character JSON must escape,
 * so the encoded image contributes exactly its own length plus the two quote
 * characters. That is why this is computed rather than estimated.
 */
function scanRequestPayloadBytes({ compressedImageBytes, envelopeBytes }) {
  if (!Number.isInteger(compressedImageBytes) || compressedImageBytes < 0) {
    throw new TypeError('compressedImageBytes must be a non-negative integer');
  }
  const encoded = base64Length(compressedImageBytes);
  const envelope = Number.isInteger(envelopeBytes) ? envelopeBytes : 0;
  return {
    compressed_image_bytes: compressedImageBytes,
    base64_bytes: encoded,
    base64_expansion_ratio: compressedImageBytes === 0 ? 0 : encoded / compressedImageBytes,
    json_envelope_bytes: envelope,
    // +2 for the JSON string quotes around the base64 value.
    request_body_bytes: encoded + envelope + 2,
  };
}

/**
 * Time to push `bytes` up a link, plus connection setup.
 *
 * Deliberately simple (§17): serialization delay + a fixed number of RTTs for
 * handshake/first-byte. No congestion-window model, no slow start. A slow-start
 * model would add precision the inputs cannot justify — bandwidth and RTT are
 * both MODELED, so the sweep matters far more than the fidelity of the curve.
 */
function uploadTimeMs({ bytes, uplinkMbps, rttMs, setupRoundTrips = 2 }) {
  if (!(bytes >= 0)) throw new TypeError('bytes must be >= 0');
  if (!(uplinkMbps > 0)) throw new TypeError('uplinkMbps must be > 0');
  if (!(rttMs >= 0)) throw new TypeError('rttMs must be >= 0');
  const bitsPerSecond = uplinkMbps * 1_000_000;
  const serializationMs = (bytes * 8) / bitsPerSecond * 1000;
  const setupMs = setupRoundTrips * rttMs;
  return {
    serialization_ms: serializationMs,
    setup_ms: setupMs,
    total_ms: serializationMs + setupMs,
    evidence_class: 'MODELED',
    assumptions: { uplinkMbps, rttMs, setupRoundTrips },
  };
}

/** Response download, same model, downlink side. */
function downloadTimeMs({ bytes, downlinkMbps, rttMs }) {
  if (!(downlinkMbps > 0)) throw new TypeError('downlinkMbps must be > 0');
  const serializationMs = (bytes * 8) / (downlinkMbps * 1_000_000) * 1000;
  return {
    serialization_ms: serializationMs,
    setup_ms: 0, // connection is already established by the time the response returns
    total_ms: serializationMs,
    evidence_class: 'MODELED',
    assumptions: { downlinkMbps, rttMs },
  };
}

/**
 * The question §20 actually asks: at what bandwidth does upload stop being a
 * rounding error and start dominating TTFAR?
 *
 * `dominanceThresholdMbps` solves for the uplink at which upload time equals
 * `shareOfBudget` of a given non-upload budget. Returned as MODELED, with the
 * payload byte count carried alongside so the reader can see which term is
 * measured and which is assumed.
 */
function uploadDominanceThresholdMbps({ bytes, otherPathMs, shareOfBudget = 0.5, rttMs, setupRoundTrips = 2 }) {
  if (!(shareOfBudget > 0 && shareOfBudget < 1)) {
    throw new TypeError('shareOfBudget must be strictly between 0 and 1');
  }
  const targetMs = otherPathMs * (shareOfBudget / (1 - shareOfBudget));
  const setupMs = setupRoundTrips * rttMs;
  const serializationBudgetMs = targetMs - setupMs;
  if (serializationBudgetMs <= 0) {
    return {
      threshold_mbps: Infinity,
      note: 'RTT setup alone already exceeds the target share; bandwidth cannot fix this',
      evidence_class: 'MODELED',
    };
  }
  const mbps = (bytes * 8) / (serializationBudgetMs / 1000) / 1_000_000;
  return {
    threshold_mbps: mbps,
    payload_bytes: bytes,
    other_path_ms: otherPathMs,
    share_of_budget: shareOfBudget,
    evidence_class: 'MODELED',
    interpretation:
      `below ~${mbps.toFixed(2)} Mbps uplink, upload contributes at least ` +
      `${(shareOfBudget * 100).toFixed(0)}% of this path`,
  };
}

/** Sweep helper — §22 forbids reporting a single fake point estimate. */
function sweep(values, fn) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new TypeError('sweep requires a non-empty array of parameter values');
  }
  return values.map((v) => ({ input: v, output: fn(v) }));
}

function combineNetworkEvidence(...classes) {
  return combineEvidence(classes.flat());
}

module.exports = {
  base64Length,
  scanRequestPayloadBytes,
  uploadTimeMs,
  downloadTimeMs,
  uploadDominanceThresholdMbps,
  sweep,
  combineNetworkEvidence,
};
