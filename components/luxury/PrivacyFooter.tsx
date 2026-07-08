import React from 'react';
import {
  View,
  Text,
  Pressable,
  StyleSheet,
  ViewStyle,
  TextStyle,
} from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';

export interface PrivacyFooterProps {
  /** Called when the user taps the Privacy Policy link. */
  onPrivacyPress?: () => void;
  /** Called when the user taps the Data / Deletion link. */
  onDataPress?: () => void;
  /** Additional trust copy to show above the links. */
  trustCopy?: string;
  /** Test ID for the Privacy Policy link. */
  privacyTestID?: string;
  /** Test ID for the Data & Deletion link. */
  dataTestID?: string;
  /** Override root style. */
  style?: ViewStyle;
  /** Override trust text style. */
  trustStyle?: TextStyle;
  /** Override link text style. */
  linkStyle?: TextStyle;
}

/**
 * A privacy-first footer suitable for auth, home, and profile screens.
 *
 * Uses only claims already supported by the app and privacy policy:
 * - "Private by design"
 * - "Your data stays under your control"
 *
 * No "end-to-end encrypted" or other unsupported security claims are made.
 */
export function PrivacyFooter({
  onPrivacyPress,
  onDataPress,
  trustCopy,
  privacyTestID,
  dataTestID,
  style,
  trustStyle,
  linkStyle,
}: PrivacyFooterProps) {
  return (
    <View style={[styles.root, style]}>
      <Text style={[styles.trust, trustStyle]}>
        {trustCopy ?? 'Private by design. Your data stays under your control.'}
      </Text>

      <View style={styles.links}>
        {onPrivacyPress && (
          <Pressable
            testID={privacyTestID}
            onPress={onPrivacyPress}
            accessibilityRole="link"
            accessibilityLabel="Privacy Policy"
          >
            <Text style={[styles.link, linkStyle]}>Privacy Policy</Text>
          </Pressable>
        )}

        {onPrivacyPress && onDataPress && (
          <Text style={styles.divider}>·</Text>
        )}

        {onDataPress && (
          <Pressable
            testID={dataTestID}
            onPress={onDataPress}
            accessibilityRole="link"
            accessibilityLabel="Data and deletion requests"
          >
            <Text style={[styles.link, linkStyle]}>Data & Deletion</Text>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    paddingVertical: SPACING.xl,
    paddingHorizontal: SPACING.lg,
  },
  trust: {
    ...LUXURY.typography.caption,
    textAlign: 'center',
    color: LUXURY.colors.stone,
    lineHeight: 18,
  },
  links: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: SPACING.sm,
  },
  link: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    textDecorationLine: 'underline',
    textTransform: 'none',
    letterSpacing: 0.5,
    minHeight: 44,
    textAlignVertical: 'center',
  },
  divider: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.borderStrong,
    marginHorizontal: SPACING.sm,
  },
});
