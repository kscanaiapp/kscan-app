/**
 * Free Tier Utility Expansion — outfit generator hook.
 */

import { useCallback, useMemo, useState } from 'react';
import { generateOutfits } from '../services/free-tier/outfitGenerator';
import { saveOutfitAsLook } from '../services/free-tier/savedOutfits';
import { recordActivity } from '../services/free-tier/activityLog';
import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  SuggestedOutfit,
} from '../services/free-tier/wardrobeUtilityTypes';

export function useOutfitGenerator(
  items: NormalizedItem[],
  feedback?: Record<string, OutfitFeedbackEntry>
) {
  const [visibleCount, setVisibleCount] = useState(2);

  const outfits = useMemo<SuggestedOutfit[]>(
    () => generateOutfits(items, { feedback, maxOutfits: 6 }),
    [items, feedback]
  );

  const showMore = useCallback(() => setVisibleCount((c) => Math.min(c + 2, 6)), []);

  const saveLook = useCallback(async (outfit: SuggestedOutfit) => {
    await saveOutfitAsLook(outfit);
    recordActivity('created_collection', 'Saved a look: ' + outfit.title).catch(() => undefined);
  }, []);

  return {
    outfits: outfits.slice(0, visibleCount),
    totalAvailable: outfits.length,
    showMore,
    saveLook,
  };
}
