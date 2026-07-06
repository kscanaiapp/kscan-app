/**
 * TextScan normalization and validation utilities.
 *
 * Centralizes all transformation of raw backend responses into frontend-safe
 * TextScan state. No raw backend casing leaks into view components.
 */

import type { TextScanDemoAttributes } from '../data/textscan-demo';

export type TextScanResultType = 'fashion_text' | 'non_fashion_text';

export type TextScanProductType = 'retail' | 'resale' | 'similar';

export interface TextScanProduct {
  id: string;
  title: string;
  source: string;
  price?: string;
  type: TextScanProductType;
  imageUrl?: string;
  productUrl?: string;
}

export interface TextScanAttributes {
  category?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  occasion?: string | null;
  styleDescriptors?: string[];
}

export interface TextScanMetadata {
  source: 'textscan';
  query: string;
  attributes: TextScanAttributes;
}

export interface TextScanResult {
  id: string;
  type: TextScanResultType;
  result: string;
  metadata: TextScanMetadata;
  products: TextScanProduct[];
  purchaseOptions?: TextScanProduct[];
  searchQueries?: string[];
  stylingSuggestions?: string[];
  confidence?: number | null;
  savedAt: string;
}

const NON_FASHION_COPY =
  "This doesn't appear to be a fashion query. Try describing a garment, style, or outfit.";

