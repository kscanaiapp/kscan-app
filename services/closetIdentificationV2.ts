// Closet fashion-identification-v2 adapter (Closet Upgrade Build 1).
//
// THE ONE PLACE a Closet V2 request is built and a Closet V2 response is
// accepted. Closet camera and Closet gallery intake both converge here, and a
// Closet call to `scan-identify` that does not pass through this module is a
// migration bypass that the path-governance test fails on.
//
// GOVERNING ARCHITECTURE: one identification core, multiple consumer intents.
//
//   shared evidence preparation + shared V2 validation
//     ├── services/scannerIdentificationV2.ts          identify_and_shop
//     ├── services/style-chat/eliseIdentificationV2.ts identify_for_style
//     └── THIS MODULE                                  identify_for_closet
//
// Closet is ALWAYS `identify_for_closet`. `buildClosetV2Request` writes the
// constant itself and takes no intent parameter, so there is no argument a caller
// could pass to make Closet shop. `validateClosetV2Request` re-asserts it on the
// finished object, which is what catches a Closet path wired through the Scanner
// or Elise builder by mistake.
//
// THERE IS NO LEGACY FALLBACK, AND THAT IS LOAD-BEARING. Scanner and Elise may
// retry under the legacy contract on HTTP 400 / UNSUPPORTED_CONTRACT_VERSION. A
// legacy request carries no intent, and the backend defaults an intent-less
// request to `identify_and_shop` — which runs commerce, creates purchase options
// and captures Scanner artifacts. For Closet that is not a degraded mode, it is a
// violation of the intake's core guarantee. A backend that cannot serve
// `identify_for_closet` gets a hard, non-retryable rejection instead.
//
// WHAT THIS MODULE DOES NOT DO:
//   - classify, re-classify or reinterpret provider output
//   - compress, resize or re-orient an image (candidate media preparation did)
//   - persist anything
//   - promote, commit, or otherwise touch the authoritative Closet

import {
  FASHION_IDENTIFICATION_CONTRACT_V2,
  type FashionIdentificationEntryPath,
  type FashionIdentificationPlatform,
  type FashionIdentificationRequestV2,
  type FashionIdentificationResultV2,
} from '../types/fashionIdentificationV2';
import type {
  ClosetCandidateErrorCode,
  ClosetCandidateStatus,
} from '../types/closetCandidate';
import {
  createEvidenceId,
  isValidEvidenceId,
  type PreparedFashionEvidenceObject,
} from './fashionEvidenceGateway';
import {
  bucketCount,
  bucketLatency,
  isRecord,
  str,
  validateFashionV2RequestEnvelope,
  validateFashionV2Response,
  type FashionV2ResponseValidation,
} from './fashionIdentificationV2Core';
import { resolveClosetCandidateStagingEnabled } from '../constants/featureFlags';

/** Closet never sends any other intent. */
export const CLOSET_INTENT = 'identify_for_closet' as const;

/**
 * Closet requests are always `detect_items`.
 *
 * WHY: the contract's other backend-active mode, `identify_selected_item`,
 * requires a `selectedCandidate` produced by a prior detection step. Closet
 * intake has no prior step — the user hands us one photo of one garment they
 * already own. `detect_items` is the only mode that can carry that request
 * honestly, it returns the full item-level taxonomy Closet needs, and it hard-
 * skips commerce a SECOND time through the backend's `detection_mode` override,
 * independently of the intent gate.
 */
export const CLOSET_MODE = 'detect_items' as const;

// ── Session-latched rollout flag ─────────────────────────────────────────────

export type ClosetV2SessionFlag = { readonly enabled: boolean };

/**
 * The flag is resolved ONCE when a candidate operation begins and that value is
 * carried through prepare → classify → persist.
 *
 * WHY LATCH: a mid-operation change would let media preparation happen under one
 * regime and the classification request under another, and the persisted
 * candidate could then disagree with the response that produced it.
 */
export function beginClosetV2Session(
  resolver: () => boolean = resolveClosetCandidateStagingEnabled,
): ClosetV2SessionFlag {
  let enabled = false;
  try {
    enabled = resolver() === true;
  } catch {
    // A resolver failure must fail closed. Closet staging off is the safe state.
    enabled = false;
  }
  return Object.freeze({ enabled });
}

