import React from 'react';
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

export interface EmptyStateCardProps {
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  action?: {
    label: string;
    onPress: () => void;
    accessibilityLabel?: string;
    testID?: string;
  };
  style?: ViewStyle;
  titleStyle?: TextStyle;
  subtitleStyle?: TextStyle;
  testID?: string;
}

/**
 * A premium empty-state card for sessions, rooms, scans, looks, or messages.
 *
 * - Warm pearl surface with a champagne-tinted border.
 * - Optional icon slot and CTA action.
 */
export function EmptyStateCard({
  title,
  subtitle,
  icon,
  action,
  style,
  titleStyle,
  subtitleStyle,
  testID,
}: EmptyStateCardProps) {
  return (
    <View
      testID={testID}
      style={[styles.root, style]}
      accessibilityRole="text"
      accessibilityLabel={title}
    >
      {icon ? <View style={styles.iconWrap}>{icon}</View> : null}
      <Text style={[styles.title, titleStyle]}>{title}</Text>
      {subtitle ? (
        <Text style={[styles.subtitle, subtitleStyle]}>{subtitle}</Text>
      ) : null}
      {action ? (
        <Pressable
          onPress={action.onPress}
          style={styles.action}
          hitSlop={{ top: 8, bottom: 8, left: 16, right: 16 }}
          accessibilityRole="button"
          accessibilityLabel={action.accessibilityLabel ?? action.label}
          testID={action.testID}
        >
          <Text style={styles.actionLabel}>{action.label}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    borderWidth: 1,
    borderColor: 'rgba(198, 161, 91, 0.24)',
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.warmWhite,
    padding: SPACING.xl,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  iconWrap: {
    marginBottom: SPACING.sm,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 18,
    textAlign: 'center',
  },
  subtitle: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
  },
  action: {
    marginTop: SPACING.md,
    minHeight: 44,
    justifyContent: 'center',
  },
  actionLabel: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 12,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
});
