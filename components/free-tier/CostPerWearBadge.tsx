/**
 * Free Tier Utility Expansion — compact cost-per-wear badge.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import {
  FREE_TIER_COST_PER_WEAR_ENABLED,
  isFreeTierFeatureEnabled,
} from '../../constants/freeTierUtilityFlags';
import {
  computeCostPerWear,
  formatCostPerWear,
} from '../../services/free-tier/costPerWear';
import type { WearTrackingEntry } from '../../services/free-tier/wardrobeUtilityTypes';
import { FT_COLORS } from './freeTierUi';

export function CostPerWearBadge(props: { entry?: WearTrackingEntry | null }) {
  const enabled = isFreeTierFeatureEnabled(FREE_TIER_COST_PER_WEAR_ENABLED);
  const label = formatCostPerWear(computeCostPerWear(props.entry));
  if (!enabled || !label) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.text}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    alignSelf: 'flex-start',
    backgroundColor: FT_COLORS.surfaceSoft,
    borderWidth: 1,
    borderColor: FT_COLORS.border,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 3,
  },
  text: { fontSize: 11, color: FT_COLORS.goldText },
});
