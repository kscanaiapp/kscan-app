/**
 * Free Tier Utility Expansion — duplicate hints hook (pure memoized derivation).
 */

import { useMemo } from 'react';
import { findPossibleDuplicates } from '../services/free-tier/duplicateDetector';
import type { NormalizedItem } from '../services/free-tier/wardrobeUtilityTypes';

export function useDuplicateHints(
  candidate: NormalizedItem | null | undefined,
  savedItems: NormalizedItem[]
) {
  return useMemo(
    () => findPossibleDuplicates(candidate, savedItems),
    [candidate, savedItems]
  );
}