// ── Entry paths ──────────────────────────────────────────────────────────────

/**
 * Closet's own entry paths.
 *
 * Distinct from every `scanner_*` and `elise_*` path on purpose: a Closet request
 * describing itself as Scanner would be indistinguishable downstream from a scan
 * that is allowed to shop and allowed to create a Recent Scan.
 */
export const CLOSET_ENTRY_PATHS = {
  camera: 'closet_camera',
  gallery: 'closet_gallery',
} as const;

export type ClosetEntryPathKey = keyof typeof CLOSET_ENTRY_PATHS;

export function closetEntryPathFor(key: ClosetEntryPathKey): FashionIdentificationEntryPath {
  return CLOSET_ENTRY_PATHS[key];
}

/**
 * Resolve a candidate source to its backend-accepted entry-path key, or `null`
 * when the source has none yet.
 *
 * CLOSED MAPPING, NOT A DEFAULT. Before Build 2.5 this fell through to
 * `gallery` for anything that was not `camera`, which was safe only because
 * `camera` and `gallery` were the sole candidate sources that could ever
 * exist. `mirror_extract` (and any future reserved source) breaks that
 * assumption: mislabeling a Mirror crop as `closet_gallery` would misrepresent
 * its provenance to the backend and is exactly the failure Build 2.5's
 * domain-separation requirement forbids. `null` here is a caller signal to
 * fail the candidate closed rather than guess.
 */
export function closetEntryPathKeyForSource(source: unknown): ClosetEntryPathKey | null {
  if (source === 'camera') return 'camera';
  if (source === 'gallery') return 'gallery';
  return null;
}

// ── Mirror Selfie dormant entry path (Build 2.5 Phase 0B addendum, Section F) ─

/**
 * `mirror_extract`'s INTENDED backend entry path, once the backend accepts it.
 *
 * NOT a member of `CLOSET_ENTRY_PATHS` and NOT a `FashionIdentificationEntryPath`.
 * The Phase 0B backend-compatibility gate found `closet_mirror` absent from the
 * parity-gated `FASHION_IDENTIFICATION_ENTRY_PATHS` vocabulary shared by
 * contracts/fashion-identification-v2.schema.json,
 * supabase/functions/_shared/fashionIdentificationV2.ts, and this module's own
 * client mirror import — all three held identical by
 * __tests__/fashionIdentificationContractParity.test.js. Adding `closet_mirror`
 * there requires a coordinated schema/backend/client change outside this
 * phase's scope and outside this phase's authorization to edit backend files.
 *
 * This constant is a plain string: it records the intended mapping so it is
 * directly testable, and because it is NOT typed as a
 * `FashionIdentificationEntryPath`, nothing can accidentally spend it inside
 * `buildClosetV2Request` — that would be a compile error — until the
 * three-way vocabulary is extended together and this dormancy is retired.
 */
export const MIRROR_INTENDED_ENTRY_PATH = 'closet_mirror';

/**
 * `mirror_extract`'s intended entry path, for exactly that source and nothing
 * else. Returns `null` for every other value, including `camera` and
 * `gallery` — those already have real, active entry paths via
 * `closetEntryPathKeyForSource` and must never be answered from here.
 */
export function mirrorIntendedEntryPathFor(
  source: unknown,
): typeof MIRROR_INTENDED_ENTRY_PATH | null {
  return source === 'mirror_extract' ? MIRROR_INTENDED_ENTRY_PATH : null;
}

// ── Request building ─────────────────────────────────────────────────────────

export type ClosetV2RequestInput = {
  evidence: PreparedFashionEvidenceObject;
  entryPath: ClosetEntryPathKey;
  platform: FashionIdentificationPlatform;
  /** Stable per-operation id; becomes the contract requestId. */
  requestId: string;
  appVersion?: string;
};

/**
 * String discriminants, not a boolean `ok`. This project compiles with
 * `strictNullChecks` disabled, under which TypeScript does not narrow a union on
 * a boolean literal discriminant.
 */
export type ClosetV2RequestResult =
  | { kind: 'ok'; request: FashionIdentificationRequestV2 }
  | { kind: 'rejected'; reason: ClosetV2RejectReason };

export type ClosetV2RejectReason =
  | 'invalid_evidence'
  | 'invalid_evidence_id'
  | 'invalid_request_id'
  | 'invalid_entry_path';

