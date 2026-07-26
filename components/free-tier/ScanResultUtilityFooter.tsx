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
import { createActorRequest, isActorRequestCurrent } from '../../services/actorContext';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { normalizeItem, normalizeItems } from '../../services/free-tier/itemNormalization';
import type { NormalizedItem } from '../../services/free-tier/wardrobeUtilityTypes';
import { SavedItemUtilityPanel } from './SavedItemUtilityPanel';

export function ScanResultUtilityFooter(props: { result?: unknown }) {
  const { isAuthenticated, user } = useAuthSession();
  // null actor === signed-out device-local (ownerless) projection
  const actorId = isAuthenticated ? (user?.id ?? null) : null;
  const [savedItems, setSavedItems] = useState<NormalizedItem[]>([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!FREE_TIER_UTILITY_ENABLED) return;
    let live = true;
    // Account isolation: this footer reads services/library directly, so it must
    // apply the same actor filter the library hook does. An unfiltered read here
    // would surface another actor's saved items inside the scan result.
    const actorRequest = createActorRequest();
    Promise.resolve(loadLibrary(actorId))
      .then((scans: unknown) => {
        if (live && isActorRequestCurrent(actorRequest)) {
          setSavedItems(normalizeItems(scans as unknown[], 'library'));
        }
      })
      .catch(() => undefined)
      .finally(() => {
        // A stale `finally` must not mark the new actor's empty projection ready
        // with the previous actor's items still in state.
        if (live && isActorRequestCurrent(actorRequest)) setReady(true);
      });
    return () => {
      live = false;
    };
  }, [actorId]);

  if (!FREE_TIER_UTILITY_ENABLED || !ready) return null;
  const candidate = normalizeItem(props.result, 'scan');
  if (!candidate) return null;

  return (
    <SavedItemUtilityPanel
      item={candidate}
      relatedItems={savedItems}
      context="scan"
    />
  );
}
