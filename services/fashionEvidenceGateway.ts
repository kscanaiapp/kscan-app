// Shared fashion image-evidence gateway (Phase 2B.3).
//
// WHAT THIS IS: the consumer-neutral half of the Phase 2B.2 Scanner evidence
// gateway. Evidence-id minting, id validation and the wrapping of one already
// prepared derivative are identical work whether the caller is Scanner or Elise,
// so they live here once and both consumers import them.
//
// WHY EXTRACTED RATHER THAN COPIED: Phase 2B.3 forbids a second evidence-id
// generator. Two generators would be two chances to derive an id from a filename
// or a URI, and two places to fix when the contract's id format changes.
// `scannerEvidenceGateway.ts` now re-exports from here, so every existing
// Scanner import keeps resolving to this one implementation.
//
// WHAT THIS IS NOT: an image pipeline. Orientation, resizing, compression, MIME
// resolution, metadata stripping and payload-size limits already happened
// upstream in each consumer's own preparation path. Re-running any of them here
// would produce a second derivative, which is exactly the correlation bug this
// boundary exists to prevent: the bytes detection ran on must be the bytes the
// selected-item request re-sends.

import * as ExpoCrypto from 'expo-crypto';

/**
 * The contract's evidence-id format. Deliberately an allowlist rather than a
 * blocklist: `[A-Za-z0-9-]` cannot express a `file://`/`content://`/`ph://`
 * URI, a Windows path, a bare filename with an extension, an email, or a query
 * string, so an entire class of accidental PII leaks is excluded by
 * construction rather than by remembering to strip each shape.
 */
export const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/**
 * Where one prepared image came from.
 *
 * Scanner only ever produces `camera` or `gallery`. Elise adds
 * `header_gallery`, its multi-reference intake, which is a genuinely different
 * entry path in the contract and must not be flattened onto `gallery`.
 */
export type FashionEvidenceSource = 'camera' | 'gallery' | 'header_gallery';

/**
 * One prepared image, ready for transport.
 *
 * `imageBase64` is request-scoped. It must never reach long-lived UI state,
 * persistence, a cloud row, telemetry or a log line.
 */
export type PreparedFashionEvidenceObject = {
  evidenceId: string;
  imageBase64: string;
  mimeType: 'image/jpeg';
  width?: number;
  height?: number;
  source: FashionEvidenceSource;
};

/**
 * Cryptographically strong evidence id.
 *
 * Mirrors the proven secure-random chain already used for collaboration
 * idempotency keys (Web Crypto → expo-crypto UUID → expo-crypto random bytes),
 * because Hermes may ship without global Web Crypto. A v4 UUID is 36 chars of
 * `[0-9a-f-]`, so it satisfies EVIDENCE_ID_PATTERN.
 *
 * Never derived from a filename, path, timestamp, asset id, user id, or an
 * image hash: all of those are either correlatable across sessions or carry
 * user data into a field that is echoed back in responses.
 */
export function createEvidenceId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  if (typeof ExpoCrypto.randomUUID === 'function') {
    return ExpoCrypto.randomUUID();
  }
  const bytes = ExpoCrypto.getRandomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isValidEvidenceId(value: unknown): value is string {
  return typeof value === 'string' && EVIDENCE_ID_PATTERN.test(value);
}

/** Strips a data-URI prefix so only raw base64 crosses the boundary. */
export function toRawBase64(image: string): string {
  return image.replace(/^data:[^;]+;base64,/, '').trim();
}

export type PrepareFashionEvidenceInput = {
  /** The already-prepared derivative (data URI or raw base64). */
  preparedImage: string;
  source: FashionEvidenceSource;
  /**
   * Reuse an existing id when the SAME unchanged prepared image advances from
   * detection to selected-item identification. Omit for a new capture, retake,
   * replaced gallery item or rescan — those are new evidence.
   */
  evidenceId?: string;
  width?: number;
  height?: number;
};

function normalizeSource(value: unknown): FashionEvidenceSource {
  if (value === 'gallery') return 'gallery';
  if (value === 'header_gallery') return 'header_gallery';
  return 'camera';
}

/**
 * Wraps one already-prepared derivative as transport-ready evidence.
 *
 * Returns null rather than throwing when the derivative is unusable: an empty
 * or malformed image is a controlled outcome for both consumers, not an
 * exception their capture paths should have to catch.
 */
export function prepareFashionEvidence(
  input: PrepareFashionEvidenceInput,
): PreparedFashionEvidenceObject | null {
  if (!input || typeof input.preparedImage !== 'string') return null;
  const imageBase64 = toRawBase64(input.preparedImage);
  if (!imageBase64) return null;

  // A caller-supplied id is only honoured when it is genuinely a valid evidence
  // id. Silently accepting a URI or filename here is precisely how a local path
  // would reach the wire.
  const evidenceId = isValidEvidenceId(input.evidenceId)
    ? input.evidenceId
    : createEvidenceId();

  return {
    evidenceId,
    imageBase64,
    mimeType: 'image/jpeg',
    ...(Number.isFinite(input.width) ? { width: Math.trunc(input.width as number) } : {}),
    ...(Number.isFinite(input.height) ? { height: Math.trunc(input.height as number) } : {}),
    source: normalizeSource(input.source),
  };
}