export function buildClosetV2Request(input: ClosetV2RequestInput): ClosetV2RequestResult {
  if (!input || !isRecord(input.evidence)) return { kind: 'rejected', reason: 'invalid_evidence' };
  const evidence = input.evidence;
  if (!isValidEvidenceId(evidence.evidenceId)) {
    return { kind: 'rejected', reason: 'invalid_evidence_id' };
  }
  if (!str(evidence.imageBase64)) return { kind: 'rejected', reason: 'invalid_evidence' };
  const requestId = str(input.requestId);
  if (!requestId) return { kind: 'rejected', reason: 'invalid_request_id' };
  // An unknown key would index to `undefined` and produce a request with no
  // entryPath, which the backend rejects as INVALID_SOURCE after paying for the
  // upload.
  if (!Object.prototype.hasOwnProperty.call(CLOSET_ENTRY_PATHS, input.entryPath)) {
    return { kind: 'rejected', reason: 'invalid_entry_path' };
  }

  const request: FashionIdentificationRequestV2 = {
    contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
    requestId,
    // Written as the module constant, never taken from `input`.
    intent: CLOSET_INTENT,
    mode: CLOSET_MODE,
    source: {
      entryPath: closetEntryPathFor(input.entryPath),
      platform: input.platform,
      ...(str(input.appVersion) ? { appVersion: str(input.appVersion) as string } : {}),
    },
    // Exactly one evidence object per HTTP request.
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
    // re-encoding, resizing and EXIF stripping are not privacy filtering and must
    // never be reported as if they were.
    privacy: {
      localFaceMaskApplied: false,
      localPlateMaskApplied: false,
      rawExifTransmitted: false,
    },
  };

  return { kind: 'ok', request };
}

/**
 * Structural pre-flight on the finished request.
 *
 * The intent and entry-path assertions are the load-bearing parts: together they
 * fail a request that was assembled by the Scanner or Elise builder, which is
 * exactly how a Closet intake could otherwise acquire a shopping intent.
 */
export function validateClosetV2Request(request: unknown): boolean {
  if (!isRecord(request)) return false;
  if (request.intent !== CLOSET_INTENT) return false;
  if (request.mode !== CLOSET_MODE) return false;
  const source = isRecord(request.source) ? request.source : null;
  if (!source) return false;
  const allowed = Object.values(CLOSET_ENTRY_PATHS) as string[];
  if (!allowed.includes(String(source.entryPath))) return false;
  return validateFashionV2RequestEnvelope(request);
}

// ── Response validation ──────────────────────────────────────────────────────

export type ClosetV2ResponseValidation = FashionV2ResponseValidation;

/** Delegates to the shared validator so consumers cannot drift apart. */
export function validateClosetV2Response(raw: unknown): ClosetV2ResponseValidation {
  return validateFashionV2Response(raw);
}

// ── Classification normalization ─────────────────────────────────────────────

export type ClosetClassification = {
  category: string | null;
  /**
   * DELIBERATELY NULL from classification.
   *
   * `FashionIdentificationResultV2` has no clothing-type concept distinct from
   * `item.category` — the legacy projection maps `item_type` FROM `item.category`.
   * Writing the same value into two fields would create redundant names for one
   * concept and make it impossible to tell a classified value from a user-entered
   * one. `clothingType` therefore stays a manual-entry field.
   */
  clothingType: null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
  confidence: {
    category: number | null;
    subtype: number | null;
    brand: number | null;
    color: number | null;
    material: number | null;
  };
  classificationVersion: string;
  /** Bounded count of detection candidates, for the manual-selection decision. */
  candidateCount: number;
};

function textOrNull(value: unknown, max = 120): string | null {
  const text = str(value);
  return text ? text.slice(0, max) : null;
}

function textArray(value: unknown, limit = 8): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const text = textOrNull(entry, 60);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * A confidence from the response, or null.
 *
 * OUT OF RANGE IS REJECTED, NOT CLAMPED, for the same reason the store rejects
 * it: clamping a malformed 5 to 1 manufactures maximum certainty out of a broken
 * response, and every consumer downstream would then be reasoning about a number
 * the backend never sent. `0` is preserved — it is an answer, not a gap.
 */
