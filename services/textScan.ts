/**
 * TextScan normalization and validation utilities.
 *
 * Centralizes all transformation of raw backend responses into frontend-safe
 * TextScan state. No raw backend casing leaks into view components.
 */

import type { TextScanDemoAttributes } from '../data/textscan-demo';

export type TextScanResultType = 'fashion_text' | 'non_fashion_text';

export interface TextScanAttributes {
  category?: string | null;
  itemType?: string | null;
  color?: string | null;
  colorPalette?: string[];
  material?: string | null;
  materialEstimate?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  texture?: string | null;
  occasion?: string | null;
  styleDescriptors?: string[];
  styleTags?: string[];
  confidenceScore?: number | null;
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
  products: [];
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

function isCompletedType(type: unknown): boolean {
  return typeof type === 'string' && type.toLowerCase() === 'completed';
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

function safeAttributes(raw: unknown): TextScanAttributes {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const src = raw as Record<string, unknown>;

  // Map backend metadata fields to TextScan attributes
  // Backend may return metadata.category, metadata.color, etc.
  // Or it may return attributes directly.
  const sourceAttrs =
    src.attributes && typeof src.attributes === 'object' && !Array.isArray(src.attributes)
      ? (src.attributes as Record<string, unknown>)
      : src;

  const colorPalette = safeArray(sourceAttrs.colorPalette);
  const styleTags = safeArray(sourceAttrs.styleTags);
  const styleDescriptors = safeArray(sourceAttrs.styleDescriptors ?? sourceAttrs.style);
  const material =
    safeString(sourceAttrs.material ?? sourceAttrs.materialEstimate ?? sourceAttrs.fabric) || null;
  const materialEstimate = safeString(sourceAttrs.materialEstimate) || material;

  return {
    category: safeString(sourceAttrs.category ?? sourceAttrs.itemType) || null,
    itemType: safeString(sourceAttrs.itemType) || null,
    color: safeString(sourceAttrs.color) || (colorPalette.length ? colorPalette.join(', ') : null),
    colorPalette,
    material,
    materialEstimate,
    silhouette: safeString(sourceAttrs.silhouette ?? sourceAttrs.fit) || null,
    pattern: safeString(sourceAttrs.pattern) || null,
    texture: safeString(sourceAttrs.texture) || null,
    occasion: safeString(sourceAttrs.occasion) || null,
    styleDescriptors: styleDescriptors.length ? styleDescriptors : styleTags,
    styleTags,
    confidenceScore: safeNumber(sourceAttrs.confidenceScore),
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

/**
 * Normalize a raw backend response into a safe TextScanResult.
 *
 * Rules:
 *   - id is always present.
 *   - type is always 'fashion_text' or 'non_fashion_text'.
 *   - metadata is always an object with attributes.
 *   - products is always [] regardless of backend data.
 *   - savedAt is always present.
 *   - Missing fields do not crash the UI.
 *   - Non-fashion responses render safely.
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
  const rawType = src.type ?? src.status;

  // Determine normalized type
  let type: TextScanResultType;
  if (isNonFashionType(rawType)) {
    type = 'non_fashion_text';
  } else if (isFashionType(rawType) || isCompletedType(rawType)) {
    type = 'fashion_text';
  } else {
    // Fallback: if backend has metadata with category/color, treat as fashion
    const meta = src.metadata ?? src.attributes ?? src;
    const hasAttrs =
      !!(
        meta &&
        typeof meta === 'object' &&
        !Array.isArray(meta) &&
        ((meta as Record<string, unknown>).category ||
          (meta as Record<string, unknown>).itemType ||
          (meta as Record<string, unknown>).color ||
          (meta as Record<string, unknown>).colorPalette ||
          (meta as Record<string, unknown>).materialEstimate ||
          (meta as Record<string, unknown>).silhouette)
      );
    type = hasAttrs ? 'fashion_text' : 'non_fashion_text';
  }

  const metadata = safeMetadata(src.metadata ?? src.attributes ?? src, query);
  const result = safeString(src.result ?? src.message ?? src.userMessage) || NON_FASHION_COPY;
  const confidence = safeNumber(src.confidence ?? metadata.attributes.confidenceScore);

  return {
    id: safeString(src.id) || generateId(),
    type,
    result,
    metadata,
    products: [], // Always forced empty in this sprint
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
