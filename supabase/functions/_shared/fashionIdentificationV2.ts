// Canonical fashion identification contract v2 — backend (Deno) mirror.
//
// SOURCE OF TRUTH: contracts/fashion-identification-v2.schema.json.
// The client mirror lives at types/fashionIdentificationV2.ts. All three are
// held together by __tests__/fashionIdentificationContractParity.test.js, which
// compares the vocabularies exported below against the schema enums. Editing a
// vocabulary in one place and not the others fails that test.
//
// WHY A CONTRACT MODULE RATHER THAN INLINE PARSING: before Phase 2B, Scanner and
// Elise each interpreted the raw provider payload with their own field picking.
// That is what let one path keep `subtype` while another dropped it, and what
// let a legacy projection disagree with what was actually identified. There is
// now exactly one normalization (`normalizeToV2`) and exactly one legacy
// projection (`projectV2ToLegacy`) derived from it.
//
// DELIBERATELY NOT HERE:
//   - prompt text, taxonomy vocabulary, confidence thresholds (Phase 2C)
//   - commerce ranking or retailer logic (stays in scanCommerceRouter)
//   - multi-angle fusion (Phase 2D)

// ── Vocabularies (mirrored against the JSON schema) ──────────────────────────

export const FASHION_IDENTIFICATION_CONTRACT_V2 = 'fashion-identification-v2' as const;

export const FASHION_IDENTIFICATION_INTENTS = [
  'identify_and_shop',
  'identify_for_style',
  // Closet Upgrade Build 1. Classification-only staging intake.
  //
  // WHY A THIRD INTENT RATHER THAN REUSING identify_for_style: both skip
  // commerce, but they are not the same request. A style request produces a
  // transient styling context; a Closet request produces metadata persisted onto
  // a durable candidate the user will review and promote. Collapsing them would
  // make it impossible to gate or meter either independently, and a Closet
  // response arriving on a styling path would be undetectable.
  'identify_for_closet',
] as const;

export const FASHION_IDENTIFICATION_MODES = [
  'detect_items',
  'identify_selected_item',
  'identify_item_collection',
] as const;

export const FASHION_IDENTIFICATION_ENTRY_PATHS = [
  'scanner_camera',
  'scanner_gallery',
  'elise_camera',
  'elise_gallery',
  'elise_header_gallery',
  'scanner_handoff',
  'closet_camera',
  'closet_gallery',
  'closet_mirror',
] as const;

export const FASHION_IDENTIFICATION_PLATFORMS = [
  'android',
  'ios',
  'glasses',
  'other',
] as const;

export const FASHION_IDENTIFICATION_ANGLE_HINTS = [
  'front',
  'back',
  'side',
  'detail',
  'logo',
  'label',
  'unknown',
] as const;

export const FASHION_IDENTIFICATION_STATUSES = [
  'completed',
  'partial',
  'insufficient_visual_evidence',
  'non_fashion',
  'multiple_items_need_selection',
  'technical_failure',
] as const;

export const FASHION_IDENTIFICATION_RESOLUTION_LEVELS = [
  'exact_product',
  'model_family',
  'brand_and_subtype',
  'subtype',
  'category',
  'unknown',
] as const;

export const FASHION_IDENTIFICATION_BRAND_PROVENANCES = [
  'visual',
  'visible_text',
  'logo_shape',
  'catalog_corroboration',
  'commerce_corroboration',
  'unknown',
] as const;

export type FashionIdentificationIntent = typeof FASHION_IDENTIFICATION_INTENTS[number];
export type FashionIdentificationMode = typeof FASHION_IDENTIFICATION_MODES[number];
export type FashionIdentificationEntryPath = typeof FASHION_IDENTIFICATION_ENTRY_PATHS[number];
export type FashionIdentificationPlatform = typeof FASHION_IDENTIFICATION_PLATFORMS[number];
export type FashionIdentificationAngleHint = typeof FASHION_IDENTIFICATION_ANGLE_HINTS[number];
export type FashionIdentificationStatus = typeof FASHION_IDENTIFICATION_STATUSES[number];
export type FashionIdentificationResolutionLevel =
  typeof FASHION_IDENTIFICATION_RESOLUTION_LEVELS[number];
export type FashionIdentificationBrandProvenance =
  typeof FASHION_IDENTIFICATION_BRAND_PROVENANCES[number];

// ── Request types ────────────────────────────────────────────────────────────

