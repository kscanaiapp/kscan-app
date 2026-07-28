// Canonical fashion identification contract v2 — client mirror.
//
// SOURCE OF TRUTH: contracts/fashion-identification-v2.schema.json.
// The backend (Deno) mirror lives at
// supabase/functions/_shared/fashionIdentificationV2.ts. All three are held
// together by __tests__/fashionIdentificationContractParity.test.js, which
// compares the vocabularies exported below against the schema enums.
//
// This mirror exists because the Deno module uses explicit `.ts` import
// specifiers and Deno globals that React Native's bundler cannot resolve. The
// vocabularies are therefore duplicated deliberately and held identical by
// test rather than by import.
//
// Scanner and Elise both consume THIS contract. Neither may reinterpret the
// taxonomy: an adapter may format display copy, but the structured identity is
// whatever the backend normalized.

export const FASHION_IDENTIFICATION_CONTRACT_V2 = 'fashion-identification-v2' as const;

export const FASHION_IDENTIFICATION_INTENTS = [
  'identify_and_shop',
  'identify_for_style',
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

/**
 * Truthful privacy attestation.
 *
 * Face and plate masking remain deferred in Phase 2B. These are typed as the
 * literal `false` so no code path can set them true, and they must never be
 * inferred from JPEG re-encoding, EXIF stripping, resizing, or URI
 * normalization — none of which is privacy filtering.
 */
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

/**
 * The shared image-evidence gateway's output.
 *
 * Every image entry point — Scanner camera/gallery, Elise camera/gallery/header
 * gallery — produces this one object. `analysisBase64` is request-scoped only:
 * it must never reach long-lived UI state, persistence, logs, or a cloud row,
 * and is cleared once the request settles or is cancelled.
 */
export type PreparedFashionEvidence = {
  evidenceId: string;
  localPreviewUri: string;
  analysisBase64: string;
  width?: number;
  height?: number;
  mimeType: 'image/jpeg';
  sequenceIndex: number;
  contentHash?: string;
  privacy: FashionIdentificationPrivacyV2;
};

// ── Elise canonical fashion context (Phase 2B.3) ─────────────────────────────

export const ELISE_FASHION_CONTEXT_V2 = 'elise-fashion-context-v2' as const;

/**
 * Where an Elise attachment came from.
 *
 * `direct_camera` / `direct_gallery` / `header_gallery` are raw images that
 * require identification. `recent_scan` / `scanner_handoff` already carry a
 * structured identity to be reused. `closet` / `dressing_room` are authorized
 * structured items that must not be re-identified merely because an image
 * exists. Routing is decided on THIS value, never on "does it have an image".
 */
export const ELISE_FASHION_CONTEXT_SOURCES = [
  'direct_camera',
  'direct_gallery',
  'header_gallery',
  'recent_scan',
  'scanner_handoff',
  'closet',
  'dressing_room',
] as const;

export type EliseFashionContextSource = typeof ELISE_FASHION_CONTEXT_SOURCES[number];

/**
 * Per-source outcome. Kept separate from the identification result because a
 * failed or evidence-less source still occupies a slot in the collection and the
 * user still needs a retry or remove affordance for it — but only `ready` and
 * `partial` may ever reach the model as styling evidence.
 */
export const ELISE_FASHION_ITEM_STATES = [
  'ready',
  'partial',
  'insufficient_evidence',
  'non_fashion',
  'technical_failure',
] as const;

export type EliseFashionItemState = typeof ELISE_FASHION_ITEM_STATES[number];

export const ELISE_FASHION_IDENTITY_V2 = 'elise-fashion-identity-v2' as const;

/**
 * The styling-safe PROJECTION of a canonical identification result.
 *
 * WHY A DISTINCT TYPE RATHER THAN THE CANONICAL RESULT: the canonical
 * `FashionIdentificationResultV2` legitimately carries transport correlation —
 * `evidence[].evidenceId`, `candidates[].evidenceId`, `brand.evidence[].evidenceId`
 * and `conflicts[].evidenceIds` — because a selected-item request has to be tied
 * to the image detection ran on. Every one of those is forbidden in an Elise
 * context.
 *
 * Deleting them from a copy and continuing to call it a
 * `FashionIdentificationResultV2` would be worse than a separate type: the object
 * would no longer satisfy the contract it claims, anything validating it as the
 * canonical result would be validating a lie, and the nested cases are easy to
 * miss (an incomplete strip that leaves `brand.evidence[]` alone still leaks).
 *
 * So this is a COPY of only the styling-relevant fields, with its own version
 * marker, validated on its own terms. The canonical result stays intact and valid
 * wherever it is held; this is what crosses the wire to StyleChat.
 *
 * DELIBERATELY ABSENT: requestId, evidence[], candidates[], brand.evidence[],
 * conflicts[].evidenceIds, exactProduct.sku, compatibility.* — correlation,
 * transport bookkeeping, or commerce metadata, none of it styling information.
 */
export type EliseFashionIdentityV2 = {
  identityVersion: typeof ELISE_FASHION_IDENTITY_V2;
  status: FashionIdentificationStatus;
  resolutionLevel: FashionIdentificationResolutionLevel;
  category: string | null;
  subtype: string | null;
  brand: {
    value: string | null;
    confidence: number | null;
    provenance: FashionIdentificationBrandProvenance;
  };
  colors: { primary: string | null; secondary: string[] };
  material: string[];
  silhouette: string[];
  pattern: string[];
  attributes: {
    fit: string | null;
    length: string | null;
    sleeve: string | null;
    neckline: string | null;
    collar: string | null;
    closure: string | null;
    pockets: string[];
    visible: string[];
    distinctive: string[];
  };
  confidence: {
    category: number | null;
    subtype: number | null;
    brand: number | null;
    modelFamily: number | null;
    exactProduct: number | null;
  };
  /** Only ever populated at `exact_product` resolution. Never carries a SKU. */
  exactProduct: { brand: string | null; model: string | null } | null;
  /** Field-level disagreements, without the evidence ids that produced them. */
  conflicts: Array<{ field: string; description: string }>;
  unknownReason: string | null;
  /** Global confidence, carried as the single honest number the contract reports. */
  globalConfidence: number | null;
};

/**
 * One garment in Elise's canonical context.
 *
 * `identification` is the styling-safe projection, not the canonical result — see
 * `EliseFashionIdentityV2` for why those must be different types.
 *
 * `sourceIndex` preserves the original selection order of a multi-image
 * attachment. It exists because asynchronous completion order is not selection
 * order, and identity must never be inferred from array position after the fact.
 */
export type EliseFashionContextItemV2 = {
  sourceIndex: number;
  state: EliseFashionItemState;
  /** Present only for `ready` and `partial`. */
  identification?: EliseFashionIdentityV2;
};

/**
 * Elise's grounded styling context — the single downstream contract.
 *
 * `identification` inside each item is authoritative for category, subtype,
 * brand, colour, material, pattern, silhouette, fit, visible attributes and
 * confidence. Authorized imagery may enrich styling interpretation (proportion,
 * composition, how a piece is worn) but must never silently overwrite the
 * canonical identity.
 *
 * DELIBERATELY ABSENT, and asserted absent by test: Base64, evidence ids,
 * candidate ids, detection digests, bounds, local URIs, raw provider responses,
 * retailer URLs, purchase options, commerce ranking, user ids and device ids.
 */
export type EliseFashionContextV2 = {
  contractVersion: typeof ELISE_FASHION_CONTEXT_V2;
  source: EliseFashionContextSource;
  items: EliseFashionContextItemV2[];
};

/**
 * @deprecated Phase 2B.1 forward declaration, superseded by
 * `EliseFashionContextV2`. It described a single item with an image-reference
 * list; the shipped contract is multi-item, source-tagged and carries no image
 * references at all. Retained only so the rename is visible in review.
 */
export type EliseVisualContextV2 = {
  contractVersion: 'elise-visual-context-v2';
  identification: FashionIdentificationResultV2;
  authorizedImageReferences: string[];
  userIntent?: string;
};

export const ELISE_VISUAL_CONTEXT_CONTRACT_V2 = 'elise-visual-context-v2' as const;
