import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ViewStyle,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export type TextScanFilter = 'all' | 'retail' | 'resale' | 'similar';

export interface ResultFilterTabsProps {
  activeFilter: TextScanFilter;
  onFilterChange: (filter: TextScanFilter) => void;
  style?: ViewStyle;
}

const FILTERS: { key: TextScanFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'retail', label: 'Retail' },
  { key: 'resale', label: 'Resale' },
  { key: 'similar', label: 'Similar' },
];

/**
 * Horizontal filter tabs for TextScan results.
 */
export function ResultFilterTabs({
  activeFilter,
  onFilterChange,
  style,
}: ResultFilterTabsProps) {
  return (
    <View style={[styles.root, style]}>
      {FILTERS.map((filter) => {
        const isActive = activeFilter === filter.key;
        return (
          <Pressable
            key={filter.key}
            onPress={() => onFilterChange(filter.key)}
            style={[
              styles.tab,
              isActive && styles.activeTab,
            ]}
            accessibilityRole="button"
            accessibilityLabel={`Filter by ${filter.label}`}
            accessibilityState={{ selected: isActive }}
          >
            <Text
              style={[
                styles.label,
                isActive && styles.activeLabel,
              ]}
            >
              {filter.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    gap: SPACING.sm,
  },
  tab: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
    minHeight: 36,
    justifyContent: 'center',
  },
  activeTab: {
    backgroundColor: LUXURY.colors.plum,
    borderColor: LUXURY.colors.plum,
  },
  label: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.graphite,
  },
  activeLabel: {
    color: LUXURY.colors.inverse,
  },
});
