import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface ScanRoomHeaderProps {
  badge?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
}

/**
 * Shared Scan Room header.
 *
 * - K Scan AI brand mark with champagne sparkle divider.
 * - Optional AI STAR badge or other trailing node.
 */
export function ScanRoomHeader({
  badge,
  style,
  testID,
}: ScanRoomHeaderProps) {
  return (
    <View style={[styles.root, style]} testID={testID}>
      <View style={styles.brandRow}>
        <Text style={styles.brandTitle}>K Scan AI</Text>
        {badge}
      </View>
      <View style={styles.divider}>
        <Text style={styles.dividerText}>✧</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    paddingVertical: SPACING.lg,
  },
  brandRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
  },
  brandTitle: {
    ...LUXURY.typography.brandMark,
    fontSize: 18,
    letterSpacing: 3.5,
    color: LUXURY.colors.plumDeep,
  },
  divider: {
    marginTop: SPACING.xs,
    alignItems: 'center',
  },
  dividerText: {
    fontSize: 14,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 4,
  },
});
