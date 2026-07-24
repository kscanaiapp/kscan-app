import type {
  ActiveContextInput,
  ActiveContextSource,
  ActiveContextVisualCollection,
} from './activeContext.ts';

export type NormalizedVisualSourceType =
  | 'current_scan'
  | 'selected_scan_item'
  | 'text_scan'
  | 'recent_scan'
  | 'closet_item'
  | 'owned_room_item'
  | 'shared_room_item'
  | 'commerce_product'
  | 'unknown_legacy';

export type ActorRelationship = 'owned' | 'shared' | 'scanned' | 'discovered' | 'unknown';
export type SessionScope = 'current_session' | 'recent' | 'durable' | 'shared' | 'commerce' | 'unknown';
export type ImageReferenceType = 'none' | 'verified_storage' | 'expired_reference' | 'unknown';

export interface NormalizedVisualContextItem {
  sourceType: NormalizedVisualSourceType;
  sourceId: string;
  actorRelationship: ActorRelationship;
  sessionScope: SessionScope;
  title: string;
  summary?: string | null;
  category?: string | null;
  colors?: string[] | null;
  materials?: string[] | null;
  silhouette?: string | null;
  styleAttributes?: string[] | null;
  brand?: string | null;
  confidence?: number | null;
  imageReferenceType: ImageReferenceType;
  commerceReference?: string | null;
}

export interface NormalizedVisualContext {
  items: NormalizedVisualContextItem[];
  rejectedCount: number;
  activeContext: ActiveContextInput | null;
}