export type FashionImageMetadataV1 = {
  schemaVersion: 'image-metadata-v1';
  width?: number;
  height?: number;
  mimeType?: 'image/jpeg';
  fileSizeBucket?: string;
  contentHash?: string;
};

export type FashionEvidenceTransport =
  | { type: 'jpeg_base64'; imageBase64: string }
  | { type: 'authorized_image_reference'; referenceId: string };

export type FashionImageEvidenceV2 = {
  evidenceId: string;
  sequenceIndex: number;
  angleHint?: FashionIdentificationAngleHint;
  transport: FashionEvidenceTransport;
  metadata: FashionImageMetadataV1;
};

export type FashionIdentificationPrivacyV2 = {
  localFaceMaskApplied: false;
  localPlateMaskApplied: false;
  rawExifTransmitted: false;
};

export type FashionSelectedCandidateV2 = {
  candidateId: string;
  evidenceId: string;
  /**
   * Preliminary category from the detection step. Required because the existing
   * selected-item pipeline needs it and the detection response already supplies
   * it — carrying it through is lossless, whereas re-deriving or defaulting it
   * would be guessing at which garment the user picked.
   */
  category: string;
  subtype?: string;
  bounds?: { x: number; y: number; width: number; height: number };
  detectionDigest?: string;
};

export type FashionIdentificationRequestV2 = {
  contractVersion: typeof FASHION_IDENTIFICATION_CONTRACT_V2;
  requestId: string;
  intent: FashionIdentificationIntent;
  mode: FashionIdentificationMode;
  source: {
    entryPath: FashionIdentificationEntryPath;
    platform: FashionIdentificationPlatform;
    appVersion?: string;
  };
  evidence: FashionImageEvidenceV2[];
  privacy: FashionIdentificationPrivacyV2;
  selectedCandidate?: FashionSelectedCandidateV2;
};

// ── Result types ─────────────────────────────────────────────────────────────

export type FashionBrandEvidenceV2 = {
  evidenceId?: string;
  type: string;
  observation?: string | null;
  confidence?: number | null;
};

export type FashionIdentificationResultV2 = {
  contractVersion: typeof FASHION_IDENTIFICATION_CONTRACT_V2;
  requestId: string;
  status: FashionIdentificationStatus;
  resolutionLevel: FashionIdentificationResolutionLevel;
  item: {
    category: string | null;
    /**
     * The middle taxonomy tier: the recognizable garment or footwear FAMILY
     * (`jeans`, `blazer`, `boot`), between the broad `category` (`pants`,
     * `footwear`) and the specific `subtype` (`wide_leg_jeans`,
     * `chelsea_boot`).
     *
     * A normalized descriptive string, not a controlled enum. The repository
     * has no canonical middle-tier vocabulary — `normalizeCategory` returns
     * level-1 values only, and the evaluation ontology is explicitly
     * evaluation-only and derived from a 33-case pilot. An enum built from
     * that would reject valid garment families outside the pilot, so this
     * follows the same free-string convention `subtype` already uses.
     */
    clothingType: string | null;
    subtype: string | null;
    brand: {
      value: string | null;
      confidence: number | null;
      provenance: FashionIdentificationBrandProvenance;
      evidence: FashionBrandEvidenceV2[];
    };
    colors: { primary: string | null; secondary: string[] };
    material: string[];
    silhouette: string[];
    pattern: string[];
    attributes: {
      fit?: string | null;
      length?: string | null;
      sleeve?: string | null;
      neckline?: string | null;
      collar?: string | null;
      closure?: string | null;
      pockets: string[];
      visible: string[];
      distinctive: string[];
    };
  };
  confidence: {
    category: number | null;
    subtype: number | null;
    brand: number | null;
    modelFamily: number | null;
    exactProduct: number | null;
  };
  exactProduct: {
    brand: string | null;
    model: string | null;
    sku: string | null;
    confidence: number | null;
  } | null;
  evidence: Array<{ evidenceId: string; observations: string[] }>;
  candidates?: Array<{
    candidateId: string;
    evidenceId: string;
    category: string | null;
    clothingType?: string | null;
    subtype: string | null;
    bounds?: { x: number; y: number; width: number; height: number };
    detectionDigest?: string | null;
  }>;
  conflicts: Array<{ field: string; description: string; evidenceIds: string[] }>;
  unknownReason?: string | null;
  compatibility: {
    legacyProjectionAvailable: boolean;
    globalConfidence: number | null;
    commerceSkippedReason?: string | null;
  };
};