function confidenceOrNull(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

/**
 * Project a validated V2 result onto the candidate's classification fields.
 *
 * PURELY A PROJECTION. Nothing is inferred, defaulted, or filled in from another
 * field: an absent brand stays absent rather than becoming "Unknown", and an
 * absent colour stays absent rather than being read off the material list. A
 * partial result is a legitimate outcome, not something to repair.
 *
 * `color` and `material` have no dedicated confidence in the contract. They are
 * reported as null rather than borrowed from `category` — a borrowed confidence
 * is a fabricated measurement.
 */
export function normalizeClosetClassification(
  result: FashionIdentificationResultV2,
): ClosetClassification {
  const item = isRecord((result as Record<string, unknown>).item)
    ? ((result as Record<string, unknown>).item as Record<string, unknown>)
    : {};
  const brand = isRecord(item.brand) ? (item.brand as Record<string, unknown>) : {};
  const colors = isRecord(item.colors) ? (item.colors as Record<string, unknown>) : {};
  const confidence = isRecord((result as Record<string, unknown>).confidence)
    ? ((result as Record<string, unknown>).confidence as Record<string, unknown>)
    : {};
  const candidates = (result as { candidates?: unknown }).candidates;

  return {
    category: textOrNull(item.category, 80),
    clothingType: null,
    subtype: textOrNull(item.subtype, 80),
    brand: textOrNull(brand.value, 120),
    primaryColor: textOrNull(colors.primary, 60),
    secondaryColors: textArray(colors.secondary),
    material: textArray(item.material),
    confidence: {
      category: confidenceOrNull(confidence.category),
      subtype: confidenceOrNull(confidence.subtype),
      brand: confidenceOrNull(confidence.brand),
      color: null,
      material: null,
    },
    classificationVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
    candidateCount: Array.isArray(candidates) ? candidates.length : 0,
  };
}

/** A candidate may advance to review when the taxonomy is usable. */
export function hasUsableTaxonomy(classification: ClosetClassification | null): boolean {
  if (!classification) return false;
  return !!(classification.category || classification.subtype || classification.clothingType);
}

export type ClosetClassificationOutcome = {
  status: ClosetCandidateStatus;
  errorCode: ClosetCandidateErrorCode | null;
  classification: ClosetClassification | null;
};

/**
 * Decide the candidate's next state from a VALIDATED V2 result.
 *
 * The rule that matters: a valid response that simply lacks usable taxonomy is
 * `needs_manual_classification`, NOT `failed`. Nothing technical went wrong — the
 * user is one category pick away from a complete record, and marking it a failure
 * would hide a recoverable item behind a retry button that cannot help.
 *
 * `non_fashion` and `multiple_items_need_selection` also land in manual
 * classification rather than failure. `non_fashion` may simply be a folded or
 * oddly-lit garment the user can name themselves; `multiple_items_need_selection`
 * means the backend saw several garments and Build 1 has no picker yet — choosing
 * one on the user's behalf would be guessing which item they meant.
 */
export function resolveClassificationOutcome(
  result: FashionIdentificationResultV2,
): ClosetClassificationOutcome {
  const classification = normalizeClosetClassification(result);
  const status = String((result as Record<string, unknown>).status ?? '');

  if (status === 'technical_failure') {
    return { status: 'failed', errorCode: 'classification_provider_failed', classification: null };
  }

  if (status === 'multiple_items_need_selection') {
    return {
      status: 'needs_manual_classification',
      errorCode: 'classification_requires_manual_category',
      classification,
    };
  }

  if (status === 'completed' || status === 'partial') {
    if (hasUsableTaxonomy(classification)) {
      return { status: 'ready_for_review', errorCode: null, classification };
    }
    return {
      status: 'needs_manual_classification',
      errorCode: 'classification_requires_manual_category',
      classification,
    };
  }

  // insufficient_visual_evidence, non_fashion, and any other valid status.
  return {
    status: 'needs_manual_classification',
    errorCode: 'classification_requires_manual_category',
    classification,
  };
}

// ── Transport failure classification ─────────────────────────────────────────

export type ClosetTransportSignal = {
  aborted?: boolean;
  offline?: boolean;
  httpStatus?: number | null;
  contractErrorCode?: string | null;
  /** True when the payload was present but failed V2 structural validation. */
  malformed?: boolean;
};

/**
 * Map a transport-level failure onto exactly one registry code.
 *
 * PURE, and deliberately so: every branch below is directly testable without a
 * network, which is the only way the auth / rate-limit / quota mappings can be
 * proven correct given that the shared `scan-identify` transport does not yet
 * surface those signals distinctly on a successful HTTP call.
 */
export function classifyClosetTransportFailure(
  signal: ClosetTransportSignal,
): ClosetCandidateErrorCode {
  if (signal?.aborted) return 'candidate_request_aborted';
  if (signal?.offline) return 'candidate_offline';

  const code = str(signal?.contractErrorCode);
  const httpStatus =
    typeof signal?.httpStatus === 'number' && Number.isFinite(signal.httpStatus)
      ? signal.httpStatus
      : null;

  // A contract rejection is never retried and never falls back to legacy.
  if (
    code === 'UNSUPPORTED_CONTRACT_VERSION' ||
    code === 'INVALID_INTENT' ||
    code === 'MISSING_INTENT' ||
    code === 'INVALID_MODE' ||
    code === 'INVALID_SOURCE'
  ) {
    return 'classification_contract_rejected';
  }
  if (code === 'PAYLOAD_TOO_LARGE') return 'candidate_media_unsupported';
  if (code === 'INVALID_EVIDENCE' || code === 'INVALID_EVIDENCE_ID') {
    return 'candidate_media_unsupported';
  }

  if (httpStatus === 401 || httpStatus === 403) return 'classification_auth_failed';
  if (httpStatus === 402) return 'classification_quota_exhausted';
  if (httpStatus === 429) return 'classification_rate_limited';
  if (httpStatus === 408 || httpStatus === 504) return 'classification_timeout';

  if (signal?.malformed) return 'classification_malformed_response';
  return 'classification_provider_failed';
}

// ── Telemetry ────────────────────────────────────────────────────────────────

export type ClosetV2Telemetry = {
  closetStagingEnabled: boolean;
  closetV2Attempted: boolean;
  closetV2Accepted: boolean;
  entryPath: FashionIdentificationEntryPath | null;
  platform: FashionIdentificationPlatform | null;
  requestMode: typeof CLOSET_MODE | null;
  resultStatus: string | null;
  resolutionLevel: string | null;
  candidateCountBucket: string | null;
  attemptBucket: string | null;
  latencyBucket: string | null;
  errorCode: ClosetCandidateErrorCode | null;
  /** Always false. Closet has no legacy fallback; see the module header. */
  fallbackUsed: false;
};

/**
 * Bounded, non-identifying Closet telemetry.
 *
 * Deliberately absent, and asserted absent by test: evidenceId, candidateId,
 * candidate metadata, Base64, local URIs, filenames, asset ids, the request body,
 * provider output, user ids, emails and device ids. Every field is an enum, a
 * boolean, a bucket, a bounded code, or null.
 */
export function buildClosetV2Telemetry(input: {
  enabled: boolean;
  attempted: boolean;
  accepted: boolean;
  entryPath: ClosetEntryPathKey | null;
  platform: FashionIdentificationPlatform | null;
  result: FashionIdentificationResultV2 | null;
  candidateCount?: number | null;
  attemptCount?: number | null;
  latencyMs?: number | null;
  errorCode?: ClosetCandidateErrorCode | null;
}): ClosetV2Telemetry {
  return {
    closetStagingEnabled: input.enabled === true,
    closetV2Attempted: input.attempted === true,
    closetV2Accepted: input.accepted === true,
    entryPath: input.entryPath ? closetEntryPathFor(input.entryPath) : null,
    platform: input.platform ?? null,
    requestMode: input.attempted ? CLOSET_MODE : null,
    resultStatus: input.result?.status ?? null,
    resolutionLevel: input.result?.resolutionLevel ?? null,
    candidateCountBucket: bucketCount(input.candidateCount ?? null),
    attemptBucket: bucketCount(input.attemptCount ?? null),
    latencyBucket: bucketLatency(input.latencyMs ?? null),
    errorCode: input.errorCode ?? null,
    fallbackUsed: false,
  };
}

/** Re-exported so callers never import the id generator from two places. */
export { createEvidenceId };
