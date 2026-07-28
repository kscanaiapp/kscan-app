// Scanner evidence gateway (Phase 2B.2, re-based on the shared gateway in 2B.3).
//
// WHAT THIS IS: Scanner's view of the single boundary between the existing
// Phase 2A.5 clean-frame preparation and the fashion-identification-v2
// transport. Every Scanner image — camera, gallery, each image of an Android
// batch — becomes exactly one PreparedScannerEvidence here, and nothing else in
// Scanner is allowed to build a transport evidence object.
//
// WHAT CHANGED IN 2B.3: id minting, id validation and derivative wrapping moved
// to `fashionEvidenceGateway.ts` so Elise consumes the same code rather than a
// copy. Scanner's public API is unchanged — every symbol below kept its name,
// signature and behaviour, and `PreparedScannerEvidence` still narrows `source`
// to the two values Scanner can actually produce. This file is now the
// Scanner-shaped view of the shared boundary, not a second implementation.
//
// WHAT THIS IS NOT: an image pipeline. Orientation, resizing, compression, MIME
// resolution, metadata stripping and payload-size enforcement already happened
// upstream (compressForUpload → privacy adapter). Re-running any of them here
// would produce a second derivative, which is exactly the correlation bug this
// boundary exists to prevent: the bytes detection ran on must be the bytes the
// selected-item request re-sends.

import {
  createEvidenceId,
  EVIDENCE_ID_PATTERN,
  isValidEvidenceId,
  prepareFashionEvidence,
} from './fashionEvidenceGateway';

export { createEvidenceId, EVIDENCE_ID_PATTERN, isValidEvidenceId };

/**
 * Scanner captures from a camera or a gallery. `header_gallery` exists in the
 * shared type for Elise's multi-reference intake and is deliberately not
 * reachable from Scanner: narrowing here means a Scanner caller cannot pass one
 * by accident and end up sending an Elise entry path.
 */
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
 * Wraps one already-prepared derivative as transport-ready Scanner evidence.
 *
 * Returns null rather than throwing when the derivative is unusable: an empty
 * or malformed image is a controlled Scanner outcome, not an exception the
 * capture path should have to catch.
 */
export function prepareScannerEvidence(
  input: PrepareScannerEvidenceInput,
): PreparedScannerEvidence | null {
  if (!input) return null;
  // `source` is re-narrowed rather than forwarded blind: the shared gateway
  // accepts `header_gallery`, and a Scanner evidence object must never claim it.
  const source: ScannerEvidenceSource = input.source === 'gallery' ? 'gallery' : 'camera';
  const prepared = prepareFashionEvidence({ ...input, source });
  if (!prepared) return null;
  return { ...prepared, source };
}
