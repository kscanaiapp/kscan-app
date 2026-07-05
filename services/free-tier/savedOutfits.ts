/**
 * Free Tier Utility Expansion — saved looks (styleBoards.v1 store).
 * Persists user-saved outfit suggestions as lightweight id + snapshot lists.
 */

import {
  FREE_TIER_STORAGE_KEYS,
  type SavedOutfit,
  type SuggestedOutfit,
} from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

const KEY = FREE_TIER_STORAGE_KEYS.styleBoards;
const MAX_SAVED = 40;

export async function loadSavedOutfits(): Promise<SavedOutfit[]> {
  const list = await readStore<SavedOutfit[]>(KEY, []);
  return Array.isArray(list) ? list : [];
}

export async function saveOutfitAsLook(
  outfit: SuggestedOutfit,
  userId?: string
): Promise<SavedOutfit[]> {
  if (!outfit || !Array.isArray(outfit.itemIds) || outfit.itemIds.length === 0) {
    return loadSavedOutfits();
  }
  const saved: SavedOutfit = {
    id: 'look_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
    title: outfit.title || 'Saved look',
    itemIds: outfit.itemIds,
    itemSnapshots: (outfit.items ?? []).map((i) => ({
      id: i.id,
      title: i.title,
      category: i.category,
      color: i.color,
    })),
    createdAt: new Date().toISOString(),
  };
  return updateStore<SavedOutfit[]>(
    KEY,
    [],
    (current) => [saved, ...current].slice(0, MAX_SAVED),
    userId
  );
}

export async function deleteSavedOutfit(lookId: string, userId?: string): Promise<SavedOutfit[]> {
  return updateStore<SavedOutfit[]>(
    KEY,
    [],
    (current) => current.filter((l) => l.id !== lookId),
    userId
  );
}
