/**
 * Free Tier Utility Expansion — share hook.
 * Uses the built-in React Native Share API (already available in RN core).
 * Plain-text sharing only; no image capture, no uploads.
 */

import { useCallback, useState } from 'react';
import { Share } from 'react-native';
import {
  buildItemShareText,
  buildOutfitShareText,
} from '../services/free-tier/shareTextBuilder';
import { recordActivity } from '../services/free-tier/activityLog';
import type {
  NormalizedItem,
  SavedOutfit,
  SuggestedOutfit,
} from '../services/free-tier/wardrobeUtilityTypes';

export function useShareOutfit() {
  const [sharing, setSharing] = useState(false);

  const shareText = useCallback(async (message: string, activityLabel: string) => {
    if (!message) return false;
    setSharing(true);
    try {
      const result = await Share.share({ message });
      if (result.action === Share.sharedAction) {
        recordActivity('shared_outfit', activityLabel).catch(() => undefined);
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      setSharing(false);
    }
  }, []);

  const shareItem = useCallback(
    (item?: NormalizedItem | null) =>
      shareText(buildItemShareText(item), 'Shared a saved item'),
    [shareText]
  );

  const shareOutfit = useCallback(
    (outfit?: SuggestedOutfit | SavedOutfit | null, items?: NormalizedItem[]) =>
      shareText(buildOutfitShareText(outfit, items), 'Shared an outfit'),
    [shareText]
  );

  return { sharing, shareItem, shareOutfit };
}
