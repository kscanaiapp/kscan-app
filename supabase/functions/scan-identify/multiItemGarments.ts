const MAX_GARMENTS = 5;
const MAX_STRING_LEN = 120;
const MAX_VISUAL_OBSERVATION_LEN = 200;
const MAX_ARRAY_ITEMS = 12;

const STRING_IDENTIFICATION_KEYS = [
  'visual_observation',
  'item_type',
  'subtype',
  'primary_color',
  'pattern',
  'material_estimate',
  'silhouette',
  'fit',
  'length',
  'sleeve_length',
  'neckline_or_lapel',
  'closure',
  'visible_brand_text',
  'brand_guess',
  'scan_quality_note',
] as const;

const ARRAY_IDENTIFICATION_KEYS = [
  'secondary_colors',
  'distinctive_features',
  'style_tags',
  'occasion_tags',
  'search_queries',
  'styling_suggestions',
] as const;

const BOOLEAN_IDENTIFICATION_KEYS = ['logo_detected', 'non_fashion'] as const;

export type SanitizedDetectedGarment = {
  candidateId: string;
  order: number;
  label: string;
  category: string;
  subtype: string;
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  confidenceScore?: number;
  attributes: Record<string, unknown>;
  identification: Record<string, unknown>;
};

function cleanBounds(value: unknown): SanitizedDetectedGarment['bounds'] | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const src = value as Record<string, unknown>;
  const numbers = ['x', 'y', 'width', 'height'].map((key) => {
    const raw = src[key];
    return typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  });
  if (!numbers.every(Number.isFinite)) return undefined;

  const x = Math.max(0, Math.min(1, numbers[0]));
  const y = Math.max(0, Math.min(1, numbers[1]));
  const width = Math.max(0.01, Math.min(1 - x, numbers[2]));
  const height = Math.max(0.01, Math.min(1 - y, numbers[3]));
  return { x, y, width, height };
}

function cleanString(value: unknown, max = MAX_STRING_LEN): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, max);
}

function cleanArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .map((item) => cleanString(item))
    .filter((item): item is string => Boolean(item))
    .slice(0, MAX_ARRAY_ITEMS);
  return out.length ? out : undefined;
}

function cleanConfidence(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

function cleanBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  return undefined;
}

function slugPart(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);
  return slug || 'garment';
}

function sanitizeIdentification(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of STRING_IDENTIFICATION_KEYS) {
    const max = key === 'visual_observation' ? MAX_VISUAL_OBSERVATION_LEN : MAX_STRING_LEN;
    const value = cleanString(src[key], max);
    if (value) out[key] = value;
  }
  for (const key of ARRAY_IDENTIFICATION_KEYS) {
    const value = cleanArray(src[key]);
    if (value) out[key] = value;
  }
  for (const key of BOOLEAN_IDENTIFICATION_KEYS) {
    const value = cleanBoolean(src[key]);
    if (value !== undefined) out[key] = value;
  }
  const confidence = cleanConfidence(src.confidence_score);
  if (confidence !== undefined) out.confidence_score = confidence;

  return Object.keys(out).length ? out : undefined;
}

function attributesFromIdentification(identification: Record<string, unknown>): Record<string, unknown> {
  const category = cleanString(identification.item_type) ?? 'unknown';
  const subtype = cleanString(identification.subtype) ?? category;
  const primaryColor = cleanString(identification.primary_color);
  const secondaryColors = cleanArray(identification.secondary_colors);
  const colors = primaryColor ? [primaryColor, ...(secondaryColors ?? [])] : (secondaryColors ?? []);
  const confidence = cleanConfidence(identification.confidence_score);

  const attributes: Record<string, unknown> = {
    category,
    itemType: subtype,
  };
  const silhouette = cleanString(identification.silhouette);
  const material = cleanString(identification.material_estimate);
  const pattern = cleanString(identification.pattern);
  const styleTags = cleanArray(identification.style_tags);
  const occasionTags = cleanArray(identification.occasion_tags);

  if (silhouette) attributes.silhouette = silhouette;
  if (colors.length) attributes.colorPalette = colors;
  if (material) attributes.materialEstimate = material;
  if (pattern) attributes.pattern = pattern;
  if (styleTags) attributes.styleTags = styleTags;
  if (occasionTags?.length) attributes.occasion = occasionTags[0];
  if (confidence !== undefined) attributes.confidenceScore = confidence;

  return attributes;
}

function sanitizeGarment(raw: unknown, index: number): SanitizedDetectedGarment | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const identification = sanitizeIdentification(src.identification ?? src);
  if (!identification) return undefined;

  const category = cleanString(src.category) ?? cleanString(identification.item_type) ?? 'unknown';
  const subtype = cleanString(src.subtype) ?? cleanString(identification.subtype) ?? category;
  if (category === 'unknown' && subtype === 'unknown') return undefined;

  const attributes = attributesFromIdentification({
    ...identification,
    item_type: category,
    subtype,
  });
  const confidence = cleanConfidence(src.confidenceScore) ?? cleanConfidence(identification.confidence_score);
  const bounds = cleanBounds(src.bounds ?? src.boundingBox ?? src.bounding_box);
  if (!bounds) return undefined;
  const label =
    cleanString(src.label) ??
    ([cleanString(identification.primary_color), subtype].filter(Boolean).join(' ') || subtype);
  const candidateId = `garment-${index + 1}-${slugPart(category)}-${slugPart(subtype)}`;

  return {
    candidateId,
    order: index,
    label,
    category,
    subtype,
    bounds,
    ...(confidence !== undefined ? { confidenceScore: confidence } : {}),
    attributes,
    identification: {
      ...identification,
      item_type: category,
      subtype,
      ...(confidence !== undefined ? { confidence_score: confidence } : {}),
    },
  };
}

export function sanitizeDetectedGarments(raw: unknown): SanitizedDetectedGarment[] {
  if (!Array.isArray(raw)) return [];
  const out: SanitizedDetectedGarment[] = [];
  for (const item of raw) {
    const sanitized = sanitizeGarment(item, out.length);
    if (sanitized) out.push(sanitized);
    if (out.length >= MAX_GARMENTS) break;
  }
  return out;
}

export function rawDetectedGarmentCount(raw: unknown): number {
  return Array.isArray(raw) ? raw.length : 0;
}
