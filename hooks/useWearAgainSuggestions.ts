/**
 * Free Tier Utility Expansion — wear-again suggestions hook (P2 shell).
 */

import { useMemo } from 'react';
import { getWearAgainSuggestions } from '../services/free-tier/wearAgainSuggestions';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
} from '../services/free-tier/wardrobeUtilityTypes';

export function useWearAgainSuggestions(
  items: NormalizedItem[],
  extras?: {
    feedback?: Record<string, OutfitFeedbackEntry>;
    wear?: Record<string, WearTrackingEntry>;
    limit?: number;
  }
) {
  return useMemo(
    () => getWearAgainSuggestions(items, extras),
    [items, extras?.feedback, extras?.wear, extras?.limit]
  );
}