function generateId(): string {
  return `textscan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isNonFashionType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const t = type.toLowerCase().replace(/[-_]/g, '');
  return t.includes('nonfashion') || t.includes('nonfashiontext');
}

function isFashionType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  const t = type.toLowerCase().replace(/[-_]/g, '');
  return t.includes('fashion') && !isNonFashionType(type);
}

function safeString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  return '';
}

function safeArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((item) => typeof item === 'string')
      .map((item) => (item as string).trim())
      .filter(Boolean);
  }
  if (typeof value === 'string' && value.trim()) {
    return value.split(',').map((s) => s.trim()).filter(Boolean);
  }
  return [];
}

function safeNumber(value: unknown): number | null {
  if (typeof value === 'number' && isFinite(value)) {
    return Math.max(0, Math.min(1, value));
  }
  if (typeof value === 'string') {
    const n = Number(value);
    if (isFinite(n)) return Math.max(0, Math.min(1, n));
  }
  return null;
}

function firstColor(palette: unknown): string | undefined {
  if (Array.isArray(palette) && palette.length > 0 && typeof palette[0] === 'string') {
    return palette[0].trim();
  }
  return undefined;
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') {
    return value[0].trim();
  }
  return undefined;
}

function safeAttributes(raw: unknown): TextScanAttributes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const src = raw as Record<string, unknown>;

  // Legacy shape: metadata.attributes or metadata directly
  const metadata =
    src.metadata && typeof src.metadata === 'object' && !Array.isArray(src.metadata)
      ? (src.metadata as Record<string, unknown>)
      : undefined;
  const legacyAttrs = metadata?.attributes;
  const metadataDirectAttrs =
    metadata &&
    (metadata.category || metadata.color || metadata.itemType || metadata.silhouette ||
      metadata.material || metadata.materialEstimate || metadata.styleTags || metadata.styleDescriptors)
      ? metadata
      : undefined;

  // New shape: attributes at top level
  const topAttrs =
    src.attributes && typeof src.attributes === 'object' && !Array.isArray(src.attributes)
      ? (src.attributes as Record<string, unknown>)
      : undefined;

  // Rich identification shape (may supplement or replace legacy attributes)
  const identification =
    src.identification && typeof src.identification === 'object' && !Array.isArray(src.identification)
      ? (src.identification as Record<string, unknown>)
      : undefined;

  // Use the richest attribute source available; identification fills gaps.
  const base = (topAttrs ?? legacyAttrs ?? metadataDirectAttrs ?? src) as Record<string, unknown>;

  return {
    category:
      safeString(base.category ?? base.itemType ?? identification?.item_type ?? identification?.subtype) || null,
    color:
      safeString(
        base.color ?? firstColor(base.colorPalette) ?? identification?.primary_color
      ) || null,
    material:
      safeString(
        base.material ?? base.fabric ?? base.materialEstimate ?? identification?.material_estimate
      ) || null,
    silhouette:
      safeString(base.silhouette ?? base.fit ?? identification?.silhouette) || null,
    occasion:
      safeString(base.occasion ?? firstString(identification?.occasion_tags)) || null,
    styleDescriptors: safeArray(
      base.styleDescriptors ?? base.style ?? base.styleTags ?? identification?.style_tags
    ),
  };
}

function safeMetadata(raw: unknown, query: string): TextScanMetadata {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { source: 'textscan', query, attributes: {} };
  }
  const src = raw as Record<string, unknown>;
  return {
    source: 'textscan',
    query: safeString(src.query) || query,
    attributes: safeAttributes(src),
  };
}

function normalizeProductPrice(price: unknown, currency: unknown): string | undefined {
  if (typeof price === 'string') {
    const trimmed = price.trim();
    return trimmed || undefined;
  }
  if (typeof price === 'number' && Number.isFinite(price)) {
    const symbol = typeof currency === 'string' && currency.trim() ? currency.trim() : '$';
    return `${symbol}${price.toFixed(2)}`;
  }
  return undefined;
}

function classifyProductType(source?: string | null): TextScanProductType {
  const resaleNames = [
    'ebay', 'poshmark', 'depop', 'thredup', 'thred up',
    'vestiaire', 'vestiaire collective', 'therealreal', 'the realreal',
    'grailed', 'mercari', 'tradesy', 'rebag', 'fashionphile',
  ];
  const s = (source || '').toLowerCase();
  return resaleNames.some((name) => s.includes(name)) ? 'resale' : 'retail';
}

function mapRecommendedProducts(raw: unknown): TextScanProduct[] {
  if (!Array.isArray(raw)) return [];
  const products: TextScanProduct[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const p = item as Record<string, unknown>;
    const id = typeof p.id === 'string' && p.id.trim() ? p.id.trim() : undefined;
    if (!id) continue;
    const title = safeString(p.name ?? p.title ?? p.product_name) || undefined;
    if (!title) continue;
    const source = safeString(p.retailer ?? p.brand ?? p.source) || 'K Scan';
    const imageUrl = safeString(p.imageUrl ?? p.image_url) || undefined;
    const productUrl = safeString(p.purchaseUrl ?? p.productUrl ?? p.product_url ?? p.url) || undefined;
    const explicitType = typeof p.type === 'string' ? p.type.trim().toLowerCase() : '';
    products.push({
      id,
      title,
      source,
      price: normalizeProductPrice(p.price, p.currency),
      type: explicitType === 'similar' ? 'similar' : classifyProductType(source),
      imageUrl,
      productUrl,
    });
  }
  return products;
}

/**
 * Normalize a raw backend response into a safe TextScanResult.
 *
 * Rules:
 *   - id is always present.
 *   - type is always 'fashion_text' or 'non_fashion_text'.
 *   - metadata is always an object with attributes.
 *   - products are mapped from backend recommendedProducts/products when present.
 *   - purchaseOptions mirrors products for consumers expecting the camera-scan split.
 *   - savedAt is always present.
 *   - Missing fields do not crash the UI.
 *   - Non-fashion responses render safely with empty products.
 */
export function normalizeTextScanResult(
  raw: unknown,
  query: string
): TextScanResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      id: generateId(),
      type: 'non_fashion_text',
      result: NON_FASHION_COPY,
      metadata: { source: 'textscan', query, attributes: {} },
      products: [],
      confidence: 0,
      savedAt: new Date().toISOString(),
    };
  }

  const src = raw as Record<string, unknown>;
  const rawType = src.type;

  // Determine normalized type
  let type: TextScanResultType;
  if (isNonFashionType(rawType)) {
    type = 'non_fashion_text';
  } else if (isFashionType(rawType)) {
    type = 'fashion_text';
  } else {
    // Fallback: if backend has metadata with category/color, treat as fashion
    const meta = src.metadata ?? src;
    const hasAttrs =
      !!(
        meta &&
        typeof meta === 'object' &&
        !Array.isArray(meta) &&
        ((meta as Record<string, unknown>).category ||
          (meta as Record<string, unknown>).color ||
          (meta as Record<string, unknown>).silhouette)
      );
    type = hasAttrs ? 'fashion_text' : 'non_fashion_text';
  }

  const metadata = safeMetadata(src, query);
  const result = safeString(src.result ?? src.message) || NON_FASHION_COPY;
  const confidence = safeNumber(src.confidence);

  const rawProducts = src.recommendedProducts ?? src.products;
  const products = type === 'non_fashion_text' ? [] : mapRecommendedProducts(rawProducts);

  return {
    id: safeString(src.id) || generateId(),
    type,
    result: type === 'non_fashion_text' ? NON_FASHION_COPY : result,
    metadata,
    products,
    purchaseOptions: products.length > 0 ? [...products] : undefined,
    confidence: type === 'non_fashion_text' ? 0 : confidence,
    savedAt: safeString(src.savedAt) || new Date().toISOString(),
  };
}

/**
 * Convert TextScan attributes into the legacy AttributeGrid shape
 * used by the TextScan UI demo components.
 */
export function toAttributeGrid(attrs: TextScanAttributes): TextScanDemoAttributes {
  return {
    category: attrs.category ?? '—',
    silhouette: attrs.silhouette ?? '—',
    color: attrs.color ?? '—',
    material: attrs.material ?? '—',
    style: attrs.styleDescriptors?.join(', ') ?? '—',
    budget: '—', // Not computed in this sprint
  };
}

/**
 * Map a TextScanResult into the stabilized StyleMatch contract shape.
 *
 * - source is always "textscan"
 * - meta.isDemo is always false
 * - items are empty arrays (deferred)
 * - actions are disabled until product matching is wired
 * - summary is the result text (caller may truncate for HUD/audio)
 */
export function toStyleMatch(result: TextScanResult) {
  const attrs = result.metadata?.attributes ?? {};
  const styleTags = Array.isArray(attrs.styleDescriptors) ? attrs.styleDescriptors : [];
  const colorPalette = attrs.color ? [attrs.color] : [];

  return {
    id: result.id,
    source: 'textscan' as const,
    confidence: result.confidence ?? null,
    summary: result.result ?? null,
    intent: {
      style: styleTags.length ? styleTags.join(', ') : null,
      occasion: attrs.occasion ?? null,
      colors: colorPalette,
      materials: attrs.material ? [attrs.material] : [],
      silhouette: attrs.silhouette ?? null,
      keywords: styleTags,
    },
    items: {
      retail: [] as never[],
      resale: [] as never[],
      suggested: [] as never[],
    },
    actions: {
      canSave: false,
      canOpenOnPhone: false,
    },
    meta: {
      scanModeLabel: 'TextScan',
      confidenceLabel: typeof result.confidence === 'number' ? `${Math.round(result.confidence * 100)}%` : '—',
      isDemo: false,
    },
  };
}

/**
 * Frontend input validation for TextScan queries.
 *
 * Returns { valid: true } or { valid: false, message: '...' }.
 */
export function validateTextScanQuery(query: string): { valid: true } | { valid: false; message: string } {
  if (typeof query !== 'string') {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  const trimmed = query.trim();

  if (trimmed.length === 0) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  if (trimmed.length < 3) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  if (trimmed.length > 500) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  // Normalize repeated whitespace
  const normalized = trimmed.replace(/\s+/g, ' ');
  if (normalized !== trimmed) {
    // This is fine; we accept normalized whitespace
  }

  // Reject base64-like payloads
  if (/^[A-Za-z0-9+/]{40,}={0,2}$/.test(trimmed)) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  // Reject code blocks
  if (trimmed.includes('```') || trimmed.includes('`')) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  // Reject prompt injection patterns
  const injectionPatterns = [
    'ignore previous instructions',
    'system prompt',
    'developer message',
    'reveal your prompt',
    'act as another system',
    'ignore all instructions',
    'forget previous',
    'you are now',
    'new role:',
    'override instructions',
  ];
  const lower = trimmed.toLowerCase();
  for (const pattern of injectionPatterns) {
    if (lower.includes(pattern)) {
      return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
    }
  }

  // Reject email addresses
  if (/[\w.+-]+@[\w.-]+\.\w+/.test(trimmed)) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  // Reject phone numbers (US-style and international-style)
  if (/(\+?\d[\d\s-]{7,}\d)/.test(trimmed)) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  // Reject SSN-like patterns (xxx-xx-xxxx or xxx xx xxxx)
  if (/\b\d{3}[\s-]\d{2}[\s-]\d{4}\b/.test(trimmed)) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  // Reject queries with more than 30% non-alphanumeric characters
  const nonAlphaNum = (trimmed.match(/[^a-zA-Z0-9\s]/g) || []).length;
  if (nonAlphaNum / trimmed.length > 0.30) {
    return { valid: false, message: 'Invalid query format. Please describe a fashion item.' };
  }

  return { valid: true };
}
