export const STYLE_MEMORY_MIN_SIGNAL_COUNT = 3;
export const STYLE_MEMORY_STRONG_SIGNAL_COUNT = 5;
export const STYLE_MEMORY_MAX_PASSIVE_CONFIDENCE = 0.85;
export const STYLE_MEMORY_CACHE_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours
export const STYLE_MEMORY_MAX_SOURCE_REFS = 50;
export const STYLE_MEMORY_MAX_CACHE_ENTRIES = 5;
export const STYLE_MEMORY_MAX_SIGNAL_ITEMS = 5;

export const STYLE_MEMORY_POSITIVE_REACTION_TYPES = [
  'like',
  'love',
  'favorite',
  'looking',
] as const;

export const STYLE_MEMORY_NEGATIVE_REACTION_TYPES = ['thumbs_down'] as const;

// Signals with a confirmed source table and field in the current schema.
export const STYLE_MEMORY_IMPLEMENTED_SIGNALS = [
  'brand_preference',
  'category_preference',
  'color_preference',
  'budget_signal',
  'dressing_room_positive_feedback',
] as const;

// Signals that could not be implemented safely in v0.3.1.
export const STYLE_MEMORY_MISSING_SIGNALS = [
  'silhouette_preference - only in scan snapshot_payload.metadata.silhouette (JSONB), no top-level indexed column',
  'style_tag_preference - no style tags table or structured tag field found',
  'formality - no formality field in any table',
  'dressing_room_negative_feedback - thumbs_down exists, but v0.3.1 excludes it from positive memory instead of inferring avoidances',
] as const;

// 0.0-1.0 confidence scale derived from passive signal count alone.
// Count-only confidence never reaches 1.0.
// Explicit user actions may be assigned higher values by the writer.
export function confidenceFromCount(count: number): number {
  if (count <= 0) return 0;
  if (count === 1) return 0.2;
  if (count === 2) return 0.4;
  if (count >= 3 && count < 5) return 0.6;
  return STYLE_MEMORY_MAX_PASSIVE_CONFIDENCE;
}
