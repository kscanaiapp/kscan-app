// Canonical fashion-metadata adapter (Closet V2 / S2).
//
// WHY THIS EXISTS
// ---------------
// Scanner identification produces a rich garment description
// (`DetailedIdentification`: subtype, primary_color, pattern, fit, plus the
// three separable brand-evidence signals). That richness already survives
// persistence: `buildIdentificationSnapshot` writes a
// `PersistedIdentificationSnapshotV1` into `saved_scans.analysis_result`, and
// `mapSavedScanRowToModel` hydrates it back.
//
// What did NOT happen is anyone downstream READING it. The legacy read path
// (`analysis_result.metadata`) is a projection of `SavedScanModel.attributes`,
// which is a six-field shape — category, silhouette, color_palette,
// material_estimate, style_tags, confidence_score. It has no subtype, no
// pattern, no fit and no brand at all. Readers that looked for
// `meta.subcategory` / `meta.pattern` / `meta.fit` / `meta.brand` were reading
// keys the writer never writes, so those fields resolved to null on every row
// — which is why Room Intelligence declares pattern and fit structurally
// unavailable.
//
// This module is the single place that answers "what does the system actually
// know about this garment", in priority order:
//
//     PersistedIdentificationSnapshotV2   (authority — current Scanner contract)
//        ↓ falls back per-field to
//     PersistedIdentificationSnapshotV1   (legacy durable Scanner contract)
//        ↓ falls back per-field to
//     legacy analysis_result.metadata     (six-field legacy projection)
//        ↓ falls back to
//     null                                (honest absence, never invention)
//
// DESIGN RULES
//   - No field is invented. Absent stays absent; `provenance` says which layer
//     answered so a caller can tell "no pattern" from "pattern unknown".
//   - No database column is renamed. This normalizes at the adapter boundary
//     only, which is the whole point of the module.
//   - Brand evidence is NOT collapsed into a brand string. A V2 scalar is
//     authoritative only with visible-text/logo provenance; V1 may use
//     visible brand text only. `brand_guess` always remains typed evidence and
//     is never presented as an observation.
//   - Snapshot list fields (material/silhouette/pattern) are kept as lists AND
//     surfaced as a scalar head, because the existing OwnedClosetItem contract
//     is scalar and must keep working unchanged.

import type {
  IdentificationBrandEvidence,
  PersistedIdentificationSnapshotV1,
  PersistedIdentificationSnapshotV2,
} from './identificationSnapshot';

/** Which layer answered a given field. */
export type CanonicalMetadataProvenance =
  | 'identification_snapshot_v2'
  | 'identification_snapshot_v1'
  | 'legacy_metadata'
  | 'absent';

export const CANONICAL_FASHION_METADATA_VERSION = 1 as const;

/**
 * The canonical application-level garment semantic.
 *
 * NAMING NOTE: identification calls it `subtype`; `OwnedClosetItem` and the
 * E4.1 evidence envelope call the same concept `subcategory`. This contract
 * uses `subtype` — the producer's name — and adapters map outward to whatever
 * their destination contract calls it. One semantic, no renamed columns.
 */
export type CanonicalFashionMetadata = {
  version: typeof CANONICAL_FASHION_METADATA_VERSION;
  category: string | null;
  subtype: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  /** Full list as identified; `material` is the scalar head for legacy readers. */
  materials: string[];
  material: string | null;
  patterns: string[];
  pattern: string | null;
  silhouettes: string[];
  silhouette: string | null;
  fit: string | null;
  brand: string | null;
  brandConfidence: number | null;
  /** Separable observations. Never flattened into `brand`. */
  brandEvidence: IdentificationBrandEvidence[];
  styleTags: string[];
  confidence: number | null;
  /** Per-field record of which layer answered. */
  provenance: {
    category: CanonicalMetadataProvenance;
    subtype: CanonicalMetadataProvenance;
    primaryColor: CanonicalMetadataProvenance;
    material: CanonicalMetadataProvenance;
    pattern: CanonicalMetadataProvenance;
    silhouette: CanonicalMetadataProvenance;
    fit: CanonicalMetadataProvenance;
    brand: CanonicalMetadataProvenance;
  };
  /** True when the identification snapshot supplied at least one field. */
  snapshotBacked: boolean;
};

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function textList(value: unknown, limit = 12): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const cleaned = text(entry);
    if (cleaned && !out.includes(cleaned)) out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}

