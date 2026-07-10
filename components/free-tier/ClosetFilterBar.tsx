/**
 * Free Tier Utility Expansion — closet filter bar (P2 shell).
 */

import React from 'react';
import { ScrollView } from 'react-native';
import {
  FREE_TIER_CLOSET_FILTERS_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import {
  CLOSET_FILTERS,
  type ClosetFilterId,
} from '../../services/free-tier/closetFilters';
import { UtilityChip } from './freeTierUi';

export function ClosetFilterBar(props: {
  activeFilter: ClosetFilterId;
  onSelect: (id: ClosetFilterId) => void;
}) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_CLOSET_FILTERS_ENABLED);
  if (!enabled) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false}>
      {CLOSET_FILTERS.map((filter) => (
        <UtilityChip
          key={filter.id}
          label={filter.label}
          active={props.activeFilter === filter.id}
          onPress={() => props.onSelect(filter.id)}
        />
      ))}
    </ScrollView>
  );
}
