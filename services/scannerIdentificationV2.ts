// Scanner fashion-identification-v2 adapter (Phase 2B.2).
//
// THE ONE PLACE a Scanner V2 request is built and a V2 response is accepted.
// Camera, gallery, retry, every image of an Android batch, detection and
// selection all converge here. A Scanner call to `scan-identify` that does not
// pass through this module is a migration bypass, and the path-governance test
// fails on one.
//
// GOVERNING ARCHITECTURE: one identification core, multiple consumer intents.
// Scanner is always `identify_and_shop`. Elise (Phase 2B.3) is always
// `identify_for_style` and lives in `services/style-chat/eliseIdentificationV2.ts`.
// Both sit on `fashionIdentificationV2Core.ts`, which holds the intent-neutral
// half — response validation, candidate extraction, the unsupported-version
// predicate and telemetry buckets — so there is one validator, not two.
// Request BUILDING stays per-consumer on purpose: a request carries an intent,
// and a shared builder is exactly the thing that could be handed the wrong one.
//
// WHAT THIS MODULE DOES NOT DO:
//   - classify, re-classify or reinterpret provider output
//   - compress, resize or re-orient an image (Phase 2A.5 already did)
//   - parse, rank, dedupe or filter purchase options (unchanged legacy path)
//   - persist anything

import {
  FASHION_IDENTIFICATION_CONTRACT_V2,
  type FashionIdentificationRequestV2,
  type FashionIdentificationResultV2,
  type FashionIdentificationPlatform,
  type FashionIdentificationEntryPath,
} from '../types/fashionIdentificationV2';
import type { PreparedScannerEvidence } from './scannerEvidenceGateway';
import { isValidEvidenceId } from './scannerEvidenceGateway';
import { resolveScannerIdentificationV2Enabled } from '../constants/featureFlags';
import { createEvidenceId } from './scannerEvidenceGateway';
import {
  bucketCount as bucketCountShared,
  extractFashionV2Candidates,
  isRecord,
  isUnsupportedContractVersion as isUnsupportedContractVersionShared,
  str,
  validateFashionV2RequestEnvelope,
  validateFashionV2Response,
  type FashionCandidateCorrelation,
  type FashionLegacyCorrelation,
  type FashionV2ResponseValidation,
} from './fashionIdentificationV2Core';

/** Scanner never sends any other intent. */
export const SCANNER_INTENT = 'identify_and_shop' as const;

export type ScannerV2Mode = 'detect_items' | 'identify_selected_item';

// ── Session-latched rollout flag ─────────────────────────────────────────────

/**
 * The flag is resolved ONCE when a Scanner session begins and that value is
 * carried through capture → detection → selection → identification →
 * persistence.
 *
 * WHY LATCH: a mid-session change would otherwise let detection run under V2
 * and the follow-up selected-item request run under legacy (or the reverse).
 * The two requests would then be shaped by different contracts while claiming
 * to describe the same garment, and the persisted snapshot could disagree with
 * the response that produced it. A NEW session resolves the flag again, so a
 * change still takes effect — just never mid-operation.
 */
export type ScannerV2SessionFlag = {
  readonly enabled: boolean;
};

export function beginScannerV2Session(
  resolver: () => boolean = resolveScannerIdentificationV2Enabled,
): ScannerV2SessionFlag {
  let enabled = false;
  try {
    enabled = resolver() === true;
  } catch {
    // A resolver failure must fail closed onto the legacy path, never open.
    enabled = false;
  }
  return Object.freeze({ enabled });
}

// ── Correlation tuple ────────────────────────────────────────────────────────

/**
 * The immutable link between a detection candidate and the selected-item
 * request that follows it.
 *
 * `detectionDigest` is SERVER-GENERATED and optional in the contract. The
 * client stores whatever detection returned and echoes it back verbatim; it
 * never computes, recomputes, or substitutes one. See the note on
 * `legacyCorrelation` below for what actually carries correlation today.
 */
