import { normalizeFashionTerm, normalizeStyleTags } from './fashionAttributes';
import type { FashionAttributes } from './fashionAttributes';

/**
 * Normalize a raw legacy attribute object into the shared FashionAttributes shape.
 * Unknown fields are ignored. Missing optional fields remain undefined.
 */
export function normalizeLegacyAttributes(raw: unknown): FashionAttributes | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;

  const out: FashionAttributes = {};

  const copyString = (key: string, sourceKeys: string[]) => {
    for (const sk of sourceKeys) {
      const v = src[sk];
      if (typeof v === 'string' && v.trim()) {
        (out as Record<string, unknown>)[key] = v.trim();
        return;
      }
    }
  };

  copyString('category', ['category', 'itemType', 'item_type']);
  copyString('subcategory', ['subcategory', 'subtype', 'itemType', 'item_type']);
  copyString('silhouette', ['silhouette', 'fit']);
  copyString('fit', ['fit', 'silhouette']);
  copyString('color', ['color', 'primary_color']);
  copyString('pattern', ['pattern']);
  copyString('materialEstimate', ['materialEstimate', 'material_estimate', 'material']);
  copyString('texture', ['texture']);

  const palette =
    Array.isArray(src.colorPalette) && src.colorPalette.length
      ? src.colorPalette
      : typeof src.color === 'string' && src.color.trim()
        ? [src.color.trim()]
        : undefined;
  if (palette) {
    const normalizedPalette = palette
      .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
      .map((c) => normalizeFashionTerm(c));
    if (normalizedPalette.length) out.colorPalette = normalizedPalette;
  }

  const rawStyleTags = Array.isArray(src.styleTags)
    ? src.styleTags
    : typeof src.style === 'string' && src.style.trim()
      ? [src.style.trim()]
      : undefined;
  const styleTags = normalizeStyleTags(rawStyleTags);
  if (styleTags.length) out.styleTags = styleTags;

  const seasonality = Array.isArray(src.seasonality)
    ? src.seasonality.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  if (seasonality.length) out.seasonality = seasonality;

  const occasionTags = Array.isArray(src.occasionTags)
    ? src.occasionTags.filter((o): o is string => typeof o === 'string' && o.trim().length > 0)
    : [];
  if (occasionTags.length) out.occasionTags = occasionTags;

  const confidence = typeof src.confidence === 'number' ? src.confidence : undefined;
  if (typeof confidence === 'number' && Number.isFinite(confidence)) {
    out.confidence = Math.max(0, Math.min(1, confidence));
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * Trim and sanitize a free-text message. Never returns the raw value if it
 * looks like a stack trace or contains internal-looking markers.
 */
export function sanitizeUserMessage(value: string | undefined | null): string | undefined {
  if (!value || typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Reject messages that look like stack traces or contain internal URLs.
  if (/^\s*at\s+/.test(trimmed) || /https?:\/\/[^\s]+/.test(trimmed) || trimmed.includes('Error:')) {
    return undefined;
  }
  return trimmed;
}
