/**
 * Free Tier Utility Expansion — shared types + storage keys.
 * Local-first only. No backend sync. No raw images, tokens, or location.
 */

// ── Storage keys (all versioned) ─────────────────────────────────────────────
export const FREE_TIER_STORAGE_KEYS = {
  brandSizing: 'kscan.freeTier.brandSizing.v1',
  outfitFeedback: 'kscan.freeTier.outfitFeedback.v1',
  careNotes: 'kscan.freeTier.careNotes.v1',
  wishlistIntent: 'kscan.freeTier.wishlistIntent.v1',
  collections: 'kscan.freeTier.collections.v1',
  wearTracking: 'kscan.freeTier.wearTracking.v1',
  activityLog: 'kscan.freeTier.activityLog.v1',
  styleBoards: 'kscan.freeTier.styleBoards.v1',
  utilityMeta: 'kscan.freeTier.utilityMeta.v1',
} as const;

export type FreeTierStorageKey =
  (typeof FREE_TIER_STORAGE_KEYS)[keyof typeof FREE_TIER_STORAGE_KEYS];

// ── Normalized item (adapter output) ─────────────────────────────────────────
export type NormalizedItemSource =
  | 'scan'
  | 'library'
  | 'product'
  | 'manual'
  | 'unknown';

export interface NormalizedItem {
  id: string;
  title?: string;
  brand?: string;
  category?: string;
  color?: string;
  material?: string;
  silhouette?: string;
  seasonTags?: string[];
  occasionTags?: string[];
  styleTags?: string[];
  imageUri?: string;
  priceEstimate?: number;
  savedAt?: string;
  source?: NormalizedItemSource;
}

// ── Outfits ──────────────────────────────────────────────────────────────────
export interface SuggestedOutfit {
  id: string;
  title: string;
  itemIds: string[];
  items: NormalizedItem[];
  reasonLabels: string[];
  occasion?: string;
}

/** A user-saved look (stored in styleBoards.v1). Stores ids + light snapshot only. */
export interface SavedOutfit {
  id: string;
  title: string;
  itemIds: string[];
  itemSnapshots: Array<Pick<NormalizedItem, 'id' | 'title' | 'category' | 'color'>>;
  createdAt: string;
}

// ── Feedback / ratings ───────────────────────────────────────────────────────
export const OUTFIT_FEEDBACK_TAGS = [
  'Comfortable',
  'Got compliments',
  'Too tight',
  'Too loose',
  'Too bold',
  'Too plain',
  'Would wear again',
  'Would not wear',
  'Good for occasion',
  'Not practical',
] as const;

export type OutfitFeedbackTag = (typeof OUTFIT_FEEDBACK_TAGS)[number];

export interface OutfitFeedbackEntry {
  /** Item id or saved-outfit id the feedback applies to. */
  targetId: string;
  rating?: number; // 1–5
  tags: string[];
  updatedAt: string;
}

// ── Care notes ───────────────────────────────────────────────────────────────
export const CARE_NOTE_TAGS = [
  'Dry clean',
  'Hand wash',
  'Delicate',
  'Repair needed',
  'Tailor',
  'Store seasonally',
  'Needs cleaning',
  'Ready to wear',
] as const;

export type CareNoteTag = (typeof CARE_NOTE_TAGS)[number];

export interface CareNoteEntry {
  itemId: string;
  tags: string[];
  note?: string;
  updatedAt: string;
}

// ── Brand sizing memory ──────────────────────────────────────────────────────
export interface BrandSizingEntry {
  brand: string;
  usualSize?: string;
  fitNote?: string;
  runsSmall?: boolean;
  runsLarge?: boolean;
  lastUpdatedAt: string;
}

// ── Wishlist / shopping intent ───────────────────────────────────────────────
export type WishlistIntentKind =
  | 'want_similar'
  | 'wishlist'
  | 'not_interested'
  | 'own_it'
  | 'compare_later';

export interface WishlistIntentEntry {
  itemId: string;
  intent: WishlistIntentKind;
  titleSnapshot?: string;
  updatedAt: string;
}

// ── Collections / lookbooks ──────────────────────────────────────────────────
export interface OutfitCollection {
  id: string;
  name: string;
  itemIds: string[];
  coverItemId?: string;
  createdAt: string;
  updatedAt: string;
}

// ── Wear tracking / cost per wear ────────────────────────────────────────────
export interface WearTrackingEntry {
  itemId: string;
  estimatedPrice?: number;
  wearCount: number;
  lastWornAt?: string;
  updatedAt: string;
}

// ── Activity log ─────────────────────────────────────────────────────────────
export type ActivityEventType =
  | 'saved_item'
  | 'rated_outfit'
  | 'added_care_note'
  | 'added_sizing_note'
  | 'marked_worn'
  | 'created_collection'
  | 'shared_outfit'
  | 'added_wishlist_intent';

export interface ActivityEvent {
  id: string;
  type: ActivityEventType;
  label: string;
  createdAt: string;
}

// ── Duplicate detection ──────────────────────────────────────────────────────
export type DuplicateConfidence = 'low' | 'medium' | 'high';

export interface DuplicateHintResult {
  hasPossibleDuplicate: boolean;
  confidence: DuplicateConfidence;
  reasonLabels: string[];
  matchingItemIds: string[];
}

// ── Style challenges ─────────────────────────────────────────────────────────
export interface StyleChallenge {
  id: string;
  title: string;
  description: string;
}

// ── Utility meta (daily prompt state, challenge completion, counters) ────────
export interface FreeTierUtilityMeta {
  dailyPrompt?: {
    dateKey?: string;
    dismissedDateKey?: string;
    shuffleOffset?: number;
  };
  completedChallengeIds?: string[];
  postSave?: {
    weekKey?: string;
    weeklySaveCount?: number;
  };
}