export type ScannerCandidateCorrelation = FashionCandidateCorrelation;

/**
 * The server-issued legacy correlation pair that `scan-identify` still enforces
 * on a selected-item request, on BOTH the legacy and V2 paths.
 *
 * WHY THIS EXISTS ALONGSIDE detectionDigest: the deployed handler reads
 * `body.scanSessionId` / `body.imageDigestPrefix` at the top level and hard-
 * fails a selected-item request whose supplied image digest is missing or does
 * not match the sha256 prefix of the transported bytes. Those two values are
 * produced by the server (Android reads them off the detection response) or,
 * on iOS, computed from the prepared derivative exactly as they are today.
 * Carrying them forward unchanged is what lets a V2 selected-item request
 * succeed without any backend change.
 *
 * This is NOT a detection digest and is never written into
 * `selectedCandidate.detectionDigest`. Conflating a session id with a detection
 * digest is explicitly forbidden, and the two fields mean different things.
 */
export type ScannerLegacyCorrelation = FashionLegacyCorrelation;

// ── Request building ─────────────────────────────────────────────────────────

export type ScannerV2RequestInput = {
  mode: ScannerV2Mode;
  evidence: PreparedScannerEvidence;
  platform: FashionIdentificationPlatform;
  /** Stable per-operation id; becomes the contract requestId. */
  requestId: string;
  appVersion?: string;
  /** Required for identify_selected_item, rejected for detect_items. */
  selectedCandidate?: ScannerCandidateCorrelation;
};

/**
 * String discriminants, not a boolean `ok`.
 *
 * This project compiles with `strictNullChecks` disabled, and under that
 * setting TypeScript does not narrow a union on a boolean literal discriminant —
 * `if (!result.ok)` leaves the type unnarrowed and every access to the failure
 * payload is an error. A string discriminant narrows correctly regardless.
 */
export type ScannerV2RequestResult =
  | { kind: 'ok'; request: FashionIdentificationRequestV2 }
  | { kind: 'rejected'; reason: ScannerV2RejectReason };

/**
 * Bounded local rejection reasons. These are client-side contract violations
 * caught before any network call — never provider or transport failures.
 */
export type ScannerV2RejectReason =
  | 'invalid_evidence'
  | 'invalid_evidence_id'
  | 'invalid_request_id'
  | 'missing_selected_candidate'
  | 'invalid_selected_candidate'
  | 'evidence_id_mismatch';

/**
 * Scanner entry path for the contract's `source` block.
 *
 * The contract distinguishes camera from gallery; the evidence object already
 * carries which one this image came from, so no caller can disagree with it.
 */
function entryPathFor(source: PreparedScannerEvidence['source']): FashionIdentificationEntryPath {
  return source === 'gallery' ? 'scanner_gallery' : 'scanner_camera';
}

