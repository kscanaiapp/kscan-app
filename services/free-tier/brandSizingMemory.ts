/**
 * Free Tier Utility Expansion — brand sizing memory (local only).
 * Remembers fit notes per brand (e.g. "Zara: size up"). Never infers body
 * size and never makes body claims — user-entered notes only.
 */

import { FREE_TIER_STORAGE_KEYS, type BrandSizingEntry } from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

type SizingMap = Record<string, BrandSizingEntry>;
const KEY = FREE_TIER_STORAGE_KEYS.brandSizing;

export function normalizeBrandKey(brand?: string): string | null {
  if (typeof brand !== 'string') return null;
  const key = brand.trim().toLowerCase();
  return key.length > 0 ? key : null;
}

export async function loadBrandSizing(): Promise<SizingMap> {
  return readStore<SizingMap>(KEY, {});
}

export async function getBrandSizingNote(brand?: string): Promise<BrandSizingEntry | null> {
  const key = normalizeBrandKey(brand);
  if (!key) return null;
  const map = await loadBrandSizing();
  return map[key] ?? null;
}

export async function setBrandSizingNote(
  brand: string,
  patch: Partial<Omit<BrandSizingEntry, 'brand' | 'lastUpdatedAt'>>,
  userId?: string
): Promise<SizingMap> {
  const key = normalizeBrandKey(brand);
  if (!key) return loadBrandSizing();
  return updateStore<SizingMap>(
    KEY,
    {},
    (current) => {
      const existing = current[key];
      return {
        ...current,
        [key]: {
          brand: brand.trim(),
          usualSize:
            typeof patch.usualSize === 'string'
              ? patch.usualSize.slice(0, 40)
              : existing?.usualSize,
          fitNote:
            typeof patch.fitNote === 'string'
              ? patch.fitNote.slice(0, 200)
              : existing?.fitNote,
          runsSmall: patch.runsSmall ?? existing?.runsSmall,
          runsLarge: patch.runsLarge ?? existing?.runsLarge,
          lastUpdatedAt: new Date().toISOString(),
        },
      };
    },
    userId
  );
}

export async function removeBrandSizingNote(brand: string, userId?: string): Promise<SizingMap> {
  const key = normalizeBrandKey(brand);
  if (!key) return loadBrandSizing();
  return updateStore<SizingMap>(
    KEY,
    {},
    (current) => {
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    },
    userId
  );
}
