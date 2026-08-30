// The READ-ONLY committed Closet projection (Closet Upgrade Build 2, Phase 3.5).
//
// WHAT THIS IS: the shape a screen may render a committed Closet item in. It
// exposes the structured taxonomy the record now stores, and it DROPS the fields
// that exist for the service layer only.
//
// WHAT IT IS NOT, and the invariant it exists to hold:
//
//     projection  !=  a write model
//
// Nothing here persists, mutates or re-derives storage. It takes a record that
// services/closetLibrary.js already reconstructed and returns a new object.
//
// PROVENANCE STAYS INTERNAL. `sourceCandidateId`, the scan lineage ids and the
// client request id are how the store answers "have I already committed this" —
// they are not facts about a garment, they are not useful to a user, and a screen
// that could read them is a screen that could leak them. They are omitted here by
// construction rather than by every caller remembering not to render them.
//
// DOMAIN BOUNDARY: this is the device-local committed Closet
// (kscan_closet/kscan_closet.json). It is unrelated to types/ownedClosetItem.ts,
// which is the AI-Stylist styling contract over saved_scans and inspiration_items
// and has its own cloud-backed identity rules.

/** Taxonomy as a reader sees it. Absent values are canonical, never invented. */
export type ClosetItemTaxonomy = {
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  secondaryColors: readonly string[];
  material: readonly string[];
  size: string | null;
};

export type ClosetItemProjection = ClosetItemTaxonomy & {
  id: string;
  title: string;
  notes: string | null;
  origin: string | null;
  imageUri: string | null;
  thumbnailUri: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Category · type · subtype · colour, skipping what is absent. */
  displaySummary: string | null;
  /** True when the record carries no structured taxonomy at all. */
  taxonomyUnknown: boolean;
};

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function list(value: unknown, max: number, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const item = text(entry, max);
    if (!item) continue;
    const key = item.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Join the present taxonomy values, dropping ones already said.
 *
 * The classifier routinely returns the same word for more than one field — a
 * plain top comes back as category "top" AND subtype "top" — and joining them
 * blindly produced "top · top · black". Parts are supplied broadest-first, so
 * keeping the FIRST occurrence keeps the more specific label whenever the two
 * actually differ ("Outerwear · Bomber") and drops only the genuine repeat.
 */
function summarize(parts: readonly (string | null)[]): string | null {
  const present: string[] = [];
  const seen = new Set<string>();
  for (const part of parts) {
    if (typeof part !== 'string' || !part) continue;
    const key = part.trim().toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    present.push(part);
  }
  return present.length ? present.join(' · ') : null;
}

/**
 * Project one committed Closet record.
 *
 * A PRE-v2 RECORD PROJECTS SAFELY. Every taxonomy field is present and empty
 * rather than missing, so a consumer never has to distinguish "this build does
 * not store brands" from "this garment has no brand" — and `taxonomyUnknown`
 * says which situation it is without anybody parsing the title to guess.
 */
export function getClosetItemProjection(
  item: Record<string, unknown> | null | undefined,
): ClosetItemProjection | null {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
  const id = text(item.id, 200);
  if (!id) return null;

  const category = text(item.category, 80);
  const clothingType = text(item.clothingType, 80);
  const subtype = text(item.subtype, 80);
  const brand = text(item.brand, 120);
  const primaryColor = text(item.primaryColor, 60);
  const secondaryColors = list(item.secondaryColors, 60, 8);
  const material = list(item.material, 60, 8);
  const size = text(item.size, 40);

  return {
    id,
    title: text(item.title, 200) ?? 'Closet item',
    category,
    clothingType,
    subtype,
    brand,
    primaryColor,
    secondaryColors,
    material,
    size,
    notes: text(item.notes, 500),
    origin: text(item.origin, 40),
    imageUri: text(item.imageUri, 2000),
    thumbnailUri: text(item.thumbnailUri, 2000),
    createdAt: text(item.createdAt, 40),
    updatedAt: text(item.updatedAt, 40),
    displaySummary: summarize([category, clothingType, subtype, primaryColor]),
    taxonomyUnknown:
      !category &&
      !clothingType &&
      !subtype &&
      !brand &&
      !primaryColor &&
      !size &&
      secondaryColors.length === 0 &&
      material.length === 0,
  };
}

/** Project a list, dropping anything unprojectable. Order is preserved. */
export function getClosetItemProjections(
  items: readonly (Record<string, unknown> | null | undefined)[] | null | undefined,
): ClosetItemProjection[] {
  if (!Array.isArray(items)) return [];
  const out: ClosetItemProjection[] = [];
  for (const item of items) {
    const projected = getClosetItemProjection(item);
    if (projected) out.push(projected);
  }
  return out;
}

/** Fields the projection must never expose. Asserted by test, not by habit. */
export const CLOSET_ITEM_INTERNAL_FIELDS = Object.freeze([
  'sourceCandidateId',
  'sourceLineageId',
  'sourceLocalScanId',
  'sourceSavedScanId',
  'clientRequestId',
  'ownerId',
  'schemaVersion',
]);
