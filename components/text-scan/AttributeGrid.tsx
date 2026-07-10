import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { TextScanDemoAttributes } from '../../data/textscan-demo';

export interface AttributeGridProps {
  attributes: TextScanDemoAttributes;
  style?: ViewStyle;
}

/**
 * A two-column grid of interpreted fashion attributes.
 */
export function AttributeGrid({ attributes, style }: AttributeGridProps) {
  const entries = Object.entries(attributes);

  return (
    <View style={[styles.root, style]} accessibilityRole="text">
      {entries.map(([key, value]) => (
        <View key={key} style={styles.cell}>
          <Text style={styles.label}>{formatLabel(key)}</Text>
          <Text style={styles.value} numberOfLines={1}>
            {value}
          </Text>
        </View>
      ))}
    </View>
  );
}

function formatLabel(key: string): string {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (str) => str.toUpperCase())
    .trim();
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  cell: {
    width: '47%',
    backgroundColor: LUXURY.colors.warmWhite,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.md,
  },
  label: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.xs,
  },
  value: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    color: LUXURY.colors.ink,
  },
});