export function buildScannerV2Request(input: ScannerV2RequestInput): ScannerV2RequestResult {
  if (!input || !isRecord(input.evidence)) return { kind: 'rejected', reason: 'invalid_evidence' };
  const evidence = input.evidence;
  if (!isValidEvidenceId(evidence.evidenceId)) {
    return { kind: 'rejected', reason: 'invalid_evidence_id' };
  }
  if (!str(evidence.imageBase64)) return { kind: 'rejected', reason: 'invalid_evidence' };
  const requestId = str(input.requestId);
  if (!requestId) return { kind: 'rejected', reason: 'invalid_request_id' };

  if (input.mode === 'identify_selected_item') {
    const candidate = input.selectedCandidate;
    if (!isRecord(candidate)) return { kind: 'rejected', reason: 'missing_selected_candidate' };
    const candidateId = str(candidate.candidateId);
    const category = str(candidate.category);
    // Category comes FROM detection. A selected-item request that has lost it
    // is rejected locally rather than re-derived, because re-deriving would be
    // the client guessing which garment the user picked.
    if (!candidateId || !category) return { kind: 'rejected', reason: 'invalid_selected_candidate' };
    if (!isValidEvidenceId(candidate.evidenceId)) {
      return { kind: 'rejected', reason: 'invalid_selected_candidate' };
    }
    // The selection must belong to the evidence being transported. A mismatch
    // means a candidate from one image is about to be identified against
    // another image's bytes.
    if (candidate.evidenceId !== evidence.evidenceId) {
      return { kind: 'rejected', reason: 'evidence_id_mismatch' };
    }
  }

  const request: FashionIdentificationRequestV2 = {
    contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
    requestId,
    intent: SCANNER_INTENT,
    mode: input.mode,
    source: {
      entryPath: entryPathFor(evidence.source),
      platform: input.platform,
      ...(str(input.appVersion) ? { appVersion: str(input.appVersion) as string } : {}),
    },
    // Exactly one evidence object per HTTP request. The backend rejects more
    // than one, and combining images would destroy per-image correlation.
    evidence: [
      {
        evidenceId: evidence.evidenceId,
        sequenceIndex: 0,
        transport: { type: 'jpeg_base64', imageBase64: evidence.imageBase64 },
        metadata: {
          schemaVersion: 'image-metadata-v1',
          ...(evidence.width !== undefined ? { width: evidence.width } : {}),
          ...(evidence.height !== undefined ? { height: evidence.height } : {}),
          mimeType: 'image/jpeg',
        },
      },
    ],
    // Truthful attestation. Face and plate masking remain deferred; JPEG
    // re-encoding and EXIF stripping are not privacy filtering and must never
    // be reported as if they were.
    privacy: {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
    },
  };

  if (input.mode === 'identify_selected_item' && input.selectedCandidate) {
    const candidate = input.selectedCandidate;
    request.selectedCandidate = {
      candidateId: candidate.candidateId,
      evidenceId: candidate.evidenceId,
      category: candidate.category,
      ...(str(candidate.clothingType) ? { clothingType: candidate.clothingType as string } : {}),
      ...(str(candidate.subtype) ? { subtype: candidate.subtype as string } : {}),
      ...(candidate.bounds ? { bounds: candidate.bounds } : {}),
      // Echoed ONLY when detection actually supplied one. Never fabricated.
      ...(str(candidate.detectionDigest)
        ? { detectionDigest: candidate.detectionDigest as string }
        : {}),
    };
  }

  return { kind: 'ok', request };
}

/**
 * Structural pre-flight on the finished request.
 *
 * Cheap, and it converts a whole class of would-be HTTP 400s into a local
 * rejection that never spends a network call or a backend scan.
 */
export function validateScannerV2Request(request: unknown): boolean {
  // Scanner's own intent assertion first, then the shared envelope checks. The
  // intent test stays HERE rather than in the shared helper: it is the one field
  // a shared validator must never be responsible for.
  if (!isRecord(request)) return false;
  if (request.intent !== SCANNER_INTENT) return false;
  return validateFashionV2RequestEnvelope(request);
}

// ── Response validation ──────────────────────────────────────────────────────

export type ScannerV2ResponseValidation = FashionV2ResponseValidation;

/**
 * Strict structural validation of an incoming V2 result.
 *
 * Delegates to the shared validator so Scanner and Elise cannot drift into
 * accepting different payloads while both claiming to implement one contract.
 * The behaviour, the bounded failure categories and the return shape are
 * unchanged from Phase 2B.2.
 */
export function validateScannerV2Response(raw: unknown): ScannerV2ResponseValidation {
  return validateFashionV2Response(raw);
}

/**
 * Detection candidates carried by a V2 result, correlated to their evidence.
 *
 * A candidate that does not name the evidence it came from, or names a
 * different one, is dropped rather than repaired: a mis-correlated candidate
 * would later be identified against the wrong image's bytes.
 */
export function extractScannerV2Candidates(
  result: FashionIdentificationResultV2,
  evidenceId: string,
): ScannerCandidateCorrelation[] {
  return extractFashionV2Candidates(result, evidenceId);
}

