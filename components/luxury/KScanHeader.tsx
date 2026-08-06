import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, SPACING, RADIUS } from '../../constants/theme';

export interface KScanHeaderProps {
  title?: string;
  subtitle?: string;
  /** Show a serif brand mark before the title. */
  showBrandMark?: boolean;
  /** Optional visible brand label when showBrandMark is enabled. */
  brandLabel?: string;
  /** Called when the back/close area is pressed. */
  onBack?: () => void;
  /** Optional back button label; defaults to "Back". */
  backLabel?: string;
  /** Optional node rendered in the trailing slot. */
  rightAction?: React.ReactNode;
  /** Override the root container style. */
  style?: ViewStyle;
  /** Override the title text style. */
  titleStyle?: TextStyle;
  /** Override the brand mark text style. */
  brandMarkStyle?: TextStyle;
  /** Override the subtitle text style. */
  subtitleStyle?: TextStyle;
  /** Accessibility label for the header landmark. */
  accessibilityLabel?: string;
}

/**
 * A premium editorial header for K Scan screens.
 *
 * - Uses safe-area-aware top padding.
 * - Renders a serif title / brand mark for luxury moments.
 * - Back button and optional trailing action are tappable targets (min 44dp).
 */
export function KScanHeader({
  title,
  subtitle,
  showBrandMark = false,
  brandLabel = 'K Scan',
  onBack,
  backLabel = 'Back',
  rightAction,
  style,
  titleStyle,
  brandMarkStyle,
  subtitleStyle,
  accessibilityLabel,
}: KScanHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top + SPACING.md },
        style,
      ]}
      accessibilityRole="header"
      accessibilityLabel={accessibilityLabel ?? title}
    >
      <View style={styles.row}>
        {onBack ? (
          <Pressable
            onPress={onBack}
            style={styles.backButton}
            accessibilityRole="button"
            accessibilityLabel={backLabel === 'Back' ? 'Go back' : backLabel}
          >
            <Text style={styles.backChevron}>‹</Text>
            <Text style={styles.backLabel}>{backLabel}</Text>
          </Pressable>
        ) : (
          <View style={styles.backPlaceholder} />
        )}

        <View style={styles.center}>
          {showBrandMark && (
            <Text
              style={[styles.brandMark, brandMarkStyle]}
              accessibilityRole="text"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              {brandLabel}
            </Text>
          )}
          {title && !showBrandMark && (
            <Text
              style={[LUXURY.typography.displayTitle, styles.title, titleStyle]}
              // Wrap onto a second line before truncating — at increased
              // font/display scaling a single line is not enough room for
              // titles like "Dressing Rooms" and it must never render as
              // "Dressing Roo…" (see BUG-07). ellipsizeMode remains a safety
              // net for the rare title that still overflows two lines.
              numberOfLines={2}
              ellipsizeMode="tail"
              accessibilityRole="header"
            >
              {title}
            </Text>
          )}
          {subtitle && (
            <Text
              style={[LUXURY.typography.caption, styles.subtitle, subtitleStyle]}
              numberOfLines={1}
              ellipsizeMode="tail"
            >
              {subtitle}
            </Text>
          )}
        </View>

        <View style={styles.trailing}>
          {rightAction}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    paddingHorizontal: SPACING.lg,
    paddingBottom: SPACING.lg,
    backgroundColor: 'transparent',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  backButton: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 44,
    minHeight: 44,
    paddingRight: SPACING.sm,
  },
  backPlaceholder: {
    minWidth: 44,
    minHeight: 44,
  },
  backChevron: {
    fontSize: 26,
    lineHeight: 30,
    color: LUXURY.colors.plum,
    marginRight: SPACING.xs,
    fontWeight: '300',
  },
  backLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textTransform: 'none',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  title: {
    textAlign: 'center',
  },
  subtitle: {
    marginTop: SPACING.xs,
    textAlign: 'center',
  },
  brandMark: {
    ...LUXURY.typography.brandMark,
    color: LUXURY.colors.ink,
  },
  trailing: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
});
