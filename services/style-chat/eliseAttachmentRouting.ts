// Source-first attachment routing for Elise (Phase 2B.3, Addendum C).
//
// THE DECISION THIS MODULE OWNS: does this attachment need identification at all?
//
// Routing is on the attachment's SOURCE, never on `if (attachment.image)`. An
// image being present says nothing about whether an identity already exists — a
// Recent Scan, a Scanner handoff, a Closet item and a Dressing Room item all have
// images AND already have structured identity. Routing on image presence is
// exactly how a valid V2 Scanner result gets re-identified: a second full-price
// scan, a second chance to disagree with itself, and a second Recent Scan.
//
//   recent_scan | scanner_handoff  → reuse validated structured identity
//   closet      | dressing_room    → use the authorized structured item
//   direct_camera | direct_gallery | header_gallery
//                                   → identify_for_style
//
// A historical V1 or unversioned scan takes the compatibility branch: its real
// structured fields are preserved and NOTHING is upgraded to look like V2. A
// fabricated V2 identity would be a lie about which pipeline produced it.

import {
  ELISE_FASHION_CONTEXT_V2,
  type EliseFashionContextSource,
  type EliseFashionContextV2,
  type FashionIdentificationResultV2,
} from '../../types/fashionIdentificationV2';
import { hydrateScanIdentificationRecord } from '../identificationSnapshot';
import { isRecord, validateFashionV2Response } from '../fashionIdentificationV2Core';
import { buildEliseFashionContextV2 } from './eliseFashionContextV2';

/**
 * What the router decided.
 *
 *   `reuse_v2`      — a validated canonical identity already exists. No
 *                     `scan-identify` call is permitted for this attachment.
 *   `compatibility` — a real but pre-V2 structured identity exists. Used as-is,
 *                     never relabelled as V2.
 *   `structured_item` — an authorized Closet/Dressing Room record. Its curated
 *                     identity and provenance win; no re-identification.
 *   `identify`      — genuinely raw and unstructured. Run identify_for_style.
 *   `non_visual`    — nothing visual to do. Left completely alone.
 */
export type EliseAttachmentRoute =
  | { kind: 'reuse_v2'; identification: FashionIdentificationResultV2 }
  | { kind: 'compatibility'; projection: EliseLegacyProjection }
  | { kind: 'structured_item' }
  | { kind: 'identify' }
  | { kind: 'non_visual' };

/**
 * The strongest real structured fields a pre-V2 scan can offer.
 *
 * Every field is nullable and stays null when absent. Notably there is NO
 * confidence field: a V1 snapshot's global confidence is not a per-dimension
 * confidence, and copying one into five dimensions would invent four numbers.
 */
export type EliseLegacyProjection = {
  contractVersion: 'elise-legacy-projection-v1';
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: string[];
  material: string[];
  silhouette: string[];
  pattern: string[];
  summary: string | null;
};

export const ELISE_LEGACY_PROJECTION_V1 = 'elise-legacy-projection-v1' as const;

function nullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const trimmed = nullableString(entry);
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

/**
 * Sources whose identity already exists and must never be re-identified merely
 * because the attachment happens to carry an image.
 */
const STRUCTURED_SOURCES: ReadonlySet<string> = new Set([
  'closet',
  'dressing_room',
]);

const RAW_SOURCES: ReadonlySet<string> = new Set([
  'direct_camera',
  'direct_gallery',
  'header_gallery',
]);

const REUSABLE_SOURCES: ReadonlySet<string> = new Set([
  'recent_scan',
  'scanner_handoff',
]);

export type RouteAttachmentInput = {
  source: EliseFashionContextSource | string;
  /**
   * The saved-scan-shaped record for a `recent_scan`, or the handoff payload for
   * a `scanner_handoff`. Hydration decides V2 vs V1 vs legacy; the caller does
   * not get to assert a version.
   */
  record?: unknown;
  /**
   * A V2 result handed over directly (Scanner handoff in-memory). Validated here
   * — a caller claiming "this is V2" is not evidence that it is.
   */
  identificationV2?: unknown;
};

/**
 * The single routing decision.
 *
 * Deliberately total over the source vocabulary: an unrecognized source falls to
 * `non_visual` rather than `identify`, because guessing "probably raw" for an
 * unknown source is how a structured item would get re-identified.
 */
export function routeEliseAttachment(input: RouteAttachmentInput): EliseAttachmentRoute {
  if (!isRecord(input)) return { kind: 'non_visual' };
  const source = String(input.source);

  if (STRUCTURED_SOURCES.has(source)) return { kind: 'structured_item' };

  if (REUSABLE_SOURCES.has(source)) {
    // A directly supplied V2 result is validated before it is trusted.
    const direct = validateFashionV2Response(input.identificationV2);
    if (direct.kind === 'ok') return { kind: 'reuse_v2', identification: direct.result };

    const hydrated = hydrateScanIdentificationRecord(input.record);
    if (hydrated && hydrated.kind === 'v2') {
      const validated = validateFashionV2Response(hydrated.snapshot.identification);
      if (validated.kind === 'ok') return { kind: 'reuse_v2', identification: validated.result };
      // A stored V2 blob that no longer validates falls back to whatever real
      // pre-V2 fields the same record carries, rather than being re-identified.
      return { kind: 'compatibility', projection: projectLegacyRecord(input.record) };
    }
    if (hydrated && hydrated.kind === 'v1') {
      return { kind: 'compatibility', projection: projectLegacySnapshot(hydrated.snapshot) };
    }
    // An unsupported or unreadable snapshot still must not trigger a rescan: the
    // user attached an existing scan, not a new photo.
    return { kind: 'compatibility', projection: projectLegacyRecord(input.record) };
  }

  if (RAW_SOURCES.has(source)) return { kind: 'identify' };
  return { kind: 'non_visual' };
}