// ── Legacy fallback policy ───────────────────────────────────────────────────

/**
 * The ONLY condition that may fall back to the legacy contract.
 *
 * A build with the flag on can reach a backend that predates V2 activation.
 * That backend answers HTTP 400 / UNSUPPORTED_CONTRACT_VERSION, which is an
 * unambiguous statement that this contract is not implemented — so retrying the
 * same scan under the legacy contract is correct and lossless.
 *
 * Everything else is NOT a contract-support signal and must remain its real
 * error: a timeout, a dropped connection, an HTTP 500, an auth failure, a quota
 * failure, a `technical_failure` result, `insufficient_visual_evidence`, and a
 * malformed or invalid V2 payload. Falling back on those would silently convert
 * a real failure into a second full-price scan and hide the actual fault.
 */
export function isUnsupportedContractVersion(input: {
  httpStatus?: number | null;
  errorCode?: string | null;
}): boolean {
  return isUnsupportedContractVersionShared(input);
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export type ScannerV2Telemetry = {
  scannerV2Enabled: boolean;
  scannerV2Attempted: boolean;
  scannerV2Accepted: boolean;
  scannerV2UnsupportedVersionFallback: boolean;
  requestMode: ScannerV2Mode | null;
  entryPath: FashionIdentificationEntryPath | null;
  platform: FashionIdentificationPlatform | null;
  source: PreparedScannerEvidence['source'] | null;
  resultStatus: string | null;
  resolutionLevel: string | null;
  candidateCountBucket: string | null;
  snapshotVersion: number | null;
  fallbackUsed: boolean;
  fallbackReason: 'unsupported_version' | null;
};

/** Coarse buckets only — an exact count is closer to a fingerprint than a metric. */
export function bucketCount(count: number | null | undefined): string | null {
  return bucketCountShared(count);
}

/**
 * Bounded, non-identifying Scanner telemetry.
 *
 * Deliberately absent, and asserted absent by test: evidenceId, candidateId,
 * detectionDigest, bounds, Base64, local URIs, filenames, asset ids, the
 * request body, provider output, purchase URLs, user ids, emails, device ids
 * and GPS. Every field below is an enum, a boolean, a bucket or null.
 */
export function buildScannerV2Telemetry(input: {
  enabled: boolean;
  attempted: boolean;
  accepted: boolean;
  mode: ScannerV2Mode | null;
  evidenceSource: PreparedScannerEvidence['source'] | null;
  platform: FashionIdentificationPlatform | null;
  result: FashionIdentificationResultV2 | null;
  candidateCount?: number | null;
  snapshotVersion?: number | null;
  fallbackUsed?: boolean;
}): ScannerV2Telemetry {
  const fallbackUsed = input.fallbackUsed === true;
  return {
    scannerV2Enabled: input.enabled === true,
    scannerV2Attempted: input.attempted === true,
    scannerV2Accepted: input.accepted === true,
    scannerV2UnsupportedVersionFallback: fallbackUsed,
    requestMode: input.mode ?? null,
    entryPath: input.evidenceSource ? entryPathFor(input.evidenceSource) : null,
    platform: input.platform ?? null,
    source: input.evidenceSource ?? null,
    resultStatus: input.result?.status ?? null,
    resolutionLevel: input.result?.resolutionLevel ?? null,
    candidateCountBucket: bucketCount(input.candidateCount ?? null),
    snapshotVersion: typeof input.snapshotVersion === 'number' ? input.snapshotVersion : null,
    fallbackUsed,
    // Only ever this one reason: fallback is prohibited for every other state,
    // so recording a timeout or a technical failure here would describe a
    // fallback that is not allowed to have happened.
    fallbackReason: fallbackUsed ? 'unsupported_version' : null,
  };
}

/** Re-exported so callers never import the id generator from two places. */
export { createEvidenceId };
