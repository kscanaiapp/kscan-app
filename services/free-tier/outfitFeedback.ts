/**
 * Free Tier Utility Expansion — outfit/item feedback store (local only).
 * Kept separate from the existing Style DNA feedback layer by design; see
 * docs/FREE_TIER_UTILITY_EXPANSION_MAP.md for the deferred connection note.
 */

import { FREE_TIER_STORAGE_KEYS, type OutfitFeedbackEntry } from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

type FeedbackMap = Record<string, OutfitFeedbackEntry>;
const KEY = FREE_TIER_STORAGE_KEYS.outfitFeedback;

export async function loadOutfitFeedback(): Promise<FeedbackMap> {
  return readStore<FeedbackMap>(KEY, {});
}

export async function setOutfitFeedback(
  targetId: string,
  patch: { rating?: number; tags?: string[] },
  userId?: string
): Promise<FeedbackMap> {
  if (!targetId) return loadOutfitFeedback();
  return updateStore<FeedbackMap>(
    KEY,
    {},
    (current) => {
      const existing = current[targetId];
      const rating =
        typeof patch.rating === 'number' && patch.rating >= 1 && patch.rating <= 5
          ? Math.round(patch.rating)
          : existing?.rating;
      const tags = Array.isArray(patch.tags) ? patch.tags.slice(0, 10) : existing?.tags ?? [];
      return {
        ...current,
        [targetId]: { targetId, rating, tags, updatedAt: new Date().toISOString() },
      };
    },
    userId
  );
}

export async function clearOutfitFeedback(targetId: string, userId?: string): Promise<FeedbackMap> {
  return updateStore<FeedbackMap>(
    KEY,
    {},
    (current) => {
      if (!current[targetId]) return current;
      const next = { ...current };
      delete next[targetId];
      return next;
    },
    userId
  );
}
