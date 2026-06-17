import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface SectionHeaderProps {
  title: string;
  subtitle?: string;
  /** Optional action label rendered on the trailing edge. */
  actionLabel?: string;
  /** Called when the trailing action label is pressed. */
  onAction?: () => void;
  /** Accessibility label for the action button. */
  actionAccessibilityLabel?: string;
  /** Visual treatment for the trailing action. `minimal` keeps the existing text link; `pill` gives it a small filled CTA shape. */
  actionVariant?: 'minimal' | 'pill';
  /** Override root style. */
  style?: ViewStyle;
  /** Override title style. */
  titleStyle?: TextStyle;
  /** Override subtitle style. */
  subtitleStyle?: TextStyle;
}

/**
 * Editorial section header with an optional trailing action.
 *
 * - Uppercase sans-serif label for scan/library/dressing-room sections.
 * - Minimum 44dp tappable action target.
 */
export function SectionHeader({
  title,
  subtitle,
  actionLabel,
  onAction,
  actionAccessibilityLabel,
  actionVariant = 'minimal',
  style,
  titleStyle,
  subtitleStyle,
}: SectionHeaderProps) {
  return (
    <View style={[styles.root, style]}>
      <View style={styles.textBlock}>
        <Text
          style={[LUXURY.typography.sectionLabel, styles.title, titleStyle]}
          accessibilityRole="header"
        >
          {title}
        </Text>
        {subtitle && (
          <Text style={[LUXURY.typography.caption, styles.subtitle, subtitleStyle]}>
            {subtitle}
          </Text>
        )}
      </View>

      {actionLabel && onAction && (
        <Pressable
          onPress={onAction}
          style={[styles.action, actionVariant === 'pill' && styles.actionPill]}
          accessibilityRole="button"
          accessibilityLabel={actionAccessibilityLabel ?? actionLabel}
        >
          <Text style={[styles.actionLabel, actionVariant === 'pill' && styles.actionPillLabel]}>
            {actionLabel}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
    paddingTop: SPACING.lg,
  },
  textBlock: {
    flex: 1,
    paddingRight: SPACING.md,
  },
  title: {
    color: LUXURY.colors.stone,
  },
  subtitle: {
    marginTop: SPACING.xs,
    color: LUXURY.colors.graphite,
  },
  action: {
    minHeight: 44,
    justifyContent: 'center',
    paddingLeft: SPACING.sm,
  },
  actionLabel: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 12,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
  },
  actionPill: {
    minHeight: 34,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
  },
  actionPillLabel: {
    ...LUXURY.typography.cta,
    fontSize: 11,
    letterSpacing: 1.6,
    color: LUXURY.colors.inverse,
  },
});
