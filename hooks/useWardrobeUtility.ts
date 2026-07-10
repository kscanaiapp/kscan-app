/**
 * Free Tier Utility Expansion — umbrella hook.
 * Normalizes raw saved items and loads all local utility stores once.
 * Never throws; every store failure resolves to an empty map.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { normalizeItems } from '../services/free-tier/itemNormalization';
import { loadOutfitFeedback } from '../services/free-tier/outfitFeedback';
import { loadWearTracking } from '../services/free-tier/costPerWear';
import { loadCareNotes } from '../services/free-tier/careNotes';
import { loadWishlistIntent } from '../services/free-tier/wishlistIntent';
import type {
  CareNoteEntry,
  NormalizedItem,
  OutfitFeedbackEntry,
  WearTrackingEntry,
  WishlistIntentEntry,
} from '../services/free-tier/wardrobeUtilityTypes';

export interface WardrobeUtilityState {
  items: NormalizedItem[];
  feedback: Record<string, OutfitFeedbackEntry>;
  wear: Record<string, WearTrackingEntry>;
  care: Record<string, CareNoteEntry>;
  wishlist: Record<string, WishlistIntentEntry>;
  loading: boolean;
  reload: () => void;
}

export function useWardrobeUtility(rawItems?: unknown[]): WardrobeUtilityState {
  const [feedback, setFeedback] = useState<Record<string, OutfitFeedbackEntry>>({});
  const [wear, setWear] = useState<Record<string, WearTrackingEntry>>({});
  const [care, setCare] = useState<Record<string, CareNoteEntry>>({});
  const [wishlist, setWishlist] = useState<Record<string, WishlistIntentEntry>>({});
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  const items = useMemo(() => normalizeItems(rawItems ?? []), [rawItems]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([
      loadOutfitFeedback(),
      loadWearTracking(),
      loadCareNotes(),
      loadWishlistIntent(),
    ])
      .then(([fb, wt, cn, wl]) => {
        if (!live) return;
        setFeedback(fb);
        setWear(wt);
        setCare(cn);
        setWishlist(wl);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [reloadToken]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return { items, feedback, wear, care, wishlist, loading, reload };
}
