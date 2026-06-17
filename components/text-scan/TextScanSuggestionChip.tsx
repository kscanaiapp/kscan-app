import React from 'react';
import { Pressable, Text, StyleSheet, ViewStyle } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface TextScanSuggestionChipProps {
  label: string;
  onPress: () => void;
  style?: ViewStyle;
  accessibilityLabel?: string;
}

/**
 * A rounded suggestion chip that populates the query input when tapped.
 */
export function TextScanSuggestionChip({
  label,
  onPress,
  style,
  accessibilityLabel,
}: TextScanSuggestionChipProps) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.root,
        pressed && styles.pressed,
        style,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? `Use suggestion: ${label}`}
    >
      <Text style={styles.sparkle}>✦</Text>
      <Text style={styles.label} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    backgroundColor: LUXURY.colors.plumMuted,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    minHeight: 36,
  },
  pressed: {
    backgroundColor: LUXURY.colors.champagne,
    borderColor: LUXURY.colors.goldLight,
  },
  sparkle: {
    fontSize: 10,
    color: LUXURY.colors.goldBrushed,
  },
  label: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.plum,
  },
});