// ── Small helpers (shared by validation and normalization) ───────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num01(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.max(0, Math.min(1, value));
}

/** Deduplicated, trimmed, non-empty strings, order preserved. */
function list(...values: unknown[]): string[] {
  const seen = new Set<string>();
  const walk = (value: unknown) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const text = str(value);
    if (text) seen.add(text);
  };
  for (const value of values) walk(value);
  return [...seen];
}

function inEnum<T extends readonly string[]>(vocab: T, value: unknown): value is T[number] {
  return typeof value === 'string' && (vocab as readonly string[]).includes(value);
}

/**
 * The only accepted evidence-id shape. Client-supplied and echoed verbatim, so
 * it must be incapable of carrying a filesystem path, a URI, a device asset
 * identifier, a filename, or anything user-identifying.
 */
export const EVIDENCE_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

// ── Contract-version dispatch ────────────────────────────────────────────────

export type ContractVersionClass = 'v2' | 'legacy' | 'unsupported';

/**
 * Explicit three-way dispatch. An unknown version is never silently interpreted
 * as V1 or V2 — guessing is exactly how a future client would get a response
 * shaped for a contract it did not ask for.
 */
export function classifyContractVersion(body: unknown): ContractVersionClass {
  if (!isRecord(body)) return 'legacy';
  const raw = body.contractVersion;
  if (raw === undefined || raw === null) return 'legacy';
  if (raw === FASHION_IDENTIFICATION_CONTRACT_V2) return 'v2';
  return 'unsupported';
}

/**
 * Legacy requests carry no intent. Defaulting them to identify_and_shop
 * preserves today's Scanner behavior during rollout; the explicit-V2 path never
 * receives this default, so a V2 request that omits intent is a hard validation
 * failure rather than a silent shop.
 */
export const LEGACY_DEFAULT_INTENT: FashionIdentificationIntent = 'identify_and_shop';

export type ValidationFailure = {
  ok: false;
  /** Stable machine code. Distinct from any low-confidence visual outcome. */
  errorCode:
    | 'unsupported_contract_version'
    | 'malformed_request'
    | 'missing_intent'
    | 'invalid_intent'
    | 'invalid_mode'
    | 'invalid_source'
    | 'invalid_privacy'
    | 'invalid_evidence'
    | 'invalid_evidence_id'
    | 'too_many_evidence_entries'
    | 'duplicate_evidence_id'
    | 'invalid_transport'
    | 'invalid_selected_candidate';
  message: string;
};

export type ValidationSuccess = { ok: true; request: FashionIdentificationRequestV2 };
export type ValidationResult = ValidationSuccess | ValidationFailure;

function fail(errorCode: ValidationFailure['errorCode'], message: string): ValidationFailure {
  return { ok: false, errorCode, message };
}

/**
 * Validates an untrusted V2 request body.
 *
 * Unknown-field policy (documented, per contract rule): unknown top-level and
 * nested fields are IGNORED, not rejected, so a newer client may add a field
 * without breaking an older backend. What is strictly rejected is a field that
 * is present but structurally wrong, because that indicates a real contract
 * mismatch rather than forward compatibility.
 *
 * A malformed V2 request always fails with a machine code here and never
 * reaches classification, so it can never be confused with a low-confidence
 * visual result.
 */
