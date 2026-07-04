/**
 * Free Tier Utility Expansion — brand sizing memory hook.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  loadBrandSizing,
  normalizeBrandKey,
  removeBrandSizingNote,
  setBrandSizingNote,
} from '../services/free-tier/brandSizingMemory';
import { recordActivity } from '../services/free-tier/activityLog';
import type { BrandSizingEntry } from '../services/free-tier/wardrobeUtilityTypes';

export function useBrandSizingMemory(brand?: string) {
  const [entries, setEntries] = useState<Record<string, BrandSizingEntry>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadBrandSizing()
      .then((map) => {
        if (live) setEntries(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const brandKey = normalizeBrandKey(brand);
  const entry = brandKey ? entries[brandKey] ?? null : null;

  const saveNote = useCallback(
    async (
      targetBrand: string,
      patch: Partial<Omit<BrandSizingEntry, 'brand' | 'lastUpdatedAt'>>
    ) => {
      const next = await setBrandSizingNote(targetBrand, patch);
      setEntries(next);
      recordActivity('added_sizing_note', 'Added sizing note for ' + targetBrand).catch(
        () => undefined
      );
    },
    []
  );

  const removeNote = useCallback(async (targetBrand: string) => {
    setEntries(await removeBrandSizingNote(targetBrand));
  }, []);

  return { entries, entry, loading, saveNote, removeNote };
}
