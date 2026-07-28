// Elise fashion-identification-v2 adapter (Phase 2B.3).
//
// THE ONE PLACE an Elise V2 request is built. Direct camera, direct gallery and
// the header visual-context gallery all converge here, and an Elise call to
// `scan-identify` that does not pass through this module is a migration bypass
// that the path-governance test fails on.
//
// GOVERNING ARCHITECTURE: one identification core, multiple consumer intents.
//
//   shared evidence preparation + shared V2 validation
//     ├── services/scannerIdentificationV2.ts   intent identify_and_shop
//     └── THIS MODULE                           intent identify_for_style
//
// Elise is ALWAYS `identify_for_style`. That is not a default that a caller may
// override — `buildEliseV2Request` writes the constant itself and takes no
// intent parameter, so there is no argument a caller could pass to make Elise
// shop. `validateEliseV2Request` then re-asserts it on the finished object,
// which is what catches a request that was assembled somewhere it should not
// have been (for example by delegating to the Scanner builder).
//
// WHAT THIS MODULE DOES NOT DO:
//   - classify, re-classify or reinterpret provider output
//   - compress, resize or re-orient an image (each Elise path already did)
//   - import Scanner UI, hooks, commerce or `useKScan`
//   - persist anything

import {
  FASHION_IDENTIFICATION_CONTRACT_V2,
  type FashionIdentificationEntryPath,
  type FashionIdentificationPlatform,
  type FashionIdentificationRequestV2,
  type FashionIdentificationResultV2,
} from '../../types/fashionIdentificationV2';
import {
  createEvidenceId,
  isValidEvidenceId,
  type PreparedFashionEvidenceObject,
} from '../fashionEvidenceGateway';
import {
  bucketCount,
  bucketLatency,
  isRecord,
  str,
  validateFashionV2RequestEnvelope,
  type FashionCandidateCorrelation,
  type FashionV2Mode,
} from '../fashionIdentificationV2Core';
import { resolveEliseIdentificationV2Enabled } from '../../constants/featureFlags';

/** Elise never sends any other intent. */
export const ELISE_INTENT = 'identify_for_style' as const;

export type EliseV2Mode = FashionV2Mode;

// ── Session-latched rollout flag ─────────────────────────────────────────────

/**
 * The flag is resolved ONCE when a visual-attachment operation begins and that
 * value is carried through prepare → detect → identify → review → attach → send.
 *
 * WHY LATCH: a mid-operation change would otherwise let detection run under V2
 * and the follow-up selected-item request run under legacy (or the reverse). The
 * two requests would then be shaped by different contracts while claiming to
 * describe the same garment, and the context attached to the draft could
 * disagree with the response that produced it. A NEW attachment operation
 * resolves the flag again, so a change still takes effect — just never
 * mid-operation.
 */
export type EliseV2SessionFlag = {
  readonly enabled: boolean;
};

export function beginEliseV2Session(
  resolver: () => boolean = resolveEliseIdentificationV2Enabled,
): EliseV2SessionFlag {
  let enabled = false;
  try {
    enabled = resolver() === true;
  } catch {
    // A resolver failure must fail closed onto the current path, never open.
    enabled = false;
  }
  return Object.freeze({ enabled });
}

// ── Entry paths ──────────────────────────────────────────────────────────────

/**
 * Elise's own entry paths in the contract's `source` block.
 *
 * The contract already distinguishes all three, and they are NOT
 * interchangeable: `elise_header_gallery` is a multi-reference intake whose
 * images are aggregated into one outfit-level context, while `elise_gallery` is
 * a single item-level attachment. Collapsing them would erase the distinction
 * the backend needs to interpret the request.
 */
export const ELISE_ENTRY_PATHS = {
  direct_camera: 'elise_camera',
  direct_gallery: 'elise_gallery',
  header_gallery: 'elise_header_gallery',
} as const;

export type EliseEntryPathKey = keyof typeof ELISE_ENTRY_PATHS;

export function eliseEntryPathFor(key: EliseEntryPathKey): FashionIdentificationEntryPath {
  return ELISE_ENTRY_PATHS[key];
}

