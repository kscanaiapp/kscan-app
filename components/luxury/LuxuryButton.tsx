import React from 'react';
import {
  Pressable,
  Text,
  ActivityIndicator,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';

export interface LuxuryButtonProps {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'tertiary';
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
  style?: ViewStyle;
  textStyle?: TextStyle;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  testID?: string;
}

/**
 * Premium CTA buttons for the luxury design direction.
 *
 * - `primary`: deep plum fill, ivory text, pill shape, soft shadow.
 * - `secondary`: transparent fill, brushed gold outline, plum text, pill shape.
 * - `tertiary`: minimal text button for low-emphasis actions.
 *
 * All variants maintain a minimum 44dp tappable height and clear accessibility
 * roles/labels.
 */
export function LuxuryButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  loading = false,
  icon,
  style,
  textStyle,
  accessibilityLabel,
  accessibilityHint,
  testID,
}: LuxuryButtonProps) {
  const isPrimary = variant === 'primary';
  const isSecondary = variant === 'secondary';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      style={({ pressed }) => [
        styles.base,
        isPrimary && styles.primary,
        isSecondary && styles.secondary,
        variant === 'tertiary' && styles.tertiary,
        (disabled || loading) && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? title}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: disabled || loading, busy: loading }}
      testID={testID}
    >
      {loading ? (
        <ActivityIndicator
          size="small"
          color={isPrimary ? LUXURY.colors.inverse : LUXURY.colors.plum}
        />
      ) : (
        <>
          {icon}
          <Text
            style={[
              styles.text,
              !icon && styles.textNoIcon,
              isPrimary && styles.primaryText,
              isSecondary && styles.secondaryText,
              variant === 'tertiary' && styles.tertiaryText,
              textStyle,
            ]}
            numberOfLines={1}
          >
            {title}
          </Text>
        </>
      )}
    </Pressable>
  );
}

/** Convenience alias for the primary filled button. */
export const PrimaryButton = (props: LuxuryButtonProps) => (
  <LuxuryButton {...props} variant="primary" />
);

/** Convenience alias for the gold-outlined secondary button. */
export const SecondaryButton = (props: LuxuryButtonProps) => (
  <LuxuryButton {...props} variant="secondary" />
);

/** Convenience alias for the minimal tertiary button. */
export const TertiaryButton = (props: LuxuryButtonProps) => (
  <LuxuryButton {...props} variant="tertiary" />
);

const styles = StyleSheet.create({
  base: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    minHeight: 44,
    paddingHorizontal: SPACING.xl,
  },
  primary: {
    minWidth: LUXURY.buttons.primary.minWidth,
    height: LUXURY.buttons.primary.height,
    borderRadius: LUXURY.buttons.primary.borderRadius,
    backgroundColor: LUXURY.buttons.primary.backgroundColor,
    paddingHorizontal: LUXURY.buttons.primary.paddingHorizontal,
    ...LUXURY.buttons.primary.shadow,
  },
  secondary: {
    minWidth: LUXURY.buttons.secondary.minWidth,
    height: LUXURY.buttons.secondary.height,
    borderRadius: LUXURY.buttons.secondary.borderRadius,
    backgroundColor: LUXURY.buttons.secondary.backgroundColor,
    borderWidth: LUXURY.buttons.secondary.borderWidth,
    borderColor: LUXURY.buttons.secondary.borderColor,
    paddingHorizontal: LUXURY.buttons.secondary.paddingHorizontal,
  },
  tertiary: {
    minHeight: LUXURY.buttons.tertiary.height,
    borderRadius: LUXURY.buttons.tertiary.borderRadius,
    paddingHorizontal: LUXURY.buttons.tertiary.paddingHorizontal,
  },
  disabled: {
    opacity: 0.5,
  },
  pressed: {
    opacity: 0.92,
  },
  text: {
    ...LUXURY.typography.cta,
    marginLeft: SPACING.sm,
  },
  textNoIcon: {
    marginLeft: 0,
  },
  primaryText: {
    color: LUXURY.buttons.primary.color,
    letterSpacing: LUXURY.buttons.primary.letterSpacing,
    fontSize: LUXURY.buttons.primary.fontSize,
    fontWeight: LUXURY.buttons.primary.fontWeight,
  },
  secondaryText: {
    color: LUXURY.buttons.secondary.color,
    letterSpacing: LUXURY.buttons.secondary.letterSpacing,
    fontSize: LUXURY.buttons.secondary.fontSize,
    fontWeight: LUXURY.buttons.secondary.fontWeight,
  },
  tertiaryText: {
    color: LUXURY.buttons.tertiary.color,
    letterSpacing: LUXURY.buttons.tertiary.letterSpacing,
    fontSize: LUXURY.buttons.tertiary.fontSize,
    fontWeight: LUXURY.buttons.tertiary.fontWeight,
    textTransform: 'none',
  },
});
