// Scanner-only evidence gateway (Phase 2B.2).
//
// WHAT THIS IS: the single boundary between the existing Phase 2A.5 clean-frame
// preparation and the fashion-identification-v2 transport. Every Scanner image —
// camera, gallery, each image of an Android batch — becomes exactly one
// PreparedScannerEvidence here, and nothing else in Scanner is allowed to build
// a transport evidence object.
//
// WHAT THIS IS NOT: an image pipeline. Orientation, resizing, compression, MIME
// resolution, metadata stripping and payload-size enforcement already happened
// upstream (compressForUpload → privacy adapter). Re-running any of them here
// would produce a second derivative, which is exactly the correlation bug this
// boundary exists to prevent: the bytes detection ran on must be the bytes the
// selected-item request re-sends.
//
// SCANNER ONLY. Elise's attachment path does not route through this module and
// its behaviour is unchanged by Phase 2B.2.

import * as ExpoCrypto from 'expo-crypto';

/**
 * The contract's evidence-id format. Deliberately an allowlist rather than a
 * blocklist: `[A-Za-z0-9-]` cannot express a `file://`/`content://`/`ph://`
 * URI, a Windows path, a bare filename with an extension, an email, or a query
 * string, so an entire class of accidental PII leaks is excluded by
 * construction rather than by remembering to strip each shape.
 */
export const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

export type ScannerEvidenceSource = 'camera' | 'gallery';

/**
 * One prepared Scanner image, ready for transport.
 *
 * `imageBase64` is request-scoped. It must never reach long-lived UI state,
 * persistence, a cloud row, telemetry or a log line.
 */
export type PreparedScannerEvidence = {
  evidenceId: string;
  imageBase64: string;
  mimeType: 'image/jpeg';
  width?: number;
  height?: number;
  source: ScannerEvidenceSource;
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
function toRawBase64(image: string): string {
  return image.replace(/^data:[^;]+;base64,/, '').trim();
}

export type PrepareScannerEvidenceInput = {
  /** The already-prepared Phase 2A.5 derivative (data URI or raw base64). */
  preparedImage: string;
  source: ScannerEvidenceSource;
  /**
   * Reuse an existing id when the SAME unchanged prepared image advances from
   * detection to selected-item identification. Omit for a new capture, retake,
   * replaced gallery item or rescan — those are new evidence.
   */
  evidenceId?: string;
  width?: number;
  height?: number;
};

/**
 * Wraps one already-prepared derivative as transport-ready evidence.
 *
 * Returns null rather than throwing when the derivative is unusable: an empty
 * or malformed image is a controlled Scanner outcome, not an exception the
 * capture path should have to catch.
 */
export function prepareScannerEvidence(
  input: PrepareScannerEvidenceInput,
): PreparedScannerEvidence | null {
  if (!input || typeof input.preparedImage !== 'string') return null;
  const imageBase64 = toRawBase64(input.preparedImage);
  if (!imageBase64) return null;

  // A caller-supplied id is only honoured when it is genuinely a valid evidence
  // id. Silently accepting a URI or filename here is precisely how a local path
  // would reach the wire.
  const evidenceId = isValidEvidenceId(input.evidenceId)
    ? input.evidenceId
    : createEvidenceId();

  const source: ScannerEvidenceSource = input.source === 'gallery' ? 'gallery' : 'camera';

  return {
    evidenceId,
    imageBase64,
    mimeType: 'image/jpeg',
    ...(Number.isFinite(input.width) ? { width: Math.trunc(input.width as number) } : {}),
    ...(Number.isFinite(input.height) ? { height: Math.trunc(input.height as number) } : {}),
    source,
  };
}
