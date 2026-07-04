/**
 * Free Tier Utility Expansion — "complete the look" pairing suggestions.
 * Rules-based, local only. Suggestions, not claims.
 */

import type { NormalizedItem, OutfitFeedbackEntry } from './wardrobeUtilityTypes';
import { bucketForCategory, colorsCompatible, isNeutralColor, type CategoryBucket } from './outfitGenerator';

export interface PairingSuggestion {
  item: NormalizedItem;
  reason: string;
}

const COMPLEMENTS: Record<CategoryBucket, CategoryBucket[]> = {
  top: ['bottom', 'outerwear', 'footwear'],
  bottom: ['top', 'outerwear', 'footwear'],
  dress: ['footwear', 'outerwear', 'accessory', 'bag'],
  outerwear: ['top', 'bottom', 'dress'],
  footwear: ['top', 'bottom', 'dress'],
  bag: ['dress', 'top', 'bottom'],
  accessory: ['dress', 'top', 'bottom'],
  other: ['top', 'bottom', 'footwear'],
};

export function suggestPairings(
  anchor: NormalizedItem | null | undefined,
  savedItems: NormalizedItem[],
  options?: { feedback?: Record<string, OutfitFeedbackEntry>; limit?: number }
): PairingSuggestion[] {
  if (!anchor || !Array.isArray(savedItems) || savedItems.length === 0) return [];
  const limit = options?.limit ?? 3;
  const feedback = options?.feedback ?? {};
  const anchorBucket = bucketForCategory(anchor.category);
  const wantedBuckets = new Set(COMPLEMENTS[anchorBucket] ?? []);

  const scored: Array<{ suggestion: PairingSuggestion; score: number }> = [];
  for (const item of savedItems) {
    if (!item || item.id === anchor.id) continue;
    const bucket = bucketForCategory(item.category);
    if (!wantedBuckets.has(bucket)) continue;
    const entry = feedback[item.id];
    const negative = (entry?.tags ?? []).some(
      (t) => t === 'Would not wear' || t === 'Not practical'
    );
    if (negative) continue;
    if (!colorsCompatible(anchor.color, item.color)) continue;

    let score = 1;
    let reason = 'Try pairing this with your saved items';
    if (isNeutralColor(item.color)) {
      score += 1;
      reason = 'Neutral piece — pairs broadly';
    }
    const occasionMatch = (anchor.occasionTags ?? []).some((t) =>
      (item.occasionTags ?? []).map((o) => o.toLowerCase()).includes(t.toLowerCase())
    );
    if (occasionMatch) {
      score += 2;
      reason = 'Matches the occasion';
    }
    if (typeof entry?.rating === 'number' && entry.rating >= 4) {
      score += 2;
      reason = 'You rated this highly before';
    }
    if ((entry?.tags ?? []).includes('Would wear again')) {
      score += 2;
      reason = 'You marked this "would wear again"';
    }
    scored.push({ suggestion: { item, reason }, score });
  }

  scored.sort((a, b) => b.score - a.score || a.suggestion.item.id.localeCompare(b.suggestion.item.id));
  return scored.slice(0, limit).map((s) => s.suggestion);
}
