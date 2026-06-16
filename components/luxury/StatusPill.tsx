import React from 'react';
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export type StatusPillVariant = 'success' | 'warning' | 'error' | 'neutral' | 'gold';

export interface StatusPillProps {
  label: string;
  variant?: StatusPillVariant;
  loading?: boolean;
  style?: ViewStyle;
  textStyle?: TextStyle;
  accessibilityLabel?: string;
  testID?: string;
}

const VARIANT_TOKENS: Record<
  StatusPillVariant,
  { text: string; border: string; background: string }
> = {
  success: {
    text: LUXURY.colors.success,
    border: `${LUXURY.colors.success}40`,
    background: `${LUXURY.colors.success}10`,
  },
  warning: {
    text: LUXURY.colors.warning,
    border: `${LUXURY.colors.warning}40`,
    background: `${LUXURY.colors.warning}10`,
  },
  error: {
    text: LUXURY.colors.error,
    border: `${LUXURY.colors.error}40`,
    background: `${LUXURY.colors.error}10`,
  },
  neutral: {
    text: LUXURY.colors.stone,
    border: LUXURY.colors.border,
    background: LUXURY.colors.pearl,
  },
  gold: {
    text: LUXURY.colors.goldBrushed,
    border: `${LUXURY.colors.goldBrushed}40`,
    background: `${LUXURY.colors.goldBrushed}10`,
  },
};

/**
 * A compact status pill for sync, trust, and limit states.
 *
 * - Uses subtle tinted surfaces so status feels informative, not alarming.
 * - Optional loading spinner for syncing states.
 */
export function StatusPill({
  label,
  variant = 'neutral',
  loading = false,
  style,
  textStyle,
  accessibilityLabel,
  testID,
}: StatusPillProps) {
  const tokens = VARIANT_TOKENS[variant];
  return (
    <View
      testID={testID}
      style={[
        styles.root,
        {
          borderColor: tokens.border,
          backgroundColor: tokens.background,
        },
        style,
      ]}
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? label}
    >
      {loading ? (
        <ActivityIndicator size="small" color={tokens.text} style={styles.spinner} />
      ) : null}
      <Text style={[styles.label, { color: tokens.text }, textStyle]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    borderWidth: 1,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    alignSelf: 'flex-start',
  },
  spinner: {
    width: 12,
    height: 12,
  },
  label: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    fontWeight: '600',
    letterSpacing: 1.4,
    textTransform: 'uppercase',
  },
});