export function validateFashionIdentificationRequestV2(body: unknown): ValidationResult {
  if (!isRecord(body)) return fail('malformed_request', 'Request body must be an object.');

  if (body.contractVersion !== FASHION_IDENTIFICATION_CONTRACT_V2) {
    return fail(
      'unsupported_contract_version',
      'Unsupported contract version. Expected fashion-identification-v2.',
    );
  }

  const requestId = str(body.requestId);
  if (!requestId || requestId.length > 80) {
    return fail('malformed_request', 'requestId is required.');
  }

  if (body.intent === undefined || body.intent === null) {
    return fail('missing_intent', 'intent is mandatory on a v2 request.');
  }
  if (!inEnum(FASHION_IDENTIFICATION_INTENTS, body.intent)) {
    return fail('invalid_intent', 'intent must be identify_and_shop or identify_for_style.');
  }
  if (!inEnum(FASHION_IDENTIFICATION_MODES, body.mode)) {
    return fail('invalid_mode', 'mode is mandatory and must be a known v2 mode.');
  }

  const source = body.source;
  if (
    !isRecord(source) ||
    !inEnum(FASHION_IDENTIFICATION_ENTRY_PATHS, source.entryPath) ||
    !inEnum(FASHION_IDENTIFICATION_PLATFORMS, source.platform)
  ) {
    return fail(
      'invalid_source',
      'source.entryPath and source.platform are mandatory and must not be generic.',
    );
  }

  // Truthful attestation only. Phase 2B has no local masking, so a client
  // claiming it did any is rejected rather than trusted.
  const privacy = body.privacy;
  if (
    !isRecord(privacy) ||
    privacy.localFaceMaskApplied !== false ||
    privacy.localPlateMaskApplied !== false ||
    privacy.rawExifTransmitted !== false
  ) {
    return fail(
      'invalid_privacy',
      'privacy attestation must be present and all three flags must be false.',
    );
  }

  const evidence = body.evidence;
  if (!Array.isArray(evidence) || evidence.length === 0) {
    return fail('invalid_evidence', 'evidence must be a non-empty array.');
  }
  // Phase 2B transport boundary: one transport-bearing evidence per HTTP call.
  // Rejected explicitly — silently using evidence[0] would drop a caller's
  // images without telling them.
  if (evidence.length > 1) {
    return fail(
      'too_many_evidence_entries',
      'This backend accepts exactly one evidence entry per request. Send each image as its own request.',
    );
  }

  const seenEvidenceIds = new Set<string>();
  const normalizedEvidence: FashionImageEvidenceV2[] = [];
  for (const entry of evidence) {
    if (!isRecord(entry)) return fail('invalid_evidence', 'Each evidence entry must be an object.');
    const evidenceId = str(entry.evidenceId);
    if (!evidenceId) {
      return fail('invalid_evidence_id', 'evidenceId is required on every evidence entry.');
    }
    // A single strict format instead of a blocklist. A blocklist has to
    // anticipate every shape of leak — `file://`, `content://`, `ph://`, a
    // Windows path, a bare filename with an extension, an email-like id, a
    // query string. An allowlist of [A-Za-z0-9-] excludes all of them by
    // construction, and the 8-char floor keeps a client from using a counter
    // that would collide across sessions.
    if (!EVIDENCE_ID_PATTERN.test(evidenceId)) {
      return fail(
        'invalid_evidence_id',
        'evidenceId must match ^[A-Za-z0-9-]{8,64}$ and must never be a path, URI, filename, or user identifier.',
      );
    }
    if (seenEvidenceIds.has(evidenceId)) {
      return fail('duplicate_evidence_id', 'Duplicate evidenceId within one request.');
    }
    seenEvidenceIds.add(evidenceId);

    const sequenceIndex = entry.sequenceIndex;
    if (typeof sequenceIndex !== 'number' || !Number.isInteger(sequenceIndex) || sequenceIndex < 0) {
      return fail('invalid_evidence', 'sequenceIndex must be a non-negative integer.');
    }

    const transport = entry.transport;
    if (!isRecord(transport)) return fail('invalid_transport', 'transport is required.');
    let normalizedTransport: FashionEvidenceTransport;
    if (transport.type === 'jpeg_base64') {
      const imageBase64 = str(transport.imageBase64);
      if (!imageBase64) return fail('invalid_transport', 'jpeg_base64 transport requires imageBase64.');
      if (transport.referenceId !== undefined) {
        return fail('invalid_transport', 'Exactly one transport may be used per evidence entry.');
      }
      normalizedTransport = { type: 'jpeg_base64', imageBase64 };
    } else if (transport.type === 'authorized_image_reference') {
      // Declared by the contract but not yet adapted by any deployment: the
      // request adapter maps only jpeg_base64 onto the internal request, so
      // accepting this here would validate a request that then dies later as a
      // generic "no image provided" failure. A bounded rejection at the
      // contract boundary is the honest answer until the capability is served.
      return fail(
        'invalid_transport',
        'authorized_image_reference transport is not yet served by this deployment.',
      );
    } else {
      return fail('invalid_transport', 'Unknown transport type.');
    }

    const metadata = entry.metadata;
    if (!isRecord(metadata) || metadata.schemaVersion !== 'image-metadata-v1') {
      return fail('invalid_evidence', 'metadata.schemaVersion must be image-metadata-v1.');
    }
    // Governed metadata only: an open-ended EXIF blob is never carried through.
    const normalizedMetadata: FashionImageMetadataV1 = { schemaVersion: 'image-metadata-v1' };
    if (typeof metadata.width === 'number' && Number.isFinite(metadata.width)) {
      normalizedMetadata.width = Math.trunc(metadata.width);
    }
    if (typeof metadata.height === 'number' && Number.isFinite(metadata.height)) {
      normalizedMetadata.height = Math.trunc(metadata.height);
    }
    if (metadata.mimeType === 'image/jpeg') normalizedMetadata.mimeType = 'image/jpeg';
    const fileSizeBucket = str(metadata.fileSizeBucket);
    if (fileSizeBucket) normalizedMetadata.fileSizeBucket = fileSizeBucket;
    const contentHash = str(metadata.contentHash);
    if (contentHash) normalizedMetadata.contentHash = contentHash;

    const angleHint = inEnum(FASHION_IDENTIFICATION_ANGLE_HINTS, entry.angleHint)
      ? entry.angleHint
      : undefined;

    normalizedEvidence.push({
      evidenceId,
      sequenceIndex,
      ...(angleHint ? { angleHint } : {}),
      transport: normalizedTransport,
      metadata: normalizedMetadata,
    });
  }

  // Evidence order is part of the contract, not an accident of iteration.
  normalizedEvidence.sort((a, b) => a.sequenceIndex - b.sequenceIndex);

  let selectedCandidate: FashionSelectedCandidateV2 | undefined;
  if (body.selectedCandidate !== undefined && body.selectedCandidate !== null) {
    const raw = body.selectedCandidate;
    if (!isRecord(raw)) return fail('invalid_selected_candidate', 'selectedCandidate must be an object.');
    const candidateId = str(raw.candidateId);
    const evidenceId = str(raw.evidenceId);
    const candidateCategory = str(raw.category);
    if (!candidateId || !evidenceId || !candidateCategory) {
      return fail(
        'invalid_selected_candidate',
        'selectedCandidate requires candidateId, evidenceId and category.',
      );
    }
    // Selection must correlate to evidence actually present in this request.
    if (!seenEvidenceIds.has(evidenceId)) {
      return fail(
        'invalid_selected_candidate',
        'selectedCandidate.evidenceId does not match any evidence in this request.',
      );
    }
    selectedCandidate = { candidateId, evidenceId, category: candidateCategory };
    const candidateSubtype = str(raw.subtype);
    if (candidateSubtype) selectedCandidate.subtype = candidateSubtype;
    if (isRecord(raw.bounds)) {
      const b = raw.bounds;
      const values = [b.x, b.y, b.width, b.height].map((v) => (typeof v === 'number' ? v : NaN));
      if (values.every((v) => Number.isFinite(v))) {
        selectedCandidate.bounds = {
          x: values[0],
          y: values[1],
          width: values[2],
          height: values[3],
        };
      }
    }
    const detectionDigest = str(raw.detectionDigest);
    if (detectionDigest) selectedCandidate.detectionDigest = detectionDigest;
  }

  if (body.mode === 'identify_selected_item' && !selectedCandidate) {
    return fail(
      'invalid_selected_candidate',
      'mode identify_selected_item requires a selectedCandidate.',
    );
  }

  const appVersion = str(source.appVersion);

  return {
    ok: true,
    request: {
      contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
      requestId,
      intent: body.intent,
      mode: body.mode,
      source: {
        entryPath: source.entryPath,
        platform: source.platform,
        ...(appVersion ? { appVersion } : {}),
      },
      evidence: normalizedEvidence,
      privacy: {
        localFaceMaskApplied: false,
        localPlateMaskApplied: false,
        rawExifTransmitted: false,
      },
      ...(selectedCandidate ? { selectedCandidate } : {}),
    },
  };
}

