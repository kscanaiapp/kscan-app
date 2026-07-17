// scan-identify — Phase 4 multi-item garment sanitization.
//
// Pure, side-effect-free sanitizer for the additive `garments` field returned
// by MULTI_ITEM_IDENTIFY_PROMPT. Kept in its own module (no `Deno.serve`, no
// network calls) so it can be unit-tested directly without booting the Edge
// Function's server. Mirrors the allowlist/cap discipline already used for
// `attributes`/`identification` in index.ts.

const MAX_STRING_LEN = 120;

// Mirrors MAX_OUTFIT_DETECTION_ITEMS in services/outfitConfirmation/contracts.ts.
// Kept as a local literal so this Edge Function does not import client code.
export const MAX_DETECTED_GARMENTS = 5;

const GARMENT_STRING_KEYS = ['category', 'subtype', 'silhouette'] as const;

function safeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const t = value.replace(/\s+/g, ' ').trim();
  if (!t) return undefined;
  return t.slice(0, MAX_STRING_LEN);
}

function safeConfidence(value: unknown): number | undefined {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(1, n));
}

/**
 * Sanitize a single raw garment entry from a multiItemDetection response.
 * Returns undefined (dropped, not fabricated) when it has no usable category.
 */
export function sanitizeGarment(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const src = raw as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  for (const key of GARMENT_STRING_KEYS) {
    const v = safeString(src[key]);
    if (v) out[key] = v;
  }
  const primaryColor = safeString(src.primary_color);
  if (primaryColor) out.primaryColor = primaryColor;
  const conf = safeConfidence(src.confidence_score);
  if (conf !== undefined) out.confidenceScore = conf;

  return out.category ? out : undefined;
}

/**
 * Bounded (<= MAX_DETECTED_GARMENTS), non-fabricating: only entries the model
 * actually returned, capped and validated — never padded to fill a count.
 */
export function sanitizeGarments(raw: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: Record<string, unknown>[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_DETECTED_GARMENTS) break;
    const sanitized = sanitizeGarment(entry);
    if (sanitized) out.push(sanitized);
  }
  return out.length ? out : undefined;
}