/** Maps a prepared evidence object's source onto Elise's entry-path key. */
export function eliseEntryPathKeyForSource(
  source: PreparedFashionEvidenceObject['source'],
): EliseEntryPathKey {
  if (source === 'header_gallery') return 'header_gallery';
  if (source === 'gallery') return 'direct_gallery';
  return 'direct_camera';
}

// ── Request building ─────────────────────────────────────────────────────────

export type EliseV2RequestInput = {
  mode: EliseV2Mode;
  evidence: PreparedFashionEvidenceObject;
  entryPath: EliseEntryPathKey;
  platform: FashionIdentificationPlatform;
  /** Stable per-operation id; becomes the contract requestId. */
  requestId: string;
  appVersion?: string;
  /** Required for identify_selected_item, rejected for detect_items. */
  selectedCandidate?: FashionCandidateCorrelation;
};

/**
 * String discriminants, not a boolean `ok`.
 *
 * This project compiles with `strictNullChecks` disabled, and under that setting
 * TypeScript does not narrow a union on a boolean literal discriminant, so every
 * access to the failure payload becomes an error. A string discriminant narrows
 * correctly regardless.
 */
export type EliseV2RequestResult =
  | { kind: 'ok'; request: FashionIdentificationRequestV2 }
  | { kind: 'rejected'; reason: EliseV2RejectReason };

/**
 * Bounded local rejection reasons. These are client-side contract violations
 * caught before any network call — never provider or transport failures.
 */
export type EliseV2RejectReason =
  | 'invalid_evidence'
  | 'invalid_evidence_id'
  | 'invalid_request_id'
  | 'invalid_entry_path'
  | 'missing_selected_candidate'
  | 'invalid_selected_candidate'
  | 'evidence_id_mismatch';