// ── Canonical normalization ──────────────────────────────────────────────────

/**
 * The provider-shaped inputs this backend already sanitizes today
 * (`sanitizeIdentification` / `sanitizeAttributes` in scan-identify/index.ts).
 * Normalization consumes those rather than the raw model payload so there is
 * still exactly one place that decides what a provider field means.
 */
export type ProviderNormalizationInput = {
  requestId: string;
  identification?: Record<string, unknown> | undefined;
  attributes?: Record<string, unknown> | undefined;
  /** Outcome decided by the caller from the provider/transport layer. */
  outcome:
    | 'classified'
    | 'non_fashion'
    | 'insufficient_visual_evidence'
    | 'multiple_items_need_selection'
    | 'technical_failure';
  evidenceIds: string[];
  unknownReason?: string | null;
  candidates?: Array<{
    candidateId: string;
    evidenceId: string;
    category: string | null;
    clothingType?: string | null;
    subtype: string | null;
    bounds?: { x: number; y: number; width: number; height: number };
    detectionDigest?: string | null;
  }>;
  commerceSkippedReason?: string | null;
};

/**
 * Derives the resolution level from what was actually identified.
 *
 * Deliberately conservative: exact_product and model_family are never claimed
 * from the current provider contract, which supplies neither an SKU nor a model
 * family. Claiming them would be inventing precision.
 */
