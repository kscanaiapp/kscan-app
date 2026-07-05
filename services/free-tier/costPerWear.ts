/**
 * Free Tier Utility Expansion — wear tracking + estimated cost per wear.
 * Uses the kscan.freeTier.wearTracking.v1 store. Estimates only; no
 * financial-accuracy claims.
 */

import { FREE_TIER_STORAGE_KEYS, type WearTrackingEntry } from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

type WearMap = Record<string, WearTrackingEntry>;
const KEY = FREE_TIER_STORAGE_KEYS.wearTracking;

export async function loadWearTracking(): Promise<WearMap> {
  return readStore<WearMap>(KEY, {});
}

function upsert(
  current: WearMap,
  itemId: string,
  patch: Partial<WearTrackingEntry>
): WearMap {
  const existing = current[itemId] ?? { itemId, wearCount: 0, updatedAt: '' };
  return {
    ...current,
    [itemId]: { ...existing, ...patch, itemId, updatedAt: new Date().toISOString() },
  };
}

export async function markWornToday(itemId: string, userId?: string): Promise<WearMap> {
  if (!itemId) return loadWearTracking();
  return updateStore<WearMap>(
    KEY,
    {},
    (current) =>
      upsert(current, itemId, {
        wearCount: (current[itemId]?.wearCount ?? 0) + 1,
        lastWornAt: new Date().toISOString(),
      }),
    userId
  );
}

export async function setEstimatedPrice(
  itemId: string,
  price: number | undefined,
  userId?: string
): Promise<WearMap> {
  if (!itemId) return loadWearTracking();
  const safePrice =
    typeof price === 'number' && Number.isFinite(price) && price >= 0 && price < 1000000
      ? Math.round(price * 100) / 100
      : undefined;
  return updateStore<WearMap>(
    KEY,
    {},
    (current) => upsert(current, itemId, { estimatedPrice: safePrice }),
    userId
  );
}

export async function resetWearCount(itemId: string, userId?: string): Promise<WearMap> {
  if (!itemId) return loadWearTracking();
  return updateStore<WearMap>(
    KEY,
    {},
    (current) => upsert(current, itemId, { wearCount: 0, lastWornAt: undefined }),
    userId
  );
}

/** Estimated cost per wear, or null when price/wear data is incomplete. */
export function computeCostPerWear(entry?: WearTrackingEntry | null): number | null {
  if (!entry) return null;
  if (typeof entry.estimatedPrice !== 'number' || entry.estimatedPrice <= 0) return null;
  if (typeof entry.wearCount !== 'number' || entry.wearCount <= 0) return null;
  return Math.round((entry.estimatedPrice / entry.wearCount) * 100) / 100;
}

export function formatCostPerWear(value: number | null): string | null {
  if (value === null) return null;
  return '$' + value.toFixed(2) + ' est. per wear';
}
