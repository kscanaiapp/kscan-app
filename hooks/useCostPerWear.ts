/**
 * Free Tier Utility Expansion — cost-per-wear hook.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  computeCostPerWear,
  loadWearTracking,
  markWornToday,
  resetWearCount,
  setEstimatedPrice,
} from '../services/free-tier/costPerWear';
import { recordActivity } from '../services/free-tier/activityLog';
import type {
  NormalizedItem,
  WearTrackingEntry,
} from '../services/free-tier/wardrobeUtilityTypes';

export function useCostPerWear() {
  const [wear, setWear] = useState<Record<string, WearTrackingEntry>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadWearTracking()
      .then((map) => {
        if (live) setWear(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const markWorn = useCallback(async (item: NormalizedItem) => {
    const next = await markWornToday(item.id);
    setWear(next);
    const label = 'Marked ' + (item.title ?? item.category ?? 'item') + ' worn today';
    recordActivity('marked_worn', label).catch(() => undefined);
  }, []);

  const setPrice = useCallback(async (itemId: string, price?: number) => {
    setWear(await setEstimatedPrice(itemId, price));
  }, []);

  const reset = useCallback(async (itemId: string) => {
    setWear(await resetWearCount(itemId));
  }, []);

  const costFor = useCallback(
    (itemId: string) => computeCostPerWear(wear[itemId]),
    [wear]
  );

  return { wear, loading, markWorn, setPrice, reset, costFor };
}
