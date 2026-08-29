/**
 * Free Tier Utility Expansion — share hook.
 * Uses the built-in React Native Share API (already available in RN core).
 * Plain-text sharing only; no image capture, no uploads.
 */

import { useCallback, useState } from 'react';
import { Platform, Share } from 'react-native';
import {
  KSCAN_SHARE_URL,
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
      // Mirror the Dressing Room share pattern: iOS gets a dedicated url
      // field (app-first via universal link), Android keeps the link in the
      // message body. Same canonical URL on both platforms.
      const payload =
        Platform.OS === 'ios'
          ? { title: 'K Scan AI', message, url: KSCAN_SHARE_URL }
          : { message };
      const result = await Share.share(payload);
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
