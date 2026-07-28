// Shared fashion-identification-v2 client core (Phase 2B.3).
//
// WHAT LIVES HERE: the parts of the V2 client contract that are identical for
// every consumer intent — response validation, candidate extraction, the
// unsupported-version fallback predicate, and telemetry bucketing. None of it
// mentions Scanner or Elise, and none of it knows an intent.
//
// WHY EXTRACTED: Phase 2B.3 forbids duplicating V2 validation, unsupported-
// version detection or technical-error normalization. A second validator is the
// dangerous kind of duplication: the two copies drift, and the consumer with the
// laxer copy starts accepting payloads the other rejects while both claim to
// implement one contract. `scannerIdentificationV2.ts` re-exports these, so
// Scanner runs exactly this code.
//
// WHAT DOES NOT LIVE HERE: request building. A request carries an intent, and an
// intent is the one thing consumers must NOT share — Scanner is always
// `identify_and_shop` and Elise is always `identify_for_style`. Each consumer
// builds and validates its own request so a single generic builder can never be
// handed the wrong intent by a caller.

import {
  FASHION_IDENTIFICATION_CONTRACT_V2,
  type FashionIdentificationResultV2,
} from '../types/fashionIdentificationV2';
import { isValidEvidenceId } from './fashionEvidenceGateway';

export type FashionV2Mode = 'detect_items' | 'identify_selected_item';

/**
 * The immutable link between a detection candidate and the selected-item
 * request that follows it.
 *
 * `detectionDigest` is SERVER-GENERATED and optional in the contract. The
 * client stores whatever detection returned and echoes it back verbatim; it
 * never computes, recomputes, or substitutes one.
 */
export type FashionCandidateCorrelation = {
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
 * produced by the server, or computed from the prepared derivative exactly as
 * they are today. Carrying them forward unchanged is what lets a V2
 * selected-item request succeed without any backend change.
 *
 * This is NOT a detection digest and is never written into
 * `selectedCandidate.detectionDigest`. Conflating a session id with a detection
 * digest is explicitly forbidden, and the two fields mean different things.
 */
export type FashionLegacyCorrelation = {
  scanSessionId?: string;
  imageDigestPrefix?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/** Trimmed non-empty string, or null. Never returns `''`. */
export function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

// ── Response validation ──────────────────────────────────────────────────────

export type FashionV2ResponseValidation =
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
 * healthy status code. Nothing renders, persists, enters Recent Scans, reaches
 * StyleChat or completes a candidate before this passes.
 *
 * Returns a bounded failure CATEGORY, never the offending value — this runs on
 * the response path and echoing the value would put provider output into a log.
 */
export function validateFashionV2Response(raw: unknown): FashionV2ResponseValidation {
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
export function extractFashionV2Candidates(
  result: FashionIdentificationResultV2,
  evidenceId: string,
): FashionCandidateCorrelation[] {
  const raw = (result as { candidates?: unknown }).candidates;
  if (!Array.isArray(raw)) return [];
  const out: FashionCandidateCorrelation[] = [];
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

/**
 * Structural checks common to every V2 request, regardless of intent.
 *
 * Intent is deliberately NOT checked here — each consumer asserts its own, so a
 * shared helper can never be the thing that lets a Scanner intent through an
 * Elise validator.
 */
export function validateFashionV2RequestEnvelope(request: unknown): boolean {
  if (!isRecord(request)) return false;
  if (request.contractVersion !== FASHION_IDENTIFICATION_CONTRACT_V2) return false;
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

// ── Legacy fallback policy ───────────────────────────────────────────────────

/**
 * The ONLY condition that may fall back to the legacy contract.
 *
 * A build with a V2 flag on can reach a backend that predates V2 activation.
 * That backend answers HTTP 400 / UNSUPPORTED_CONTRACT_VERSION, which is an
 * unambiguous statement that this contract is not implemented — so retrying the
 * same operation under the legacy contract is correct and lossless.
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

/** Coarse buckets only — an exact count is closer to a fingerprint than a metric. */
export function bucketCount(count: number | null | undefined): string | null {
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) return null;
  if (count === 0) return '0';
  if (count === 1) return '1';
  if (count <= 3) return '2-3';
  if (count <= 5) return '4-5';
  return '6+';
}

/** Latency buckets. Same reasoning as counts: a bucket, never a raw duration. */
export function bucketLatency(ms: number | null | undefined): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return '<1s';
  if (ms < 3000) return '1-3s';
  if (ms < 6000) return '3-6s';
  if (ms < 12000) return '6-12s';
  return '12s+';
}