function head(values: string[]): string | null {
  return values.length > 0 ? values[0] : null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Brand evidence, re-validated on the way out.
 *
 * The stored snapshot is untrusted input (it round-trips through a jsonb
 * column), so entries are re-checked here rather than assumed well-formed.
 * An entry without a usable `type` is dropped instead of being repaired into
 * something that would read as an observation the model never made.
 */
function sanitizeBrandEvidence(value: unknown): IdentificationBrandEvidence[] {
  if (!Array.isArray(value)) return [];
  const out: IdentificationBrandEvidence[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const type = text(record.type);
    if (!type) continue;
    out.push({
      type,
      value: text(record.value),
      confidence: finiteNumber(record.confidence),
    });
    if (out.length >= 8) break;
  }
  return out;
}

function sanitizeV2BrandEvidence(value: unknown): IdentificationBrandEvidence[] {
  if (!Array.isArray(value)) return [];
  return sanitizeBrandEvidence(
    value.map((entry) => {
      if (!entry || typeof entry !== 'object') return null;
      const record = entry as Record<string, unknown>;
      return {
        type: record.type,
        value: record.observation,
        confidence: record.confidence,
      };
    }),
  );
}

/** The legacy six-field projection stored at `analysis_result.metadata`. */
export type LegacyScanMetadata = Record<string, unknown> | null | undefined;

function pick(
  fromV2: string | null,
  fromV1: string | null,
  fromLegacy: string | null,
): { value: string | null; provenance: CanonicalMetadataProvenance } {
  if (fromV2) return { value: fromV2, provenance: 'identification_snapshot_v2' };
  if (fromV1) return { value: fromV1, provenance: 'identification_snapshot_v1' };
  if (fromLegacy) return { value: fromLegacy, provenance: 'legacy_metadata' };
  return { value: null, provenance: 'absent' };
}

/**
 * Resolve canonical metadata from the durable identification snapshot, falling
 * back per-field to the legacy metadata projection.
 *
 * `snapshot` may legitimately be null — legacy rows, rows saved before the
 * contract existed, and rows whose snapshot failed validation all arrive that
 * way, and all must keep resolving from `legacy` rather than becoming empty.
 */
export function resolveCanonicalFashionMetadata(input: {
  snapshotV2?: PersistedIdentificationSnapshotV2 | null;
  snapshot?: PersistedIdentificationSnapshotV1 | null;
  legacy?: LegacyScanMetadata;
}): CanonicalFashionMetadata {
  const snapshotV2 = input.snapshotV2 ?? null;
  const snapshot = input.snapshot ?? null;
  const legacy = input.legacy && typeof input.legacy === 'object' ? input.legacy : {};
  const v2Item = snapshotV2?.identification?.item ?? null;
  const v2Confidence = snapshotV2?.identification?.compatibility?.globalConfidence ?? null;

  const snapAttributes =
    snapshot && snapshot.attributes && typeof snapshot.attributes === 'object'
      ? snapshot.attributes
      : ({} as PersistedIdentificationSnapshotV1['attributes']);
  const snapBrand =
    snapshot && snapshot.brand && typeof snapshot.brand === 'object'
      ? snapshot.brand
      : ({} as PersistedIdentificationSnapshotV1['brand']);
  const snapColors =
    snapshot && snapshot.colors && typeof snapshot.colors === 'object'
      ? snapshot.colors
      : ({} as PersistedIdentificationSnapshotV1['colors']);

  // Snapshot list fields, then the legacy scalar equivalents.
  const snapshotMaterials = textList(snapshot?.material);
  const snapshotPatterns = textList(snapshot?.pattern);
  const snapshotSilhouettes = textList(snapshot?.silhouette);
  const snapshotV2Materials = textList(v2Item?.material);
  const snapshotV2Patterns = textList(v2Item?.pattern);
  const snapshotV2Silhouettes = textList(v2Item?.silhouette);

  const legacyMaterial = text(legacy.material_estimate) ?? text(legacy.material);
  const legacyPattern = text(legacy.pattern);
  const legacySilhouette = text(legacy.silhouette);
  // Legacy stored the palette under `color_palette`; some rows used `color`.
  const legacyColor = text(legacy.color) ?? text(legacy.color_palette);

  const category = pick(text(v2Item?.category), text(snapshot?.category), text(legacy.category));
  // Legacy readers looked for `subcategory`/`itemType`; neither is written by
  // the current writer, but a hand-written or migrated row may carry them.
  const subtype = pick(
    text(v2Item?.subtype),
    text(snapshot?.subtype),
    text(legacy.subcategory) ?? text(legacy.subtype) ?? text(legacy.itemType),
  );
  const primaryColor = pick(text(v2Item?.colors?.primary), text(snapColors.primary), legacyColor);
  const material = pick(head(snapshotV2Materials), head(snapshotMaterials), legacyMaterial);
  const pattern = pick(head(snapshotV2Patterns), head(snapshotPatterns), legacyPattern);
  const silhouette = pick(
    head(snapshotV2Silhouettes),
    head(snapshotSilhouettes),
    legacySilhouette,
  );
  const fit = pick(text(v2Item?.attributes?.fit), text(snapAttributes.fit), text(legacy.fit));

  const v1BrandEvidence = sanitizeBrandEvidence(snapBrand.evidence);
  const visibleV1Brand = v1BrandEvidence.find(
    (entry) => entry.type === 'visible_brand_text' && text(entry.value),
  );
  const v2BrandProvenance = text(v2Item?.brand?.provenance);
  const v2BrandIsObserved =
    v2BrandProvenance === 'visible_text' ||
    v2BrandProvenance === 'logo_shape';
  // A V1 brand.value is commonly the model's brand_guess. It is not an
  // observed brand and must never be flattened into the authoritative scalar.
  // V2 may supply the scalar only after the backend's visual-evidence gate has
  // established one; commerce/catalog corroboration remains separate.
  // A present V2 identification owns the brand decision even when that
  // decision is "guess only". Falling through to an older V1/legacy scalar in
  // that case can resurrect stale contradictory brand data and turn it into an
  // observation. Older layers are consulted only when no V2 snapshot exists.
  const brand = snapshotV2
    ? pick(v2BrandIsObserved ? text(v2Item?.brand?.value) : null, null, null)
    : pick(
        null,
        text(visibleV1Brand?.value),
        v1BrandEvidence.some((entry) => entry.type === 'brand_guess')
          ? null
          : text(legacy.brand),
      );

  const materials = snapshotV2Materials.length > 0
    ? snapshotV2Materials
    : snapshotMaterials.length > 0
    ? snapshotMaterials
    : (legacyMaterial ? [legacyMaterial] : []);
  const patterns = snapshotV2Patterns.length > 0
    ? snapshotV2Patterns
    : snapshotPatterns.length > 0
    ? snapshotPatterns
    : (legacyPattern ? [legacyPattern] : []);
  const silhouettes = snapshotV2Silhouettes.length > 0
    ? snapshotV2Silhouettes
    : snapshotSilhouettes.length > 0
    ? snapshotSilhouettes
    : (legacySilhouette ? [legacySilhouette] : []);

  const styleTags = (() => {
    const fromV2 = textList(v2Item?.attributes?.visible);
    if (fromV2.length > 0) return fromV2;
    const fromSnapshot = textList(snapAttributes.visible);
    if (fromSnapshot.length > 0) return fromSnapshot;
    return textList(legacy.style_tags);
  })();

  const secondaryColors = (() => {
    const fromV2 = textList(v2Item?.colors?.secondary);
    if (fromV2.length > 0) return fromV2.filter((c) => c !== primaryColor.value);
    const fromSnapshot = textList(snapColors.secondary);
    if (fromSnapshot.length > 0) return fromSnapshot.filter((c) => c !== primaryColor.value);
    return [];
  })();

  const provenance = {
    category: category.provenance,
    subtype: subtype.provenance,
    primaryColor: primaryColor.provenance,
    material: material.provenance,
    pattern: pattern.provenance,
    silhouette: silhouette.provenance,
    fit: fit.provenance,
    brand: brand.provenance,
  };

  return {
    version: CANONICAL_FASHION_METADATA_VERSION,
    category: category.value,
    subtype: subtype.value,
    primaryColor: primaryColor.value,
    secondaryColors,
    materials,
    material: material.value,
    patterns,
    pattern: pattern.value,
    silhouettes,
    silhouette: silhouette.value,
    fit: fit.value,
    brand: brand.value,
    brandConfidence: brand.value
      ? finiteNumber(v2Item?.brand?.confidence) ?? finiteNumber(snapBrand.confidence)
      : null,
    brandEvidence: snapshotV2
      ? sanitizeV2BrandEvidence(v2Item?.brand?.evidence)
      : v1BrandEvidence,
    styleTags,
    confidence:
      finiteNumber(v2Confidence) ??
      finiteNumber(snapshot?.confidence?.overall) ??
      finiteNumber(legacy.confidence_score),
    provenance,
    snapshotBacked: Object.values(provenance).some(
      (p) => p === 'identification_snapshot_v1' || p === 'identification_snapshot_v2',
    ),
  };
}

/**
 * Fields this build can carry end-to-end for a given resolved item.
 *
 * Room Intelligence publishes an `unavailableFields` list to the model so it
 * can honestly say "I can't judge that". That list must be computed from what
 * the item actually resolved to, NOT hard-coded — a hard-coded list goes stale
 * in exactly the direction that makes the model understate what it knows.
 */
export function unavailableCanonicalFields(
  metadata: CanonicalFashionMetadata,
): string[] {
  const missing: string[] = [];
  if (!metadata.pattern) missing.push('pattern');
  if (!metadata.fit) missing.push('fit');
  if (!metadata.silhouette) missing.push('silhouette');
  if (!metadata.material) missing.push('material');
  if (!metadata.primaryColor) missing.push('color');
  if (!metadata.subtype) missing.push('subtype');
  return missing;
}
