/**
 * Free Tier Utility Expansion — wear tracking + estimated cost per wear.
 * Uses the kscan.freeTier.wearTracking.v1 store. Estimates only; no
 * financial-accuracy claims.
 *
 * ── AUTHORITY NOTICE (Build 29 Closet V2 / S5) ─────────────────────────────
 *
 * The `WearTrackingEntry` map this module owns is a DERIVED CACHE. It is not
 * wear-history truth and must not be treated as such.
 *
 *     CANONICAL   public.wardrobe_wear_events
 *                 + public.wardrobe_wear_event_items
 *                 written only via services/wearHistory.ts
 *
 *     THIS FILE   local projection: per-item wearCount + lastWornAt
 *
 * `markWornToday` increments a counter and stamps a date. It predates the
 * canonical model and is retained so existing free-tier surfaces and Build 28
 * clients keep working — but new wear logging MUST go through
 * `logItemWear` / `logLookWear` in services/wearHistory.ts, which record a
 * dated event with its garments and are idempotent against duplicate
 * submission. This counter is none of those things: it cannot express an
 * outfit, cannot say when its wears happened, and increments on every call.
 *
 * The projection direction is one-way and enforced by test:
 *
 *     events  ->  counter      OK   (projectWearTrackingFromEvents)
 *     counter ->  events       NEVER — a count of 7 does not know its dates,
 *                                     so reconstructing events would fabricate
 *                                     seven of them.
 *
 * Cost Per Wear itself remains OUT of Build 29 scope and dormant; nothing here
 * changes that, and the canonical wear model deliberately does not feed
 * `estimatedPrice`.
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
