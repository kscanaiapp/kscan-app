/**
 * Free Tier Utility Expansion — outfit collections / lookbooks (local only).
 * Default collection names appear in empty states only and are never
 * injected into user data.
 */

import { FREE_TIER_STORAGE_KEYS, type OutfitCollection } from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

const KEY = FREE_TIER_STORAGE_KEYS.collections;

export const COLLECTION_NAME_IDEAS = [
  'Work Capsule',
  'Date Night',
  'Vacation Looks',
  'Weekend Staples',
] as const;

export async function loadCollections(): Promise<OutfitCollection[]> {
  const list = await readStore<OutfitCollection[]>(KEY, []);
  return Array.isArray(list) ? list : [];
}

export async function createCollection(name: string, userId?: string): Promise<OutfitCollection[]> {
  const safeName = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  if (!safeName) return loadCollections();
  const now = new Date().toISOString();
  const collection: OutfitCollection = {
    id: 'col_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
    name: safeName,
    itemIds: [],
    createdAt: now,
    updatedAt: now,
  };
  return updateStore<OutfitCollection[]>(KEY, [], (current) => [collection, ...current], userId);
}

export async function renameCollection(
  collectionId: string,
  name: string,
  userId?: string
): Promise<OutfitCollection[]> {
  const safeName = typeof name === 'string' ? name.trim().slice(0, 60) : '';
  if (!collectionId || !safeName) return loadCollections();
  return updateStore<OutfitCollection[]>(
    KEY,
    [],
    (current) =>
      current.map((c) =>
        c.id === collectionId
          ? { ...c, name: safeName, updatedAt: new Date().toISOString() }
          : c
      ),
    userId
  );
}

export async function deleteCollection(collectionId: string, userId?: string): Promise<OutfitCollection[]> {
  return updateStore<OutfitCollection[]>(
    KEY,
    [],
    (current) => current.filter((c) => c.id !== collectionId),
    userId
  );
}

export async function addItemToCollection(
  collectionId: string,
  itemId: string,
  userId?: string
): Promise<OutfitCollection[]> {
  if (!collectionId || !itemId) return loadCollections();
  return updateStore<OutfitCollection[]>(
    KEY,
    [],
    (current) =>
      current.map((c) => {
        if (c.id !== collectionId || c.itemIds.includes(itemId)) return c;
        return {
          ...c,
          itemIds: [...c.itemIds, itemId].slice(0, 100),
          coverItemId: c.coverItemId ?? itemId,
          updatedAt: new Date().toISOString(),
        };
      }),
    userId
  );
}

export async function removeItemFromCollection(
  collectionId: string,
  itemId: string,
  userId?: string
): Promise<OutfitCollection[]> {
  return updateStore<OutfitCollection[]>(
    KEY,
    [],
    (current) =>
      current.map((c) => {
        if (c.id !== collectionId) return c;
        const itemIds = c.itemIds.filter((id) => id !== itemId);
        return {
          ...c,
          itemIds,
          coverItemId: c.coverItemId === itemId ? itemIds[0] : c.coverItemId,
          updatedAt: new Date().toISOString(),
        };
      }),
    userId
  );
}
