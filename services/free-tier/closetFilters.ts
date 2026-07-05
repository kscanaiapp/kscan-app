/**
 * Free Tier Utility Expansion — closet filters (pure functions, local only).
 */

import type {
  CareNoteEntry,
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
  WishlistIntentEntry,
} from './wardrobeUtilityTypes';

export type ClosetFilterId =
  | 'all'
  | 'recent'
  | 'category'
  | 'color'
  | 'season'
  | 'occasion'
  | 'most_worn'
  | 'highest_rated'
  | 'needs_care'
  | 'wishlist'
  | 'wear_again';

export const CLOSET_FILTERS: Array<{ id: ClosetFilterId; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'recent', label: 'Recently saved' },
  { id: 'category', label: 'Category' },
  { id: 'color', label: 'Color' },
  { id: 'season', label: 'Season' },
  { id: 'occasion', label: 'Occasion' },
  { id: 'most_worn', label: 'Most worn' },
  { id: 'highest_rated', label: 'Highest rated' },
  { id: 'needs_care', label: 'Needs care' },
  { id: 'wishlist', label: 'Wishlist' },
  { id: 'wear_again', label: 'Would wear again' },
];

export interface ClosetFilterContext {
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
  care?: Record<string, CareNoteEntry>;
  wishlist?: Record<string, WishlistIntentEntry>;
  /** For 'category' | 'color' | 'season' | 'occasion' filters. */
  value?: string;
}

const CARE_ATTENTION_TAGS = new Set(['Repair needed', 'Needs cleaning', 'Tailor', 'Dry clean']);

export function applyClosetFilter(
  items: NormalizedItem[],
  filterId: ClosetFilterId,
  ctx?: ClosetFilterContext
): NormalizedItem[] {
  const safeItems = Array.isArray(items) ? items : [];
  const value = ctx?.value?.toLowerCase();
  switch (filterId) {
    case 'all':
      return safeItems;
    case 'recent':
      return [...safeItems].sort((a, b) => (b.savedAt ?? '').localeCompare(a.savedAt ?? ''));
    case 'category':
      return value
        ? safeItems.filter((i) => i.category?.toLowerCase().includes(value))
        : safeItems;
    case 'color':
      return value
        ? safeItems.filter((i) => i.color?.toLowerCase().includes(value))
        : safeItems;
    case 'season':
      return value
        ? safeItems.filter((i) =>
            (i.seasonTags ?? []).some((t) => t.toLowerCase().includes(value))
          )
        : safeItems;
    case 'occasion':
      return value
        ? safeItems.filter((i) =>
            (i.occasionTags ?? []).some((t) => t.toLowerCase().includes(value))
          )
        : safeItems;
    case 'most_worn':
      return [...safeItems]
        .filter((i) => (ctx?.wear?.[i.id]?.wearCount ?? 0) > 0)
        .sort((a, b) => (ctx?.wear?.[b.id]?.wearCount ?? 0) - (ctx?.wear?.[a.id]?.wearCount ?? 0));
    case 'highest_rated':
      return [...safeItems]
        .filter((i) => typeof ctx?.feedback?.[i.id]?.rating === 'number')
        .sort((a, b) => (ctx?.feedback?.[b.id]?.rating ?? 0) - (ctx?.feedback?.[a.id]?.rating ?? 0));
    case 'needs_care':
      return safeItems.filter((i) =>
        (ctx?.care?.[i.id]?.tags ?? []).some((t) => CARE_ATTENTION_TAGS.has(t))
      );
    case 'wishlist':
      return safeItems.filter((i) => {
        const intent = ctx?.wishlist?.[i.id]?.intent;
        return intent === 'wishlist' || intent === 'want_similar' || intent === 'compare_later';
      });
    case 'wear_again':
      return safeItems.filter((i) =>
        (ctx?.feedback?.[i.id]?.tags ?? []).includes('Would wear again')
      );
    default:
      return safeItems;
  }
}
