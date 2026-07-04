/**
 * Free Tier Utility Expansion — closet filters hook (P2 shell).
 */

import { useCallback, useMemo, useState } from 'react';
import {
  applyClosetFilter,
  type ClosetFilterContext,
  type ClosetFilterId,
} from '../services/free-tier/closetFilters';
import type { NormalizedItem } from '../services/free-tier/wardrobeUtilityTypes';

export function useClosetFilters(
  items: NormalizedItem[],
  context?: Omit<ClosetFilterContext, 'value'>
) {
  const [activeFilter, setActiveFilter] = useState<ClosetFilterId>('all');
  const [filterValue, setFilterValue] = useState<string | undefined>(undefined);

  const filteredItems = useMemo(
    () => applyClosetFilter(items, activeFilter, { ...context, value: filterValue }),
    [items, activeFilter, filterValue, context]
  );

  const selectFilter = useCallback((id: ClosetFilterId, value?: string) => {
    setActiveFilter(id);
    setFilterValue(value);
  }, []);

  return { activeFilter, filterValue, filteredItems, selectFilter };
}