export function deriveResolutionLevel(item: {
  category: string | null;
  subtype: string | null;
  brandValue: string | null;
  exactProduct: { model: string | null; sku: string | null } | null;
}): FashionIdentificationResolutionLevel {
  if (item.exactProduct && (item.exactProduct.sku || item.exactProduct.model)) {
    return item.exactProduct.sku ? 'exact_product' : 'model_family';
  }
  if (item.brandValue && item.subtype) return 'brand_and_subtype';
  if (item.subtype) return 'subtype';
  if (item.category) return 'category';
  return 'unknown';
}

/**
 * Decides completed vs partial for a classified result.
 *
 * A result must NOT fail closed because exact product, SKU, brand, commerce, or
 * an optional attribute is missing. Category + subtype is a complete useful
 * identification; category alone is a useful partial one.
 */
function deriveClassifiedStatus(
  category: string | null,
  subtype: string | null,
): FashionIdentificationStatus {
  if (category && subtype) return 'completed';
  if (category) return 'partial';
  return 'insufficient_visual_evidence';
}

/**
 * Brand provenance, decided from evidence rather than assumed.
 *
 * Commerce corroboration is never asserted here: commerce runs downstream of
 * identification and must not feed back into visual identity.
 */
function deriveBrandProvenance(
  visibleBrandText: string | null,
  logoDetected: boolean,
  brandGuess: string | null,
): FashionIdentificationBrandProvenance {
  if (visibleBrandText) return 'visible_text';
  if (logoDetected) return 'logo_shape';
  if (brandGuess) return 'visual';
  return 'unknown';
}

/**
 * The single normalization path. Every consumer — Scanner, Elise, persistence,
 * and the legacy projection — derives from this result and nothing else.
 */
