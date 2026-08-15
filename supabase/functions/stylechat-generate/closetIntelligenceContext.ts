/**
 * Request-scoped committed-Closet context for S7.
 *
 * The committed Closet is intentionally device-local. `saved_scans` is Recent
 * Scan history and must never be reclassified as owned inventory. The mobile
 * client therefore sends a bounded, metadata-only projection of the current
 * actor partition on each StyleChat request. This parser is the server trust
 * boundary: exact keys, bounded values, opaque request-local refs, no media,
 * commerce, local ids, ownership ids, or deletion markers.
 */

export const CLOSET_INTELLIGENCE_CONTEXT_VERSION = 'closet_intelligence_context_v1';
export const CLOSET_INTELLIGENCE_CONTEXT_MAX_ITEMS = 40;

export type ClosetInventoryState = 'complete' | 'partial' | 'unavailable';

export type ParsedClosetIntelligenceContext = {
  contractVersion: typeof CLOSET_INTELLIGENCE_CONTEXT_VERSION;
  inventoryState: ClosetInventoryState;
  items: Record<string, unknown>[];
};

export type ClosetIntelligenceContextParseResult =
  | { ok: true; context: ParsedClosetIntelligenceContext }
  | { ok: false; code: 'CLOSET_CONTEXT_INVALID' | 'CLOSET_CONTEXT_UNSUPPORTED' };

const CONTEXT_KEYS = new Set(['contractVersion', 'inventoryState', 'items']);
const ITEM_KEYS = new Set([
  'ref',
  'title',
  'category',
  'clothingType',
  'subtype',
  'brand',
  'primaryColor',
  'secondaryColors',
  'materials',
]);
const REF_RE = /^closet_[1-9][0-9]?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return value as null | undefined;
  if (typeof value !== 'string') return undefined;
  const cleaned = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned ? cleaned.slice(0, max) : null;
}

function list(value: unknown, max: number, limit: number): string[] | null {
  if (!Array.isArray(value) || value.length > limit) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    const cleaned = text(entry, max);
    if (typeof cleaned !== 'string' || !cleaned) return null;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
  }
  return out;
}

function parseItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ITEM_KEYS)) return null;
  if (typeof value.ref !== 'string' || !REF_RE.test(value.ref)) return null;

  const scalarBounds: Record<string, number> = {
    title: 160,
    category: 80,
    clothingType: 80,
    subtype: 80,
    brand: 120,
    primaryColor: 60,
  };
  const item: Record<string, unknown> = {
    ref: value.ref,
    __closet_context_authorized: true,
  };
  for (const [key, max] of Object.entries(scalarBounds)) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    const cleaned = text(value[key], max);
    if (cleaned === undefined) return null;
    item[key] = cleaned;
  }

  if (Object.prototype.hasOwnProperty.call(value, 'secondaryColors')) {
    const colors = list(value.secondaryColors, 60, 8);
    if (!colors) return null;
    item.secondaryColors = colors;
  }
  if (Object.prototype.hasOwnProperty.call(value, 'materials')) {
    const materials = list(value.materials, 60, 8);
    if (!materials) return null;
    item.materials = materials;
  }
  return item;
}

export function parseClosetIntelligenceContext(
  value: unknown,
): ClosetIntelligenceContextParseResult {
  if (!isRecord(value) || !hasOnlyKeys(value, CONTEXT_KEYS)) {
    return { ok: false, code: 'CLOSET_CONTEXT_INVALID' };
  }
  if (value.contractVersion !== CLOSET_INTELLIGENCE_CONTEXT_VERSION) {
    return { ok: false, code: 'CLOSET_CONTEXT_UNSUPPORTED' };
  }
  if (
    value.inventoryState !== 'complete' &&
    value.inventoryState !== 'partial' &&
    value.inventoryState !== 'unavailable'
  ) {
    return { ok: false, code: 'CLOSET_CONTEXT_INVALID' };
  }
  if (!Array.isArray(value.items) || value.items.length > CLOSET_INTELLIGENCE_CONTEXT_MAX_ITEMS) {
    return { ok: false, code: 'CLOSET_CONTEXT_INVALID' };
  }
  if (value.inventoryState === 'unavailable' && value.items.length > 0) {
    return { ok: false, code: 'CLOSET_CONTEXT_INVALID' };
  }

  const items: Record<string, unknown>[] = [];
  const refs = new Set<string>();
  for (const raw of value.items) {
    const item = parseItem(raw);
    if (!item || typeof item.ref !== 'string' || refs.has(item.ref)) {
      return { ok: false, code: 'CLOSET_CONTEXT_INVALID' };
    }
    refs.add(item.ref);
    items.push(item);
  }

  return {
    ok: true,
    context: {
      contractVersion: CLOSET_INTELLIGENCE_CONTEXT_VERSION,
      inventoryState: value.inventoryState,
      items,
    },
  };
}

