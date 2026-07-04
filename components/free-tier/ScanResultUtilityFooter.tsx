/**
 * Free Tier Utility Expansion — compact utility footer for the scan result screen.
 *
 * Self-contained: loads the local library itself so the host screen only
 * needs a single flag-guarded mount line. Renders null when the master flag
 * is off, while loading, or when no useful sections apply.
 */

import React, { useEffect, useState } from 'react';
import { FREE_TIER_UTILITY_ENABLED } from '../../constants/freeTierUtilityFlags';
import { loadLibrary } from '../../services/library';
import { normalizeItem, normalizeItems } from '../../services/free-tier/itemNormalization';
import type { NormalizedItem } from '../../services/free-tier/wardrobeUtilityTypes';
import { BrandSizingNoteCard } from './BrandSizingNoteCard';
import { WardrobeDuplicateHintCard } from './WardrobeDuplicateHintCard';
import { WishlistIntentCard } from './WishlistIntentCard';

export function ScanResultUtilityFooter(props: { result?: unknown }) {
  const [savedItems, setSavedItems] = useState<NormalizedItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!FREE_TIER_UTILITY_ENABLED) return;
    let live = true;
    Promise.resolve(loadLibrary())
      .then((scans: unknown) => {
        if (live) setSavedItems(normalizeItems(scans as unknown[], 'library'));
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setReady(true);
      });
    return () => {
      live = false;
    };
  }, []);

  if (!FREE_TIER_UTILITY_ENABLED || !ready) return null;
  const candidate = normalizeItem(props.result, 'scan');
  if (!candidate) return null;

  return (
    <>
      <WardrobeDuplicateHintCard candidate={candidate} savedItems={savedItems} />
      {candidate.brand ? <BrandSizingNoteCard brand={candidate.brand} /> : null}
      <WishlistIntentCard item={candidate} />
    </>
  );
}
