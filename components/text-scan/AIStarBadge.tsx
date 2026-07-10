import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface AIStarBadgeProps {
  label?: string;
  style?: ViewStyle;
}

/**
 * A small gold-outlined AI STAR pill for TextScan surfaces.
 */
export function AIStarBadge({
  label = 'AI STAR',
  style,
}: AIStarBadgeProps) {
  return (
    <View
      style={[styles.root, style]}
      accessibilityRole="text"
      accessibilityLabel={`${label} powered`}
    >
      <Text style={styles.sparkle}>✦</Text>
      <Text style={styles.label}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    backgroundColor: 'transparent',
  },
  sparkle: {
    fontSize: 10,
    color: LUXURY.colors.goldBrushed,
  },
  label: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    fontWeight: '700',
    letterSpacing: 1.2,
    color: LUXURY.colors.goldText,
  },
});