export function normalizeToV2(input: ProviderNormalizationInput): FashionIdentificationResultV2 {
  const id = isRecord(input.identification) ? input.identification : {};
  const attrs = isRecord(input.attributes) ? input.attributes : {};

  const globalConfidence = num01(id.confidence_score) ?? num01(attrs.confidenceScore);

  const visibleBrandText = str(id.visible_brand_text);
  const logoDetected = id.logo_detected === true;
  const brandGuess = str(id.brand_guess);
  const brandValue = brandGuess ?? visibleBrandText;

  const brandEvidence: FashionBrandEvidenceV2[] = [];
  const primaryEvidenceId = input.evidenceIds[0];
  if (visibleBrandText) {
    brandEvidence.push({
      ...(primaryEvidenceId ? { evidenceId: primaryEvidenceId } : {}),
      type: 'visible_brand_text',
      observation: visibleBrandText,
      confidence: null,
    });
  }
  if (logoDetected) {
    brandEvidence.push({
      ...(primaryEvidenceId ? { evidenceId: primaryEvidenceId } : {}),
      type: 'logo_detected',
      observation: null,
      confidence: null,
    });
  }
  if (brandGuess) {
    brandEvidence.push({
      ...(primaryEvidenceId ? { evidenceId: primaryEvidenceId } : {}),
      type: 'brand_guess',
      observation: brandGuess,
      confidence: null,
    });
  }

  const category = str(id.item_type) ?? str(attrs.category);
  // Read from the provider's own field ONLY. There is deliberately no fallback
  // to category or subtype: synthesising the middle tier from a neighbouring
  // one would score a single model assertion in two taxonomy denominators and
  // report a capability the scanner does not have.
  const clothingType = str(id.clothing_type);
  const subtype = str(id.subtype);

  const primaryColor = str(id.primary_color) ??
    (Array.isArray(attrs.colorPalette) ? str(attrs.colorPalette[0]) : null);
  const secondaryColors = list(
    id.secondary_colors,
    Array.isArray(attrs.colorPalette) ? attrs.colorPalette.slice(1) : [],
  ).filter((color) => color !== primaryColor);

  let status: FashionIdentificationStatus;
  switch (input.outcome) {
    case 'non_fashion':
      status = 'non_fashion';
      break;
    case 'technical_failure':
      status = 'technical_failure';
      break;
    case 'insufficient_visual_evidence':
      status = 'insufficient_visual_evidence';
      break;
    case 'multiple_items_need_selection':
      status = 'multiple_items_need_selection';
      break;
    default:
      status = deriveClassifiedStatus(category, subtype);
  }

  // A non-classified outcome must never present a partially-populated identity
  // that a downstream adapter could mistake for a real item.
  const isIdentityBearing = status === 'completed' ||
    status === 'partial' ||
    status === 'multiple_items_need_selection';

  const resolutionLevel = isIdentityBearing
    ? deriveResolutionLevel({
      category,
      subtype,
      brandValue,
      exactProduct: null,
    })
    : 'unknown';

  const observations = list(id.visual_observation);

  return {
    contractVersion: FASHION_IDENTIFICATION_CONTRACT_V2,
    requestId: input.requestId,
    status,
    resolutionLevel,
    item: {
      category: isIdentityBearing ? category : null,
      clothingType: isIdentityBearing ? clothingType : null,
      subtype: isIdentityBearing ? subtype : null,
      brand: {
        value: isIdentityBearing ? brandValue : null,
        // One broad provider score is not a brand-specific score. It is only
        // surfaced as brand confidence when brand evidence actually exists,
        // and stays null otherwise rather than being invented.
        confidence: isIdentityBearing && brandValue ? globalConfidence : null,
        provenance: isIdentityBearing
          ? deriveBrandProvenance(visibleBrandText, logoDetected, brandGuess)
          : 'unknown',
        evidence: isIdentityBearing ? brandEvidence : [],
      },
      colors: {
        primary: isIdentityBearing ? primaryColor : null,
        secondary: isIdentityBearing ? secondaryColors : [],
      },
      material: isIdentityBearing ? list(id.material_estimate, attrs.materialEstimate) : [],
      silhouette: isIdentityBearing ? list(id.silhouette, attrs.silhouette) : [],
      pattern: isIdentityBearing ? list(id.pattern, attrs.pattern) : [],
      attributes: {
        fit: isIdentityBearing ? str(id.fit) : null,
        length: isIdentityBearing ? str(id.length) : null,
        sleeve: isIdentityBearing ? str(id.sleeve_length) : null,
        neckline: isIdentityBearing ? str(id.neckline_or_lapel) : null,
        collar: isIdentityBearing ? str(id.collar) : null,
        closure: isIdentityBearing ? str(id.closure) : null,
        pockets: isIdentityBearing ? list(id.pockets) : [],
        visible: isIdentityBearing
          ? list(id.style_tags, attrs.styleTags, id.occasion_tags, attrs.occasion)
          : [],
        distinctive: isIdentityBearing ? list(id.distinctive_features) : [],
      },
    },
    // The provider supplies ONE broad score. Only the dimensions it can honestly
    // support are populated; the rest stay null until Phase 2C introduces real
    // independent scoring. This is the whole reason `globalConfidence` is kept
    // separately in `compatibility`.
    confidence: {
      category: isIdentityBearing && category ? globalConfidence : null,
      subtype: null,
      brand: isIdentityBearing && brandValue ? globalConfidence : null,
      modelFamily: null,
      exactProduct: null,
    },
    exactProduct: null,
    evidence: input.evidenceIds.map((evidenceId, index) => ({
      evidenceId,
      observations: index === 0 ? observations : [],
    })),
    ...(input.candidates && input.candidates.length ? { candidates: input.candidates } : {}),
    conflicts: [],
    unknownReason: str(input.unknownReason) ??
      (isIdentityBearing ? null : str(id.scan_quality_note)),
    compatibility: {
      legacyProjectionAvailable: true,
      globalConfidence,
      commerceSkippedReason: input.commerceSkippedReason ?? null,
    },
  };
}

// ── Legacy compatibility projection ──────────────────────────────────────────

export type LegacyIdentificationProjection = {
  status: 'completed' | 'non_fashion' | 'failed';
  item_type: string | null;
  subtype: string | null;
  brand_guess: string | null;
  primary_color: string | null;
  confidence_score: number | null;
};

