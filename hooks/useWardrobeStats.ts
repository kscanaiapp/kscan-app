/**
 * Free Tier Utility Expansion — wardrobe stats hook (pure memoized derivation).
 */

import { useMemo } from 'react';
import { computeWardrobeStats } from '../services/free-tier/wardrobeStats';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from '../services/free-tier/wardrobeUtilityTypes';

export function useWardrobeStats(
  items: NormalizedItem[],
  extras?: {
    feedback?: Record<string, OutfitFeedbackEntry>;
    wear?: Record<string, WearTrackingEntry>;
  }
) {
  return useMemo(
    () => computeWardrobeStats(items, extras),
    [items, extras?.feedback, extras?.wear]
  );
}
