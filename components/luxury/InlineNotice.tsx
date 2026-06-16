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

export type InlineNoticeVariant = 'info' | 'error' | 'warning' | 'success';

export interface InlineNoticeAction {
  label: string;
  onPress: () => void;
  accessibilityLabel?: string;
  testID?: string;
}

export interface InlineNoticeProps {
  variant?: InlineNoticeVariant;
  title?: string;
  body?: string;
  action?: InlineNoticeAction;
  style?: ViewStyle;
  titleStyle?: TextStyle;
  bodyStyle?: TextStyle;
  testID?: string;
  accessibilityRole?: 'alert' | 'text';
  accessibilityLabel?: string;
}

const VARIANT_TOKENS: Record<
  InlineNoticeVariant,
  { border: string; background: string; title: string; body: string }
> = {
  info: {
    border: LUXURY.colors.border,
    background: LUXURY.colors.pearl,
    title: LUXURY.colors.goldBrushed,
    body: LUXURY.colors.ink,
  },
  error: {
    border: `${LUXURY.colors.error}28`,
    background: `${LUXURY.colors.error}0C`,
    title: LUXURY.colors.error,
    body: LUXURY.colors.graphite,
  },
  warning: {
    border: `${LUXURY.colors.warning}32`,
    background: `${LUXURY.colors.warning}0C`,
    title: LUXURY.colors.warning,
    body: LUXURY.colors.ink,
  },
  success: {
    border: `${LUXURY.colors.success}32`,
    background: `${LUXURY.colors.success}0C`,
    title: LUXURY.colors.success,
    body: LUXURY.colors.ink,
  },
};

/**
 * A rounded inline notice for quota, privacy, warning, error, and info states.
 *
 * - Keeps the same rounded-card language as other luxury surfaces.
 * - Optional trailing action label for CTAs like "Sign in" or "Retry".
 */
export function InlineNotice({
  variant = 'info',
  title,
  body,
  action,
  style,
  titleStyle,
  bodyStyle,
  testID,
  accessibilityRole,
  accessibilityLabel,
}: InlineNoticeProps) {
  const tokens = VARIANT_TOKENS[variant];
  const Container = action ? Pressable : View;
  const containerProps = action
    ? {
        onPress: action.onPress,
        accessibilityRole: 'button' as const,
        accessibilityLabel: action.accessibilityLabel ?? action.label,
        testID: action.testID ?? testID,
      }
    : {
        accessibilityRole: accessibilityRole ?? 'text',
        testID,
        accessibilityLabel,
      };

  return (
    <Container
      {...containerProps}
      style={[
        styles.root,
        {
          borderColor: tokens.border,
          backgroundColor: tokens.background,
        },
        style,
      ]}
    >
      <View style={styles.textBlock}>
        {title ? (
          <Text style={[styles.title, { color: tokens.title }, titleStyle]}>{title}</Text>
        ) : null}
        {body ? (
          <Text style={[styles.body, { color: tokens.body }, bodyStyle]}>{body}</Text>
        ) : null}
      </View>
      {action ? <Text style={styles.actionLabel}>{action.label}</Text> : null}
    </Container>
  );
}

const styles = StyleSheet.create({
  root: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: RADIUS.lg,
    padding: SPACING.lg,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  textBlock: {
    flex: 1,
    gap: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.caption,
    fontWeight: '600',
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
  },
  actionLabel: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 12,
    letterSpacing: 1.8,
    textTransform: 'uppercase',
    minHeight: 44,
    textAlignVertical: 'center',
  },
});
