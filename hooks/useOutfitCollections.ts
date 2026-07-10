/**
 * Free Tier Utility Expansion — collections hook.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  addItemToCollection,
  createCollection,
  deleteCollection,
  loadCollections,
  removeItemFromCollection,
  renameCollection,
} from '../services/free-tier/outfitCollections';
import { recordActivity } from '../services/free-tier/activityLog';
import type { OutfitCollection } from '../services/free-tier/wardrobeUtilityTypes';

export function useOutfitCollections() {
  const [collections, setCollections] = useState<OutfitCollection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadCollections()
      .then((list) => {
        if (live) setCollections(list);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const create = useCallback(async (name: string) => {
    const next = await createCollection(name);
    setCollections(next);
    recordActivity('created_collection', 'Created collection "' + name + '"').catch(
      () => undefined
    );
    return next;
  }, []);

  const rename = useCallback(async (id: string, name: string) => {
    setCollections(await renameCollection(id, name));
  }, []);

  const remove = useCallback(async (id: string) => {
    setCollections(await deleteCollection(id));
  }, []);

  const addItem = useCallback(async (collectionId: string, itemId: string) => {
    setCollections(await addItemToCollection(collectionId, itemId));
  }, []);

  const removeItem = useCallback(async (collectionId: string, itemId: string) => {
    setCollections(await removeItemFromCollection(collectionId, itemId));
  }, []);

  return { collections, loading, create, rename, remove, addItem, removeItem };
}
