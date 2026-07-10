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
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';

export interface TextScanHeaderProps {
  title?: string;
  onBack?: () => void;
  backLabel?: string;
  rightAction?: React.ReactNode;
  style?: ViewStyle;
  titleStyle?: TextStyle;
  accessibilityLabel?: string;
}

/**
 * TextScan editorial header.
 *
 * - Centered serif "TextScan" title.
 * - Back chevron on the left.
 * - Optional trailing slot for the AI STAR badge.
 */
export function TextScanHeader({
  title = 'TextScan',
  onBack,
  backLabel = 'Back',
  rightAction,
  style,
  titleStyle,
  accessibilityLabel,
}: TextScanHeaderProps) {
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
            accessibilityLabel={backLabel}
          >
            <Text style={styles.backChevron}>‹</Text>
          </Pressable>
        ) : (
          <View style={styles.backPlaceholder} />
        )}

        <View style={styles.center}>
          <Text
            style={[LUXURY.typography.displayTitle, styles.title, titleStyle]}
            numberOfLines={1}
            ellipsizeMode="tail"
          >
            {title}
          </Text>
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
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  backPlaceholder: {
    minWidth: 44,
    minHeight: 44,
  },
  backChevron: {
    fontSize: 32,
    lineHeight: 34,
    color: LUXURY.colors.plum,
    fontWeight: '300',
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.sm,
  },
  title: {
    textAlign: 'center',
    color: LUXURY.colors.plumDeep,
  },
  trailing: {
    minWidth: 44,
    minHeight: 44,
    alignItems: 'flex-end',
    justifyContent: 'center',
  },
});