/**
 * Projection from a hydrated V1 snapshot.
 *
 * Reads the V1 snapshot's OWN shape (`category`, `subtype`, `brand.value`,
 * `colors.primary`, `material[]`, …) — not the raw `scan-identify` response shape
 * it was originally built from. Those are different structures, and reading the
 * wrong one is how a perfectly good historical scan projects to all-nulls.
 *
 * `confidence.overall` is deliberately NOT carried. A V1 snapshot has one global
 * number and the V2-shaped world has five per-dimension ones; mapping one into
 * that shape is either dropping four or inventing four. Omitting it keeps the
 * projection honest about being a different, coarser contract.
 */
export function projectLegacySnapshot(snapshot: unknown): EliseLegacyProjection {
  const record = isRecord(snapshot) ? snapshot : {};
  const brand = isRecord(record.brand) ? record.brand : {};
  const colors = isRecord(record.colors) ? record.colors : {};
  return {
    contractVersion: ELISE_LEGACY_PROJECTION_V1,
    category: nullableString(record.category),
    subtype: nullableString(record.subtype),
    brand: nullableString(brand.value),
    primaryColor: nullableString(colors.primary),
    secondaryColors: stringList(colors.secondary),
    material: stringList(record.material),
    silhouette: stringList(record.silhouette),
    pattern: stringList(record.pattern),
    summary: nullableString(record.unknownReason),
  };
}

/** Projection from a raw saved-scan-shaped record with no usable snapshot. */
export function projectLegacyRecord(record: unknown): EliseLegacyProjection {
  const scan = isRecord(record) ? record : {};
  const attributes = isRecord(scan.attributes) ? scan.attributes : {};
  const analysis = isRecord(scan.analysis) ? scan.analysis : {};
  const metadata = isRecord(analysis.metadata) ? analysis.metadata : {};
  return {
    contractVersion: ELISE_LEGACY_PROJECTION_V1,
    category:
      nullableString(metadata.category) ??
      nullableString(metadata.displayCategory) ??
      nullableString(attributes.category),
    subtype: nullableString(metadata.subtype),
    brand: nullableString(metadata.brand) ?? nullableString(attributes.brand),
    primaryColor: nullableString(metadata.color) ?? nullableString(attributes.color),
    secondaryColors: [],
    material: [nullableString(metadata.material) ?? nullableString(metadata.materialEstimate)]
      .filter((entry): entry is string => typeof entry === 'string'),
    silhouette: [nullableString(metadata.silhouette)]
      .filter((entry): entry is string => typeof entry === 'string'),
    pattern: [nullableString(metadata.pattern)]
      .filter((entry): entry is string => typeof entry === 'string'),
    summary: nullableString(analysis.result) ?? nullableString(scan.result),
  };
}

/**
 * True when a legacy projection carries at least one real fact.
 *
 * An all-null projection must not become an attachment that claims to have been
 * understood; the caller shows its existing missing-detail state instead.
 */
export function hasLegacyEvidence(projection: EliseLegacyProjection | null | undefined): boolean {
  if (!projection) return false;
  return Boolean(
    projection.category ||
    projection.subtype ||
    projection.brand ||
    projection.primaryColor ||
    projection.secondaryColors.length ||
    projection.material.length ||
    projection.silhouette.length ||
    projection.pattern.length ||
    projection.summary,
  );
}

/**
 * Wraps one reused V2 identity as a canonical single-item context.
 *
 * `source` is preserved rather than normalized to a generic value: whether the
 * identity came from a Recent Scan or a live Scanner handoff changes how the
 * model should talk about provenance ("a piece you scanned earlier" is a
 * different claim from "the piece you just scanned").
 */
export function contextFromReusedV2(
  source: Extract<EliseFashionContextSource, 'recent_scan' | 'scanner_handoff'>,
  identification: FashionIdentificationResultV2,
): EliseFashionContextV2 | null {
  // Delegates to the one builder, so a reused identity is validated and projected
  // by exactly the same code as a freshly identified one. Constructing the context
  // literal here would be a second construction path that could drift.
  //
  // The item state PRESERVES the identification's own uncertainty: a partial
  // result reused from a Scanner handoff is still partial. Hardcoding `ready`
  // here would strip the "some details were not confirmed" honesty the rest of
  // the pipeline maintains for freshly identified images. A stored result in
  // any non-groundable terminal status is not reusable as grounding at all.
  const state = identification.status === 'partial'
    ? 'partial'
    : identification.status === 'completed'
      ? 'ready'
      : null;
  if (!state) return null;
  return buildEliseFashionContextV2({
    source,
    items: [{ sourceIndex: 0, state, identification }],
  });
}
