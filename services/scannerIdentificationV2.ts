// Scanner fashion-identification-v2 adapter (Phase 2B.2).
//
// THE ONE PLACE a Scanner V2 request is built and a V2 response is accepted.
// Camera, gallery, retry, every image of an Android batch, detection and
// selection all converge here. A Scanner call to `scan-identify` that does not
// pass through this module is a migration bypass, and the path-governance test
// fails on one.
//
// GOVERNING ARCHITECTURE: one identification core, multiple consumer intents.
// Scanner is always `identify_and_shop`. Elise's future migration will be
// `identify_for_style` and will not reuse this module's Scanner-specific
// gating — it will supply its own intent through the shared contract.
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
export type ScannerCandidateCorrelation = {
  evidenceId: string;
  candidateId: string;
  category: string;
  subtype?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  detectionDigest?: string;
};

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
export type ScannerLegacyCorrelation = {
  scanSessionId?: string;
  imageDigestPrefix?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  if (!isRecord(request)) return false;
  if (request.contractVersion !== FASHION_IDENTIFICATION_CONTRACT_V2) return false;
  if (request.intent !== SCANNER_INTENT) return false;
  if (request.mode !== 'detect_items' && request.mode !== 'identify_selected_item') return false;
  if (!str(request.requestId)) return false;
  if (!isRecord(request.source)) return false;
  if (!Array.isArray(request.evidence) || request.evidence.length !== 1) return false;
  const evidence = request.evidence[0];
  if (!isRecord(evidence) || !isValidEvidenceId(evidence.evidenceId)) return false;
  const transport = isRecord(evidence.transport) ? evidence.transport : null;
  if (!transport || transport.type !== 'jpeg_base64' || !str(transport.imageBase64)) return false;
  if (!isRecord(request.privacy)) return false;
  if (request.mode === 'identify_selected_item') {
    const candidate = request.selectedCandidate;
    if (!isRecord(candidate)) return false;
    if (!str(candidate.candidateId) || !str(candidate.category)) return false;
    if (!isValidEvidenceId(candidate.evidenceId)) return false;
    if (candidate.evidenceId !== evidence.evidenceId) return false;
  } else if (request.selectedCandidate !== undefined) {
    // A detection request has not chosen an item yet; carrying a candidate
    // would misrepresent the mode.
    return false;
  }
  return true;
}

// ── Response validation ──────────────────────────────────────────────────────

export type ScannerV2ResponseValidation =
  | { kind: 'ok'; result: FashionIdentificationResultV2 }
  | { kind: 'invalid'; category: string };

const V2_STATUSES = [
  'completed',
  'partial',
  'insufficient_visual_evidence',
  'non_fashion',
  'multiple_items_need_selection',
  'technical_failure',
] as const;

const V2_RESOLUTION_LEVELS = [
  'exact_product',
  'model_family',
  'brand_and_subtype',
  'subtype',
  'category',
  'unknown',
] as const;

const REQUIRED_CONFIDENCE_KEYS = ['category', 'subtype', 'brand', 'modelFamily', 'exactProduct'];

/**
 * Strict structural validation of an incoming V2 result.
 *
 * HTTP 200 is not validation: the transitional response is assembled from a
 * legacy pipeline, and a malformed `identificationV2` arrives with a perfectly
 * healthy status code. Nothing renders, persists, enters Recent Scans or
 * completes a candidate before this passes.
 *
 * Returns a bounded failure CATEGORY, never the offending value — this runs on
 * the response path and echoing the value would put provider output into a log.
 */
