/**
 * Free Tier Utility Expansion — outfit/item rating hook.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  clearOutfitFeedback,
  loadOutfitFeedback,
  setOutfitFeedback,
} from '../services/free-tier/outfitFeedback';
import { recordActivity } from '../services/free-tier/activityLog';
import type { OutfitFeedbackEntry } from '../services/free-tier/wardrobeUtilityTypes';

export function useOutfitFeedback() {
  const [feedback, setFeedback] = useState<Record<string, OutfitFeedbackEntry>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadOutfitFeedback()
      .then((map) => {
        if (live) setFeedback(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const rate = useCallback(async (targetId: string, rating: number) => {
    const next = await setOutfitFeedback(targetId, { rating });
    setFeedback(next);
    recordActivity('rated_outfit', 'Rated outfit ' + Math.round(rating) + '★').catch(
      () => undefined
    );
  }, []);

  const toggleTag = useCallback(async (targetId: string, tag: string) => {
    const current = feedback[targetId]?.tags ?? [];
    const tags = current.includes(tag)
      ? current.filter((t) => t !== tag)
      : [...current, tag];
    setFeedback(await setOutfitFeedback(targetId, { tags }));
  }, [feedback]);

  const clear = useCallback(async (targetId: string) => {
    setFeedback(await clearOutfitFeedback(targetId));
  }, []);

  return { feedback, loading, rate, toggleTag, clear };
}
