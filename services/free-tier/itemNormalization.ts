/**
 * Free Tier Utility Expansion — normalized saved-item adapter.
 *
 * Accepts any scan result, saved library scan, product-shelf item, or
 * outfit-like object and returns a stable NormalizedItem. Null/undefined
 * safe, never throws, never mutates its input, never invents fields.
 */

import type {
  NormalizedItem,
  NormalizedItemSource,
} from './wardrobeUtilityTypes';

type AnyRecord = Record<string, unknown>;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0
  );
  return out.length > 0 ? out : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Best-effort numeric parse of a display price label like "$129.99". Estimate only. */
function priceFromLabel(value: unknown): number | undefined {
  if (typeof value !== 'string') return undefined;
  const match = value.replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/** Small deterministic hash so id-less inputs get a stable identity. */
function stableHash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function inferSource(raw: AnyRecord, hint?: NormalizedItemSource): NormalizedItemSource {
  if (hint) return hint;
  const source = asString(raw.source);
  if (source === 'scan' || source === 'camera' || source === 'upload' || source === 'fixture') {
    return 'scan';
  }
  if (source === 'library' || source === 'product' || source === 'manual') {
    return source;
  }
  if (raw.attributes && (raw as AnyRecord).createdAt) return 'library';
  if (raw.retailer || raw.productUrl) return 'product';
  return 'unknown';
}

/**
 * Normalize a single item-like object. Returns null only when the input is
 * not an object at all; otherwise always produces an item with an id.
 */
export function normalizeItem(
  input: unknown,
  sourceHint?: NormalizedItemSource
): NormalizedItem | null {
  if (typeof input !== 'object' || input === null) return null;
  const raw = input as AnyRecord;
  const attrs = (typeof raw.attributes === 'object' && raw.attributes !== null
    ? raw.attributes
    : {}) as AnyRecord;
  const meta = (typeof raw.metadata === 'object' && raw.metadata !== null
    ? raw.metadata
    : {}) as AnyRecord;

  const title = asString(raw.title) ?? asString(raw.name) ?? asString(raw.label);
  const category =
    asString(raw.category) ?? asString(attrs.category) ?? asString(meta.category);
  const color =
    asString(raw.color) ??
    asString(attrs.color_palette) ??
    asString(meta.color) ??
    asString(raw.colorPalette);
  const material =
    asString(raw.material) ??
    asString(attrs.material_estimate) ??
    asString(meta.material);
  const silhouette =
    asString(raw.silhouette) ?? asString(attrs.silhouette) ?? asString(meta.silhouette);
  const styleTags =
    asStringArray(raw.styleTags) ??
    asStringArray(attrs.style_tags) ??
    asStringArray(meta.styleTags);

  const imageUri =
    asString(raw.imageUri) ??
    asString(raw.thumbnailUri) ??
    asString(raw.imageUrl) ??
    asString(raw.thumbnail) ??
    asString(raw.scannedImage) ??
    asString(raw.capturedImage) ??
    asString(raw.productImage);

  const explicitId = asString(raw.id);
  const identity =
    explicitId ??
    'derived_' +
      stableHash(
        [title ?? '', category ?? '', color ?? '', imageUri ?? ''].join('|') || 'empty'
      );

  const item: NormalizedItem = {
    id: identity,
    title,
    brand: asString(raw.brand) ?? asString(meta.brand),
    category,
    color,
    material,
    silhouette,
    seasonTags: asStringArray(raw.seasonTags),
    occasionTags: asStringArray(raw.occasionTags),
    styleTags,
    imageUri,
    priceEstimate:
      asNumber(raw.priceEstimate) ??
      asNumber(raw.price) ??
      priceFromLabel(raw.priceLabel),
    savedAt: asString(raw.savedAt) ?? asString(raw.createdAt),
    source: inferSource(raw, sourceHint),
  };
  return item;
}

/** Normalize an array of item-like objects, dropping anything unusable. */
export function normalizeItems(
  inputs: unknown,
  sourceHint?: NormalizedItemSource
): NormalizedItem[] {
  if (!Array.isArray(inputs)) return [];
  const out: NormalizedItem[] = [];
  for (const entry of inputs) {
    const normalized = normalizeItem(entry, sourceHint);
    if (normalized) out.push(normalized);
  }
  return out;
}