export function validateScannerV2Response(raw: unknown): ScannerV2ResponseValidation {
  if (!isRecord(raw)) return { kind: 'invalid', category: 'not_an_object' };
  if (raw.contractVersion !== FASHION_IDENTIFICATION_CONTRACT_V2) {
    return { kind: 'invalid', category: 'contract_version' };
  }
  if (typeof raw.requestId !== 'string') return { kind: 'invalid', category: 'request_id' };
  if (!(V2_STATUSES as readonly string[]).includes(String(raw.status))) {
    return { kind: 'invalid', category: 'status' };
  }
  if (!(V2_RESOLUTION_LEVELS as readonly string[]).includes(String(raw.resolutionLevel))) {
    return { kind: 'invalid', category: 'resolution_level' };
  }

  const item = raw.item;
  if (!isRecord(item)) return { kind: 'invalid', category: 'item' };
  const brand = item.brand;
  if (!isRecord(brand)) return { kind: 'invalid', category: 'brand' };
  if (!Array.isArray(brand.evidence)) return { kind: 'invalid', category: 'brand_evidence' };
  const colors = item.colors;
  if (!isRecord(colors) || !Array.isArray(colors.secondary)) {
    return { kind: 'invalid', category: 'colors' };
  }
  for (const key of ['material', 'silhouette', 'pattern']) {
    if (!Array.isArray(item[key])) return { kind: 'invalid', category: `item_${key}` };
  }
  const attributes = item.attributes;
  if (!isRecord(attributes)) return { kind: 'invalid', category: 'attributes' };
  for (const key of ['pockets', 'visible', 'distinctive']) {
    if (!Array.isArray(attributes[key])) return { kind: 'invalid', category: `attributes_${key}` };
  }

  const confidence = raw.confidence;
  if (!isRecord(confidence)) return { kind: 'invalid', category: 'confidence' };
  for (const key of REQUIRED_CONFIDENCE_KEYS) {
    // The key must EXIST and be null-or-number. A missing key is what
    // `undefined` + JSON.stringify silently produces on the wire, and an
    // absent confidence is not the same claim as a zero one.
    if (!Object.prototype.hasOwnProperty.call(confidence, key)) {
      return { kind: 'invalid', category: `confidence_missing_${key}` };
    }
    const value = confidence[key];
    if (value !== null && typeof value !== 'number') {
      return { kind: 'invalid', category: `confidence_type_${key}` };
    }
  }

  if (raw.exactProduct !== null && !isRecord(raw.exactProduct)) {
    return { kind: 'invalid', category: 'exact_product' };
  }
  if (!Array.isArray(raw.evidence)) return { kind: 'invalid', category: 'evidence' };
  if (!Array.isArray(raw.conflicts)) return { kind: 'invalid', category: 'conflicts' };

  const compatibility = raw.compatibility;
  if (!isRecord(compatibility)) return { kind: 'invalid', category: 'compatibility' };
  if (typeof compatibility.legacyProjectionAvailable !== 'boolean') {
    return { kind: 'invalid', category: 'compatibility_projection' };
  }
  if (
    compatibility.globalConfidence !== null &&
    typeof compatibility.globalConfidence !== 'number'
  ) {
    return { kind: 'invalid', category: 'compatibility_confidence' };
  }

  return { kind: 'ok', result: raw as unknown as FashionIdentificationResultV2 };
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
  const raw = (result as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) return [];
  const out: ScannerCandidateCorrelation[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const candidateId = str(entry.candidateId);
    const category = str(entry.category);
    // Both are required to form a valid selection tuple. Defaulting either one
    // would fabricate part of the tuple.
    if (!candidateId || !category) continue;
    const entryEvidenceId = str(entry.evidenceId);
    if (!entryEvidenceId || entryEvidenceId !== evidenceId) continue;
    if (seen.has(candidateId)) continue;
    seen.add(candidateId);

    const bounds = isRecord(entry.bounds)
      ? [entry.bounds.x, entry.bounds.y, entry.bounds.width, entry.bounds.height]
      : null;
    const boundsValid = bounds !== null && bounds.every((v) => typeof v === 'number' && Number.isFinite(v));

    out.push({
      evidenceId,
      candidateId,
      category,
      ...(str(entry.subtype) ? { subtype: str(entry.subtype) as string } : {}),
      ...(boundsValid
        ? {
          bounds: {
            x: bounds[0] as number,
            y: bounds[1] as number,
            width: bounds[2] as number,
            height: bounds[3] as number,
          },
        }
        : {}),
      // Server-generated and optional. Stored exactly as received.
      ...(str(entry.detectionDigest) ? { detectionDigest: str(entry.detectionDigest) as string } : {}),
    });
  }
  return out;
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
  return input?.httpStatus === 400 && input?.errorCode === 'UNSUPPORTED_CONTRACT_VERSION';
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
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 5) return '4-5';
  return '6+';
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
