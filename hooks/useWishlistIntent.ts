/**
 * Free Tier Utility Expansion — wishlist intent hook.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  clearWishlistIntent,
  loadWishlistIntent,
  setWishlistIntent,
} from '../services/free-tier/wishlistIntent';
import { recordActivity } from '../services/free-tier/activityLog';
import type {
  WishlistIntentEntry,
  WishlistIntentKind,
} from '../services/free-tier/wardrobeUtilityTypes';

export function useWishlistIntent() {
  const [intents, setIntents] = useState<Record<string, WishlistIntentEntry>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadWishlistIntent()
      .then((map) => {
        if (live) setIntents(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const setIntent = useCallback(
    async (itemId: string, intent: WishlistIntentKind, titleSnapshot?: string) => {
      const next = await setWishlistIntent(itemId, intent, titleSnapshot);
      setIntents(next);
      recordActivity('added_wishlist_intent', 'Added wishlist intent').catch(
        () => undefined
      );
    },
    []
  );

  const clearIntent = useCallback(async (itemId: string) => {
    setIntents(await clearWishlistIntent(itemId));
  }, []);

  return { intents, loading, setIntent, clearIntent };
}
