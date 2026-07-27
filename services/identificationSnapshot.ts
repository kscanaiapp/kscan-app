// Versioned identification snapshot for saved scans (IMG-008).
//
// WHY THIS EXISTS: `library.saveScan()` reduced a full normalized
// identification to six fields — category, silhouette, a comma-joined colour
// string, and three hardcoded blanks (`material_estimate: null`,
// `style_tags: []`, `confidence_score: null`). The cloud row's
// `analysis_result` then persisted that same subset. Subtype, brand and its
// evidence, secondary colours, pattern, construction details, visible and
// distinctive attributes, and confidence were all unrecoverable once a scan was
// reopened. Phase 2A recorded that as IMG-008 for both Scanner and Elise on
// both platforms.
//
// The row already accepts JSON; the loss was entirely client-side flattening.
// So this adds a durable, versioned snapshot alongside the existing fields
// rather than changing any schema or RLS policy.
//
// WHAT IS DELIBERATELY NOT HERE:
//   - the raw model response, prompts, provider debug data or credentials
//   - raw or partial Base64, local file paths, unrestricted EXIF
//   - commerce results — purchase options stay a separate, mutable snapshot so
//     a retailer result can never mutate the immutable visual identification
//   - the future five-confidence model, which belongs to Phase 2B/2C
//
// Only fields the normalized contract actually produced are stored. An absent
// attribute is null or an empty list, never an invented default.

import type { ScanIdentifyResponse } from '../types/scanIdentification';
import type { FashionIdentificationResultV2 } from '../types/fashionIdentificationV2';

export const IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION = 'fashion-identification-v1';

export type IdentificationSnapshotStatus = 'completed' | 'non_fashion' | 'failed' | 'unknown';

export type IdentificationEntryPath =
  | 'scanner_camera'
  | 'scanner_gallery'
  | 'elise_gallery'
  | 'elise_camera'
  | 'scanner_handoff'
  | 'unknown';

export type IdentificationBrandEvidence = {
  type: string;
  value?: string | null;
  confidence?: number | null;
};

export type PersistedIdentificationSnapshotV1 = {
  contractVersion: typeof IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION;
  status: IdentificationSnapshotStatus;
  category: string | null;
  subtype: string | null;
  brand: {
    value: string | null;
    confidence: number | null;
    evidence: IdentificationBrandEvidence[];
  };
  colors: {
    primary: string | null;
    secondary: string[];
  };
  material: string[];
  silhouette: string[];
  pattern: string[];
  attributes: {
    fit?: string | null;
    length?: string | null;
    sleeve?: string | null;
    neckline?: string | null;
    closure?: string | null;
    visible: string[];
    distinctive: string[];
  };
  confidence: {
    overall: number | null;
  };
  unknownReason?: string | null;
  source: {
    entryPath: IdentificationEntryPath;
  };
};

/**
 * Marker returned when a stored snapshot declares a contract version this build
 * does not understand. Reporting it explicitly is safer than silently treating
 * unknown data as absent, which would look identical to a legacy row.
 */
export type UnsupportedIdentificationSnapshot = {
  unsupported: true;
  contractVersion: string;
};

export type HydratedIdentification =
  | PersistedIdentificationSnapshotV1
  | UnsupportedIdentificationSnapshot
  | null;

const ENTRY_PATHS: readonly IdentificationEntryPath[] = [
  'scanner_camera',
  'scanner_gallery',
  'elise_gallery',
  'elise_camera',
  'scanner_handoff',
  'unknown',
];

