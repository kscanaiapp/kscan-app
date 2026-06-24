import React from 'react';
import { View, Text, StyleSheet, ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface ScanRoomHeaderProps {
  badge?: React.ReactNode;
  style?: ViewStyle;
  testID?: string;
  rightAction?: React.ReactNode;
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
  rightAction,
}: ScanRoomHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.root,
        { paddingTop: Math.max(SPACING.lg, insets.top + SPACING.sm) },
        style,
      ]}
      testID={testID}
    >
      <View style={styles.row}>
        <View style={styles.left} />
        <View style={styles.center}>
          <Text style={styles.brandTitle}>K Scan AI</Text>
          {badge}
        </View>
        <View style={styles.right}>
          {rightAction}
        </View>
      </View>
      <View style={styles.divider}>
        <Text style={styles.dividerText}>✧</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignSelf: 'stretch',
    alignItems: 'center',
    paddingBottom: SPACING.lg,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
    paddingHorizontal: SPACING.lg,
    alignSelf: 'stretch',
  },
  left: {
    minWidth: 44,
    minHeight: 44,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
    flexDirection: 'row',
  },
  right: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
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