export function buildEliseV2Request(input: EliseV2RequestInput): EliseV2RequestResult {
  if (!input || !isRecord(input.evidence)) return { kind: 'rejected', reason: 'invalid_evidence' };
  const evidence = input.evidence;
  if (!isValidEvidenceId(evidence.evidenceId)) {
    return { kind: 'rejected', reason: 'invalid_evidence_id' };
  }
  if (!str(evidence.imageBase64)) return { kind: 'rejected', reason: 'invalid_evidence' };
  const requestId = str(input.requestId);
  if (!requestId) return { kind: 'rejected', reason: 'invalid_request_id' };
  // An unknown key would otherwise index to `undefined` and produce a request
  // with no entryPath, which the backend rejects as INVALID_SOURCE after paying
  // for the upload.
  if (!Object.prototype.hasOwnProperty.call(ELISE_ENTRY_PATHS, input.entryPath)) {
    return { kind: 'rejected', reason: 'invalid_entry_path' };
  }

  if (input.mode === 'identify_selected_item') {
    const candidate = input.selectedCandidate;
    if (!isRecord(candidate)) return { kind: 'rejected', reason: 'missing_selected_candidate' };
    const candidateId = str(candidate.candidateId);
    const category = str(candidate.category);
    // Category comes FROM detection. A selected-item request that has lost it is
    // rejected locally rather than re-derived, because re-deriving would be the
    // client guessing which garment was picked.
    if (!candidateId || !category) return { kind: 'rejected', reason: 'invalid_selected_candidate' };
    if (!isValidEvidenceId(candidate.evidenceId)) {
      return { kind: 'rejected', reason: 'invalid_selected_candidate' };
    }
    // The selection must belong to the evidence being transported. A mismatch
    // means a candidate from one image is about to be identified against another
    // image's bytes — the exact defect per-image correlation exists to prevent.
    if (candidate.evidenceId !== evidence.evidenceId) {
      return { kind: 'rejected', reason: 'evidence_id_mismatch' };
    }
  }

  const request: FashionIdentificationRequestV2 = {
    contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
    requestId,
    // Written as the module constant, never taken from `input`. There is no
    // parameter here that a caller could set to a shopping intent.
    intent: ELISE_INTENT,
    mode: input.mode,
    source: {
      entryPath: eliseEntryPathFor(input.entryPath),
      platform: input.platform,
      ...(str(input.appVersion) ? { appVersion: str(input.appVersion) as string } : {}),
    },
    // Exactly one evidence object per HTTP request. The backend rejects more than
    // one, and combining images would destroy per-image correlation.
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
    // re-encoding, resizing and EXIF stripping are not privacy filtering and
    // must never be reported as if they were.
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
      // Echoed ONLY when detection actually supplied one. Never fabricated, and
      // never filled in from a session id.
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
 * The intent assertion is the load-bearing part: it fails a request that carries
 * `identify_and_shop`, which is what catches an Elise path that was wired
 * through the Scanner builder by mistake. Everything else is the shared envelope
 * check.
 */
export function validateEliseV2Request(request: unknown): boolean {
  if (!isRecord(request)) return false;
  if (request.intent !== ELISE_INTENT) return false;
  const source = isRecord(request.source) ? request.source : null;
  if (!source) return false;
  // An Elise request must name an Elise entry path. A Scanner entry path here
  // would mean Elise is describing itself to the backend as Scanner.
  const allowed = Object.values(ELISE_ENTRY_PATHS) as string[];
  if (!allowed.includes(String(source.entryPath))) return false;
  return validateFashionV2RequestEnvelope(request);
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export type EliseV2Telemetry = {
  eliseV2Enabled: boolean;
  eliseV2Attempted: boolean;
  eliseV2Accepted: boolean;
  sourcePath: FashionIdentificationEntryPath | null;
  platform: FashionIdentificationPlatform | null;
  requestMode: EliseV2Mode | null;
  sourceImageCountBucket: string | null;
  identifiedItemCountBucket: string | null;
  partialItemCountBucket: string | null;
  resultStatus: string | null;
  resolutionLevel: string | null;
  contextVersion: string | null;
  latencyBucket: string | null;
  attachmentOutcome: string | null;
  fallbackUsed: boolean;
  fallbackReason: 'unsupported_version' | null;
};

/**
 * Bounded, non-identifying Elise telemetry.
 *
 * Deliberately absent, and asserted absent by test: evidenceId, candidateId,
 * detectionDigest, bounds, Base64, local URIs, filenames, asset ids, the request
 * body, the fashion-context contents, provider output, purchase URLs, user ids,
 * emails, device ids and GPS. Every field below is an enum, a boolean, a bucket
 * or null.
 */
export function buildEliseV2Telemetry(input: {
  enabled: boolean;
  attempted: boolean;
  accepted: boolean;
  entryPath: EliseEntryPathKey | null;
  platform: FashionIdentificationPlatform | null;
  mode: EliseV2Mode | null;
  sourceImageCount?: number | null;
  identifiedItemCount?: number | null;
  partialItemCount?: number | null;
  result: FashionIdentificationResultV2 | null;
  contextVersion?: string | null;
  latencyMs?: number | null;
  attachmentOutcome?: string | null;
  fallbackUsed?: boolean;
}): EliseV2Telemetry {
  const fallbackUsed = input.fallbackUsed === true;
  return {
    eliseV2Enabled: input.enabled === true,
    eliseV2Attempted: input.attempted === true,
    eliseV2Accepted: input.accepted === true,
    sourcePath: input.entryPath ? eliseEntryPathFor(input.entryPath) : null,
    platform: input.platform ?? null,
    requestMode: input.mode ?? null,
    sourceImageCountBucket: bucketCount(input.sourceImageCount ?? null),
    identifiedItemCountBucket: bucketCount(input.identifiedItemCount ?? null),
    partialItemCountBucket: bucketCount(input.partialItemCount ?? null),
    resultStatus: input.result?.status ?? null,
    resolutionLevel: input.result?.resolutionLevel ?? null,
    contextVersion: str(input.contextVersion),
    latencyBucket: bucketLatency(input.latencyMs ?? null),
    attachmentOutcome: str(input.attachmentOutcome),
    fallbackUsed,
    // Only ever this one reason: fallback is prohibited for every other state,
    // so recording a timeout or a technical failure here would describe a
    // fallback that is not allowed to have happened.
    fallbackReason: fallbackUsed ? 'unsupported_version' : null,
  };
}

/** Re-exported so callers never import the id generator from two places. */
export { createEvidenceId };