/**
 * Deterministic V2 → legacy projection.
 *
 * This is the bridge that proves V1 and V2 cannot disagree: both derive from the
 * same normalization, and the parity test asserts this projection matches the
 * legacy fields the function already emits. It is NOT a second normalizer.
 *
 * Status collapse is intentional and one-way: the legacy contract has only three
 * states, so `partial` projects to `completed` (it is a real, useful
 * identification) while every non-identity outcome projects to `failed`. The
 * richer V2 status remains available to any V2 consumer.
 */
export function projectV2ToLegacy(
  result: FashionIdentificationResultV2,
): LegacyIdentificationProjection {
  let status: LegacyIdentificationProjection['status'];
  if (result.status === 'completed' || result.status === 'partial') {
    status = 'completed';
  } else if (result.status === 'non_fashion') {
    status = 'non_fashion';
  } else {
    status = 'failed';
  }

  return {
    status,
    item_type: result.item.category,
    subtype: result.item.subtype,
    brand_guess: result.item.brand.value,
    primary_color: result.item.colors.primary,
    confidence_score: result.compatibility.globalConfidence,
  };
}

// ── Intent-aware commerce gating ─────────────────────────────────────────────

export const COMMERCE_SKIPPED_STYLE_INTENT = 'style_intent';
export const COMMERCE_SKIPPED_CLOSET_INTENT = 'closet_intent';

/**
 * Intents that must NEVER reach a commerce provider.
 *
 * Kept as a set rather than a chain of `!==` comparisons so that adding a fourth
 * non-commerce intent is one edit in one place. An intent absent from this set
 * shops; that default is deliberate and is asserted by test for every member of
 * the intent vocabulary, so a newly added intent cannot silently inherit it.
 */
const NON_COMMERCE_INTENTS: Record<string, string> = {
  identify_for_style: COMMERCE_SKIPPED_STYLE_INTENT,
  identify_for_closet: COMMERCE_SKIPPED_CLOSET_INTENT,
};

/**
 * The single decision point for whether commerce may run.
 *
 * Commerce runs only for identify_and_shop. For identify_for_style and
 * identify_for_closet every provider is skipped before it is called — never
 * called and then discarded, which would spend the quota and the latency for a
 * result nobody reads. A non-fashion or failed outcome never runs commerce
 * regardless of intent.
 *
 * The intent test comes FIRST and is unconditional. Ordering it ahead of the
 * status checks is what makes "a Closet request never shops" true for every
 * outcome, including the successful ones.
 */
export function shouldRunCommerce(input: {
  intent: FashionIdentificationIntent;
  status: FashionIdentificationStatus;
}): { run: boolean; skippedReason: string | null } {
  const nonCommerce = NON_COMMERCE_INTENTS[input.intent as string];
  if (nonCommerce) {
    return { run: false, skippedReason: nonCommerce };
  }
  if (input.status === 'non_fashion') return { run: false, skippedReason: 'non_fashion' };
  if (input.status === 'technical_failure') {
    return { run: false, skippedReason: 'technical_failure' };
  }
  if (input.status === 'insufficient_visual_evidence') {
    return { run: false, skippedReason: 'insufficient_visual_evidence' };
  }
  return { run: true, skippedReason: null };
}

/**
 * Whether a scan may persist Scanner-domain artifacts — per-user scan
 * intelligence rows and commerce outcome rows.
 *
 * `identify_for_style` produces a styling context and nothing else, and
 * `identify_for_closet` produces classification metadata for a device-local
 * candidate and nothing else. Neither may leave a per-user Scanner record
 * behind, on success OR failure. An intelligence row carrying
 * category/brand/colour for one of these is an implicit Recent-Scan-shaped
 * artifact, and a commerce outcome row for a scan that ran no commerce is a
 * false record. Quota accounting is usage, not an artifact, and is unaffected by
 * this gate — one selected image is one identification unit on every intent.
 *
 * Derived from the same NON_COMMERCE_INTENTS set that gates commerce, so the two
 * exclusions cannot drift apart: an intent that is not allowed to shop is not
 * allowed to leave a Scanner artifact either.
 */
export function shouldCaptureScanArtifacts(intent: FashionIdentificationIntent): boolean {
  return !NON_COMMERCE_INTENTS[intent as string];
}
