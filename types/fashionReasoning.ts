// Versioned fashion-reasoning contract (AI Stylist expansion).
//
// Shared vocabulary for garment roles, outfit structures, occasions, dress
// codes, style vibes, and style recipes. The mobile app and the
// style-outfit-generate Edge Function must agree on these values; the Edge
// Function keeps a mirrored copy (supabase/functions/style-outfit-generate/
// reasoningContract.ts) and a static contract test asserts both stay in sync.
//
// Metadata-first ranking only: no graph database, no vector database, and no
// user-facing numeric scores.

export const FASHION_REASONING_CONTRACT_VERSION = '1';
export const STYLE_OUTFIT_PROMPT_VERSION = '1';

export const GARMENT_ROLES = [
  'top',
  'bottom',
  'dress',
  'jumpsuit',
  'outerwear',
  'shoes',
  'accessory',
  'bag',
  'other',
] as const;
export type GarmentRole = (typeof GARMENT_ROLES)[number];

/** Minimum credible outfit structures, expressed as required role sets. */
export const OUTFIT_STRUCTURES = [
  ['top', 'bottom', 'shoes'],
  ['top', 'bottom', 'outerwear', 'shoes'],
  ['dress', 'shoes'],
  ['dress', 'outerwear', 'shoes'],
  ['jumpsuit', 'shoes'],
] as const;

export const OUTFIT_OCCASIONS = ['casual', 'work', 'date', 'event', 'travel', 'other'] as const;
export type OutfitOccasion = (typeof OUTFIT_OCCASIONS)[number];

export const OUTFIT_DRESS_CODES = ['relaxed', 'smart_casual', 'dressy', 'formal'] as const;
export type OutfitDressCode = (typeof OUTFIT_DRESS_CODES)[number];

export const OUTFIT_SETTINGS = ['indoor', 'outdoor', 'both'] as const;
export type OutfitSetting = (typeof OUTFIT_SETTINGS)[number];

export const STYLE_VIBES = [
  'classic',
  'minimal',
  'romantic',
  'polished',
  'relaxed',
  'bold',
  'edgy',
  'sporty',
  'streetwear',
  'preppy',
  'feminine',
  'masculine',
  'neutral',
  'trend_forward',
] as const;
export type StyleVibe = (typeof STYLE_VIBES)[number];

/** Normalized style-recipe intents: "polished but relaxed" etc. */
export const STYLE_RECIPES = [
  { id: 'polished_relaxed', label: 'Polished but relaxed', vibes: ['polished', 'relaxed'] },
  { id: 'clean_minimal', label: 'Clean and minimal', vibes: ['minimal', 'classic'] },
  { id: 'bold_event', label: 'Bold but event-appropriate', vibes: ['bold', 'polished'] },
  { id: 'romantic_comfortable', label: 'Romantic but comfortable', vibes: ['romantic', 'relaxed'] },
  { id: 'casual_elevated', label: 'Casual and elevated', vibes: ['relaxed', 'polished'] },
] as const;

/** Canonical deterministic variation order for AI suggestions. */
export const OUTFIT_VARIATIONS = ['reliable', 'elevated', 'something_different'] as const;
export type OutfitVariation = (typeof OUTFIT_VARIATIONS)[number];

export const STYLE_OUTFIT_MODES = [
  'style_item',
  'style_event',
  'swap_item',
  'restyle_remaining',
] as const;
export type StyleOutfitMode = (typeof STYLE_OUTFIT_MODES)[number];

export const MIN_OUTFIT_ITEMS = 2;
export const MAX_OUTFIT_ITEMS = 6;
export const MAX_OUTFIT_SUGGESTIONS = 3;

export function isGarmentRole(value: unknown): value is GarmentRole {
  return typeof value === 'string' && (GARMENT_ROLES as readonly string[]).includes(value);
}

export function isOutfitOccasion(value: unknown): value is OutfitOccasion {
  return typeof value === 'string' && (OUTFIT_OCCASIONS as readonly string[]).includes(value);
}

export function isOutfitDressCode(value: unknown): value is OutfitDressCode {
  return typeof value === 'string' && (OUTFIT_DRESS_CODES as readonly string[]).includes(value);
}

export function isOutfitSetting(value: unknown): value is OutfitSetting {
  return typeof value === 'string' && (OUTFIT_SETTINGS as readonly string[]).includes(value);
}

export function isOutfitVariation(value: unknown): value is OutfitVariation {
  return typeof value === 'string' && (OUTFIT_VARIATIONS as readonly string[]).includes(value);
}

/**
 * Maps a free-text category (from scan metadata) to a garment role.
 * Deterministic and shared with the Edge Function mirror.
 */
export function inferGarmentRole(category?: string | null, subcategory?: string | null): GarmentRole {
  const text = `${category ?? ''} ${subcategory ?? ''}`.toLowerCase();
  if (!text.trim()) return 'other';
  if (/jumpsuit|romper|overall/.test(text)) return 'jumpsuit';
  if (/dress|gown/.test(text)) return 'dress';
  if (/jacket|coat|blazer|cardigan|parka|trench|outerwear|vest/.test(text)) return 'outerwear';
  if (/shoe|sneaker|boot|heel|loafer|sandal|flat|footwear|trainer|oxford|mule|pump/.test(text)) return 'shoes';
  if (/bag|tote|purse|backpack|clutch|handbag|crossbody/.test(text)) return 'bag';
  if (/hat|scarf|belt|jewelr|necklace|earring|bracelet|watch|sunglass|glove|accessor|tie\b|beanie|cap\b/.test(text)) return 'accessory';
  if (/pant|jean|trouser|skirt|short|legging|chino|bottom|culotte|slack/.test(text)) return 'bottom';
  if (/top|shirt|blouse|tee|t-shirt|sweater|hoodie|tank|polo|knit|pullover|sweatshirt|camisole|bodysuit|turtleneck/.test(text)) return 'top';
  return 'other';
}

/**
 * Checks that a set of roles satisfies at least one canonical outfit structure.
 * Extra roles beyond a satisfied structure (accessory, bag, other) are allowed;
 * conflicting base garments (e.g. dress + bottom) are rejected.
 */
export function satisfiesOutfitStructure(roles: GarmentRole[]): boolean {
  const roleSet = new Set(roles);
  const hasDressBase = roleSet.has('dress');
  const hasJumpsuitBase = roleSet.has('jumpsuit');
  const hasSeparatesBase = roleSet.has('top') && roleSet.has('bottom');

  if (!roleSet.has('shoes')) return false;

  // Base garments must not conflict.
  const baseCount = [hasDressBase, hasJumpsuitBase, roleSet.has('top') || roleSet.has('bottom')].filter(Boolean).length;
  if (baseCount > 1) return false;

  if (hasDressBase || hasJumpsuitBase) return true;
  return hasSeparatesBase;
}
