/**
 * Free Tier Utility Expansion — daily style prompt hook.
 * Persists dismissal + shuffle offset per calendar day in utilityMeta.v1.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { getDailyPick, todayKey } from '../services/free-tier/dailyStylePrompt';
import { readStore, updateStore } from '../services/free-tier/freeTierStorage';
import {
  FREE_TIER_STORAGE_KEYS,
  type FreeTierUtilityMeta,
  type NormalizedItem,
  type OutfitFeedbackEntry,
  type SuggestedOutfit,
  type WearTrackingEntry,
} from '../services/free-tier/wardrobeUtilityTypes';

const META_KEY = FREE_TIER_STORAGE_KEYS.utilityMeta;

export function useDailyStylePrompt(inputs: {
  items: NormalizedItem[];
  outfits?: SuggestedOutfit[];
  feedback?: Record<string, OutfitFeedbackEntry>;
  wear?: Record<string, WearTrackingEntry>;
}) {
  const [shuffleOffset, setShuffleOffset] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const dateKey = todayKey();

  useEffect(() => {
    let live = true;
    readStore<FreeTierUtilityMeta>(META_KEY, {})
      .then((meta) => {
        if (!live) return;
        const dp = meta.dailyPrompt;
        if (dp?.dateKey === dateKey && typeof dp.shuffleOffset === 'number') {
          setShuffleOffset(dp.shuffleOffset);
        }
        setDismissed(dp?.dismissedDateKey === dateKey);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setHydrated(true);
      });
    return () => {
      live = false;
    };
  }, [dateKey]);

  const pick = useMemo(
    () =>
      getDailyPick({
        items: inputs.items,
        outfits: inputs.outfits,
        feedback: inputs.feedback,
        wear: inputs.wear,
        shuffleOffset,
      }),
    [inputs.items, inputs.outfits, inputs.feedback, inputs.wear, shuffleOffset]
  );

  const persistMeta = useCallback(
    (patch: Partial<NonNullable<FreeTierUtilityMeta['dailyPrompt']>>) => {
      updateStore<FreeTierUtilityMeta>(META_KEY, {}, (meta) => ({
        ...meta,
        dailyPrompt: { ...(meta.dailyPrompt ?? {}), dateKey, ...patch },
      })).catch(() => undefined);
    },
    [dateKey]
  );

  const showAnother = useCallback(() => {
    setShuffleOffset((offset) => {
      const next = offset + 1;
      persistMeta({ shuffleOffset: next });
      return next;
    });
  }, [persistMeta]);

  const notToday = useCallback(() => {
    setDismissed(true);
    persistMeta({ dismissedDateKey: dateKey });
  }, [persistMeta, dateKey]);

  return { pick, dismissed, hydrated, showAnother, notToday };
}