const STATUSES: readonly IdentificationSnapshotStatus[] = [
  'completed',
  'non_fashion',
  'failed',
  'unknown',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Deduplicated, trimmed, non-empty strings. Order preserved. */
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

/** Splits the comma-joined colour string the legacy attribute shape uses. */
function splitColors(value: unknown): string[] {
  const text = str(value);
  return text ? list(text.split(',')) : [];
}

export function isIdentificationEntryPath(value: unknown): value is IdentificationEntryPath {
  return typeof value === 'string' && (ENTRY_PATHS as readonly string[]).includes(value);
}

/**
 * Builds the snapshot from a normalized `scan-identify` response.
 *
 * The response — not the flattened mapper metadata — is the source, because the
 * mapper already discards subtype, secondary colours, brand evidence,
 * construction details and distinctive features on its way to the legacy
 * display shape. Those are exactly the fields IMG-008 is about.
 */
export function buildIdentificationSnapshot(
  response: ScanIdentifyResponse | null | undefined,
  options?: { entryPath?: IdentificationEntryPath },
): PersistedIdentificationSnapshotV1 | null {
  if (!isRecord(response)) return null;

  const id = isRecord(response.identification) ? response.identification : {};
  const attributes = isRecord(response.attributes) ? response.attributes : {};

  const status: IdentificationSnapshotStatus = (STATUSES as readonly string[]).includes(
    String(response.status),
  )
    ? (response.status as IdentificationSnapshotStatus)
    : 'unknown';

  // Brand evidence is what the model actually observed, kept separable from the
  // brand guess so a later phase can weigh them independently. Commerce
  // corroboration is deliberately NOT evidence here: it is not visual.
  const evidence: IdentificationBrandEvidence[] = [];
  const visibleBrandText = str(id.visible_brand_text);
  if (visibleBrandText) evidence.push({ type: 'visible_brand_text', value: visibleBrandText });
  if (id.logo_detected === true) evidence.push({ type: 'logo_detected', value: null });
  const brandGuess = str(id.brand_guess);
  if (brandGuess) evidence.push({ type: 'brand_guess', value: brandGuess });

  const primaryColor = str(id.primary_color)
    ?? (Array.isArray(attributes.colorPalette) ? str(attributes.colorPalette[0]) : null);
  const secondaryColors = list(
    id.secondary_colors,
    Array.isArray(attributes.colorPalette) ? attributes.colorPalette.slice(1) : [],
  ).filter((color) => color !== primaryColor);

  return {
    contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION,
    status,
    category: str(id.item_type) ?? str(attributes.category),
    subtype: str(id.subtype),
    brand: {
      value: brandGuess ?? visibleBrandText,
      confidence: num(id.confidence_score) !== null && (brandGuess || visibleBrandText)
        ? num(id.confidence_score)
        : null,
      evidence,
    },
    colors: { primary: primaryColor, secondary: secondaryColors },
    material: list(id.material_estimate, attributes.materialEstimate),
    silhouette: list(id.silhouette, attributes.silhouette),
    pattern: list(id.pattern, attributes.pattern),
    attributes: {
      fit: str(id.fit),
      length: str(id.length),
      sleeve: str(id.sleeve_length),
      neckline: str(id.neckline_or_lapel),
      closure: str(id.closure),
      visible: list(id.style_tags, attributes.styleTags, id.occasion_tags, attributes.occasion),
      distinctive: list(id.distinctive_features),
    },
    confidence: { overall: num(id.confidence_score) ?? num(attributes.confidenceScore) },
    unknownReason: str(id.scan_quality_note) ?? (status === 'completed' ? null : str(response.userMessage)),
    source: { entryPath: options?.entryPath ?? 'unknown' },
  };
}

/**
 * Validates an untrusted stored value (a local record or a cloud
 * `analysis_result` payload) into a usable snapshot.
 *
 * Returns an explicit `unsupported` marker for a recognised-but-newer contract
 * version, and null for anything malformed. A malformed payload must degrade to
 * legacy display, never throw into hydration.
 */
export function sanitizeIdentificationSnapshot(value: unknown): HydratedIdentification {
  if (!isRecord(value)) return null;

  const contractVersion = str(value.contractVersion);
  if (!contractVersion) return null;
  if (contractVersion !== IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION) {
    return { unsupported: true, contractVersion };
  }

  const brand = isRecord(value.brand) ? value.brand : {};
  const colors = isRecord(value.colors) ? value.colors : {};
  const attributes = isRecord(value.attributes) ? value.attributes : {};
  const confidence = isRecord(value.confidence) ? value.confidence : {};
  const source = isRecord(value.source) ? value.source : {};

  const evidence: IdentificationBrandEvidence[] = Array.isArray(brand.evidence)
    ? brand.evidence
        .filter(isRecord)
        .map((entry) => ({
          type: str(entry.type) ?? 'unknown',
          value: str(entry.value),
          confidence: num(entry.confidence),
        }))
    : [];

  return {
    contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION,
    status: (STATUSES as readonly string[]).includes(String(value.status))
      ? (value.status as IdentificationSnapshotStatus)
      : 'unknown',
    category: str(value.category),
    subtype: str(value.subtype),
    brand: { value: str(brand.value), confidence: num(brand.confidence), evidence },
    colors: { primary: str(colors.primary), secondary: list(colors.secondary) },
    material: list(value.material),
    silhouette: list(value.silhouette),
    pattern: list(value.pattern),
    attributes: {
      fit: str(attributes.fit),
      length: str(attributes.length),
      sleeve: str(attributes.sleeve),
      neckline: str(attributes.neckline),
      closure: str(attributes.closure),
      visible: list(attributes.visible),
      distinctive: list(attributes.distinctive),
    },
    confidence: { overall: num(confidence.overall) },
    unknownReason: str(value.unknownReason),
    source: {
      entryPath: isIdentificationEntryPath(source.entryPath) ? source.entryPath : 'unknown',
    },
  };
}

/**
 * Reconstructs what a pre-snapshot row can still tell us.
 *
 * Legacy rows are never made unreadable: their six flattened fields become a
 * snapshot whose absent parts are honestly empty. `status` is `unknown` rather
 * than `completed`, because a legacy row records no status and claiming success
 * for one would be an invention.
 */
export function snapshotFromLegacyAttributes(
  attributes: unknown,
  options?: { entryPath?: IdentificationEntryPath },
): PersistedIdentificationSnapshotV1 | null {
  if (!isRecord(attributes)) return null;

  const colors = splitColors(attributes.color_palette);
  const category = str(attributes.category);
  const silhouette = list(attributes.silhouette);
  const material = list(attributes.material_estimate);
  const visible = list(attributes.style_tags);
  const overall = num(attributes.confidence_score);

  // Nothing usable at all — treat as no identification rather than an empty
  // snapshot that would look like a real but blank result.
  if (!category && colors.length === 0 && silhouette.length === 0 && material.length === 0) {
    return null;
  }

  return {
    contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION,
    status: 'unknown',
    category,
    subtype: null,
    brand: { value: null, confidence: null, evidence: [] },
    colors: { primary: colors[0] ?? null, secondary: colors.slice(1) },
    material,
    silhouette,
    pattern: [],
    attributes: {
      fit: null,
      length: null,
      sleeve: null,
      neckline: null,
      closure: null,
      visible,
      distinctive: [],
    },
    confidence: { overall },
    unknownReason: null,
    source: { entryPath: options?.entryPath ?? 'unknown' },
  };
}

/**
 * The single read path for a saved scan's identification.
 *
 *   versioned snapshot present  → hydrate the complete normalized result
 *   unknown contract version    → report it; caller falls back to legacy display
 *   no snapshot                 → reconstruct from the legacy flattened fields
 */
export function hydrateIdentificationSnapshot(scan: unknown): HydratedIdentification {
  if (!isRecord(scan)) return null;

  const sanitized = sanitizeIdentificationSnapshot(scan.identificationSnapshot);
  if (sanitized) return sanitized;

  return snapshotFromLegacyAttributes(scan.attributes);
}

// ── fashion-identification-v2 snapshot (Phase 2B.2) ──────────────────────────
//
// ADDITIVE ONLY. Everything above keeps its exact behaviour, because Elise and
// StyleChat read through it and Phase 2B.2 is a Scanner-only migration.
//
// No database migration and no regenerated types: the local record and the
// cloud `analysis_result` column already accept arbitrary JSON, which is the
// same property IMG-008 relied on.

export const IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2 = 'fashion-identification-v2';
export const IDENTIFICATION_SNAPSHOT_VERSION_V2 = 2 as const;

const STATUSES_V2 = [
  'completed',
  'partial',
  'insufficient_visual_evidence',
  'non_fashion',
  'multiple_items_need_selection',
  'technical_failure',
] as const;

export type IdentificationSnapshotSource = 'camera' | 'gallery';

/**
 * The persisted V2 envelope.
 *
 * DELIBERATELY ABSENT, and asserted absent by test: Base64, evidence ids,
 * candidate ids, detection digests, candidate bounds, raw EXIF, local URIs,
 * filenames, the raw provider response and the full request body. Every one of
 * those is either request-scoped correlation data that means nothing after the
 * operation ends, or content that must never reach durable storage.
 *
 * `purchaseOptions` stays the existing commerce type, unparsed and unranked —
 * Phase 2B.2 does not touch the commerce contract.
 */
export type PersistedIdentificationSnapshotV2<TPurchaseOption = unknown> = {
  snapshotVersion: typeof IDENTIFICATION_SNAPSHOT_VERSION_V2;
  contractVersion: typeof IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2;
  identification: FashionIdentificationResultV2;
  purchaseOptions: TPurchaseOption[];
  source: IdentificationSnapshotSource;
  createdAt: string;
  updatedAt: string;
};

export function isIdentificationSnapshotSource(
  value: unknown,
): value is IdentificationSnapshotSource {
  return value === 'camera' || value === 'gallery';
}

export function buildIdentificationSnapshotV2<TPurchaseOption = unknown>(input: {
  identification: FashionIdentificationResultV2;
  purchaseOptions?: TPurchaseOption[] | null;
  source: IdentificationSnapshotSource;
  createdAt: string;
  updatedAt?: string;
}): PersistedIdentificationSnapshotV2<TPurchaseOption> | null {
  if (!isRecord(input) || !isRecord(input.identification)) return null;
  if (input.identification.contractVersion !== IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2) {
    return null;
  }
  const createdAt = str(input.createdAt);
  if (!createdAt) return null;
  return {
    snapshotVersion: IDENTIFICATION_SNAPSHOT_VERSION_V2,
    contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2,
    identification: input.identification,
    purchaseOptions: Array.isArray(input.purchaseOptions) ? input.purchaseOptions.slice() : [],
    source: isIdentificationSnapshotSource(input.source) ? input.source : 'camera',
    createdAt,
    updatedAt: str(input.updatedAt) ?? createdAt,
  };
}

/**
 * Minimal structural gate for a stored V2 snapshot.
 *
 * Only the invariants persistence itself depends on are re-checked here. The
 * full contract validation already ran at the response boundary before this was
 * ever written, and re-running it on read would let a later validator revision
 * silently orphan rows that were valid when saved.
 */
export function sanitizeIdentificationSnapshotV2(
  value: unknown,
): PersistedIdentificationSnapshotV2 | null {
  if (!isRecord(value)) return null;
  if (value.snapshotVersion !== IDENTIFICATION_SNAPSHOT_VERSION_V2) return null;
  if (value.contractVersion !== IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2) return null;

  const identification = value.identification;
  if (!isRecord(identification)) return null;
  if (identification.contractVersion !== IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2) return null;
  if (!isRecord(identification.item)) return null;
  if (!(STATUSES_V2 as readonly string[]).includes(String(identification.status))) return null;

  const createdAt = str(value.createdAt);
  if (!createdAt) return null;

  return {
    snapshotVersion: IDENTIFICATION_SNAPSHOT_VERSION_V2,
    contractVersion: IDENTIFICATION_SNAPSHOT_CONTRACT_VERSION_V2,
    identification: identification as unknown as FashionIdentificationResultV2,
    purchaseOptions: Array.isArray(value.purchaseOptions) ? value.purchaseOptions.slice() : [],
    source: isIdentificationSnapshotSource(value.source) ? value.source : 'camera',
    createdAt,
    updatedAt: str(value.updatedAt) ?? createdAt,
  };
}

export type HydratedScanIdentification =
  | { kind: 'v2'; snapshot: PersistedIdentificationSnapshotV2 }
  | { kind: 'v1'; snapshot: PersistedIdentificationSnapshotV1 }
  | { kind: 'unsupported'; contractVersion: string }
  | null;

/**
 * Per-record hydration for one saved scan.
 *
 * Precedence: a valid V2 snapshot, then a valid V1 snapshot, then a
 * reconstruction from the unversioned legacy fields. An INVALID newer format
 * never outranks a valid older one — a corrupt V2 blob on a row that also has
 * usable V1 data must not make that row unreadable.
 *
 * Never throws, never rewrites the record it read.
 */
export function hydrateScanIdentificationRecord(scan: unknown): HydratedScanIdentification {
  if (!isRecord(scan)) return null;

  const v2 = sanitizeIdentificationSnapshotV2(scan.identificationSnapshotV2);
  if (v2) return { kind: 'v2', snapshot: v2 };

  const v1 = sanitizeIdentificationSnapshot(scan.identificationSnapshot);
  if (v1 && !('unsupported' in v1)) return { kind: 'v1', snapshot: v1 };

  const legacy = snapshotFromLegacyAttributes(scan.attributes);
  if (legacy) return { kind: 'v1', snapshot: legacy };

  if (v1 && 'unsupported' in v1) {
    return { kind: 'unsupported', contractVersion: v1.contractVersion };
  }
  return null;
}

export type ScanHistoryHydration<TRecord> = {
  records: TRecord[];
  /** Count only. The offending record is never logged or echoed. */
  corruptedCount: number;
};

/**
 * Hydrates a mixed history collection one record at a time.
 *
 * WHY PER RECORD: Recent Scans legitimately contains V2, V1, unversioned legacy
 * and — after any past partial write — corrupt entries side by side. A single
 * try/catch around the whole array turns one bad row into an empty history, so
 * each record is isolated and a failure drops only that record. Order is
 * preserved, valid records are kept, and nothing is rewritten on read:
 * compatibility stays lazy and per record rather than an eager migration on
 * first launch.
 */
export function hydrateScanHistory<TRecord>(
  rawRecords: unknown,
  hydrateOne: (record: unknown) => TRecord | null,
): ScanHistoryHydration<TRecord> {
  if (!Array.isArray(rawRecords)) return { records: [], corruptedCount: 0 };
  const records: TRecord[] = [];
  let corruptedCount = 0;
  for (const rawRecord of rawRecords) {
    try {
      const hydrated = hydrateOne(rawRecord);
      if (hydrated) records.push(hydrated);
      else corruptedCount += 1;
    } catch {
      corruptedCount += 1;
    }
  }
  return { records, corruptedCount };
}