const MAX_ITEMS = 6;
const MAX_ID_CHARS = 80;
const MAX_TITLE_CHARS = 160;
const MAX_SUMMARY_CHARS = 500;
const MAX_FIELD_CHARS = 160;
const MAX_ARRAY_ITEMS = 8;
const MAX_ARRAY_ITEM_CHARS = 80;
const VALID_ACTIVE_SOURCES: ActiveContextSource[] = ['camera', 'upload', 'text-scan'];
const RAW_REFERENCE_RE = /(?:file|content):\/\/|data:image\/|;base64|https?:\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeText(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\[\]<>`]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized || RAW_REFERENCE_RE.test(normalized)) return null;
  return normalized.slice(0, maxChars);
}

function normalizeStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values = value
    .slice(0, MAX_ARRAY_ITEMS)
    .map((item) => normalizeText(item, MAX_ARRAY_ITEM_CHARS))
    .filter((item): item is string => Boolean(item));
  return values.length ? values : null;
}

function normalizeSourceType(raw: Record<string, unknown>, activeSource: ActiveContextSource): NormalizedVisualSourceType {
  const text = String(raw.sourceType ?? raw.source ?? '').toLowerCase();
  if (text === 'selected_scan_item') return 'selected_scan_item';
  if (text === 'text_scan' || activeSource === 'text-scan') return 'text_scan';
  if (text === 'recent_scan') return 'recent_scan';
  if (text === 'closet_item' || text === 'saved_scan' || text === 'inspiration_item') return 'closet_item';
  if (text === 'owned_room_item') return 'owned_room_item';
  if (text === 'shared_room_item') return 'shared_room_item';
  if (text === 'commerce_product' || text === 'product_match') return 'commerce_product';
  if (text === 'scan' || activeSource === 'camera') return 'current_scan';
  return 'unknown_legacy';
}

/**
 * Actor relationship is derived only from sourceType heuristics.
 * Client-supplied actorRelationship / owned / relationship fields are ignored.
 * Closet and owned-room ownership require server verification (E-1+); until then
 * they remain `unknown` so client claims cannot establish ownership.
 */
function relationshipFor(sourceType: NormalizedVisualSourceType): ActorRelationship {
  if (sourceType === 'commerce_product') return 'discovered';
  if (sourceType === 'text_scan') return 'discovered';
  if (sourceType === 'shared_room_item') return 'shared';
  if (
    sourceType === 'current_scan' ||
    sourceType === 'selected_scan_item' ||
    sourceType === 'recent_scan'
  ) {
    return 'scanned';
  }
  // closet_item / owned_room_item: never owned from client metadata alone
  return 'unknown';
}

function scopeFor(sourceType: NormalizedVisualSourceType): SessionScope {
  if (sourceType === 'commerce_product') return 'commerce';
  if (sourceType === 'shared_room_item') return 'shared';
  if (sourceType === 'recent_scan') return 'recent';
  if (sourceType === 'closet_item' || sourceType === 'owned_room_item') return 'durable';
  if (sourceType === 'current_scan' || sourceType === 'selected_scan_item' || sourceType === 'text_scan') {
    return 'current_session';
  }
  return 'unknown';
}

function parseConfidence(value: unknown): number | null | false {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return false;
  return value;
}

function imageReferenceType(raw: Record<string, unknown>): ImageReferenceType {
  // Client cannot establish verified_storage. Signed/ephemeral URLs are never canonical.
  if (raw.imageUri || raw.url || raw.signedUrl || raw.base64) return 'expired_reference';
  const text = String(raw.imageReferenceType ?? '').toLowerCase();
  if (text === 'verified_storage') return 'unknown';
  if (text === 'expired_reference') return 'expired_reference';
  return 'none';
}

function parseItem(raw: unknown, activeSource: ActiveContextSource, index: number): NormalizedVisualContextItem | null {
  if (!isRecord(raw)) return null;
  const title = normalizeText(raw.title, MAX_TITLE_CHARS);
  if (!title) return null;
  const confidence = parseConfidence(raw.confidence);
  if (confidence === false) return null;
  const sourceType = normalizeSourceType(raw, activeSource);
  return {
    sourceType,
    sourceId: normalizeText(raw.id ?? raw.sourceId, MAX_ID_CHARS) ?? `legacy-visual-${index + 1}`,
    actorRelationship: relationshipFor(sourceType),
    sessionScope: scopeFor(sourceType),
    title,
    summary: normalizeText(raw.summary, MAX_SUMMARY_CHARS),
    category: normalizeText(raw.category, MAX_FIELD_CHARS),
    colors: normalizeStringArray(raw.colors),
    materials: normalizeStringArray(raw.materials),
    silhouette: normalizeText(raw.silhouette, MAX_FIELD_CHARS),
    styleAttributes: normalizeStringArray(raw.styleAttributes),
    brand: normalizeText(raw.brand, MAX_FIELD_CHARS),
    confidence,
    imageReferenceType: imageReferenceType(raw),
    commerceReference: sourceType === 'commerce_product'
      ? normalizeText(raw.commerceReference ?? raw.productId, MAX_ID_CHARS)
      : null,
  };
}

function extractCandidates(raw: Record<string, unknown>): unknown[] {
  const collection = isRecord(raw.visualCollection) ? raw.visualCollection : null;
  if (collection && Array.isArray(collection.evidence)) return collection.evidence;
  if (isRecord(raw.visualContext)) return [raw.visualContext];
  return [];
}

export function normalizeLegacyVisualContext(raw: unknown): NormalizedVisualContext {
  if (!isRecord(raw)) return { items: [], rejectedCount: 0, activeContext: null };
  const source = typeof raw.source === 'string' && VALID_ACTIVE_SOURCES.includes(raw.source as ActiveContextSource)
    ? raw.source as ActiveContextSource
    : 'camera';

  const candidates = extractCandidates(raw).slice(0, MAX_ITEMS);
  const items: NormalizedVisualContextItem[] = [];
  let rejectedCount = Math.max(0, extractCandidates(raw).length - candidates.length);
  candidates.forEach((candidate, index) => {
    const item = parseItem(candidate, source, index);
    if (item) items.push(item);
    else rejectedCount += 1;
  });

  const evidence = items.map((item, index) => ({
    id: item.sourceId,
    order: index + 1,
    source: item.sourceType === 'current_scan' || item.sourceType === 'selected_scan_item' ? 'scan' as const : 'upload' as const,
    title: item.title,
    summary: item.summary,
    category: item.category,
    colors: item.colors,
    materials: item.materials,
    silhouette: item.silhouette,
    styleAttributes: item.styleAttributes,
    brand: item.brand,
    confidence: item.confidence,
  }));

  const visualCollection: ActiveContextVisualCollection | null = evidence.length
    ? { evidence, focusEvidenceId: evidence[0].id }
    : null;

  const activeContext: ActiveContextInput | null =
    visualCollection ||
    normalizeText(raw.query ?? raw.analysisText, 500) ||
    normalizeText(raw.category, MAX_FIELD_CHARS)
      ? {
          source,
          query: normalizeText(raw.query, 500),
          category: normalizeText(raw.category, MAX_FIELD_CHARS),
          color: normalizeText(raw.color, MAX_FIELD_CHARS),
          silhouette: normalizeText(raw.silhouette, MAX_FIELD_CHARS),
          material: normalizeText(raw.material, MAX_FIELD_CHARS),
          descriptors: normalizeStringArray(raw.descriptors),
          analysisText: normalizeText(raw.analysisText, 500),
          visualCollection,
          visualContext: null,
        }
      : null;

  return { items, rejectedCount, activeContext };
}
