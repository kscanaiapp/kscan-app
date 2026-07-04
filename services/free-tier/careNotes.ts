/**
 * Free Tier Utility Expansion — care & maintenance notes (local only).
 * No notifications, no calendar/reminder permissions.
 */

import { FREE_TIER_STORAGE_KEYS, type CareNoteEntry } from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

type CareMap = Record<string, CareNoteEntry>;
const KEY = FREE_TIER_STORAGE_KEYS.careNotes;

export async function loadCareNotes(): Promise<CareMap> {
  return readStore<CareMap>(KEY, {});
}

export async function setCareNote(
  itemId: string,
  patch: { tags?: string[]; note?: string },
  userId?: string
): Promise<CareMap> {
  if (!itemId) return loadCareNotes();
  return updateStore<CareMap>(
    KEY,
    {},
    (current) => {
      const existing = current[itemId];
      return {
        ...current,
        [itemId]: {
          itemId,
          tags: Array.isArray(patch.tags) ? patch.tags.slice(0, 8) : existing?.tags ?? [],
          note:
            typeof patch.note === 'string'
              ? patch.note.slice(0, 280)
              : existing?.note,
          updatedAt: new Date().toISOString(),
        },
      };
    },
    userId
  );
}

export async function removeCareNote(itemId: string, userId?: string): Promise<CareMap> {
  return updateStore<CareMap>(
    KEY,
    {},
    (current) => {
      if (!current[itemId]) return current;
      const next = { ...current };
      delete next[itemId];
      return next;
    },
    userId
  );
}
