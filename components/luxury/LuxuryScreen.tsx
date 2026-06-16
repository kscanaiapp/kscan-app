import React from 'react';
import {
  View,
  ScrollView,
  StyleSheet,
  ViewStyle,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, SPACING } from '../../constants/theme';

export interface LuxuryScreenProps {
  children: React.ReactNode;
  /** Background color of the screen. Defaults to warm ivory. */
  backgroundColor?: string;
  /** Whether to wrap content in a ScrollView. Defaults to true. */
  scrollable?: boolean;
  /** Whether to respect safe-area insets. Defaults to true. */
  safeArea?: boolean;
  /** Whether to use a KeyboardAvoidingView wrapper. Defaults to true on iOS. */
  keyboardAvoiding?: boolean;
  /** Extra bottom padding to clear floating CTAs or home indicator. */
  bottomPadding?: number;
  /** Override root style. */
  style?: ViewStyle;
  /** Override content container style. */
  contentContainerStyle?: ViewStyle;
  /** Accessibility label for the screen landmark. */
  accessibilityLabel?: string;
}

/**
 * A consistent premium screen wrapper for light luxury surfaces.
 *
 * - Warm ivory/cream background aligned with the luxury mockups.
 * - Safe-area aware top/bottom padding.
 * - Optional ScrollView and KeyboardAvoidingView.
 */
export function LuxuryScreen({
  children,
  backgroundColor = LUXURY.colors.ivory,
  scrollable = true,
  safeArea = true,
  keyboardAvoiding = Platform.OS === 'ios',
  bottomPadding = SPACING.xxxl,
  style,
  contentContainerStyle,
  accessibilityLabel,
}: LuxuryScreenProps) {
  const insets = useSafeAreaInsets();

  const content = (
    <View
      style={[
        styles.root,
        { backgroundColor },
        style,
      ]}
      accessibilityLabel={accessibilityLabel}
    >
      {scrollable ? (
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={[
            styles.content,
            {
              paddingTop: safeArea ? insets.top : 0,
              paddingBottom: (safeArea ? insets.bottom : 0) + bottomPadding,
              paddingHorizontal: SPACING.lg,
            },
            contentContainerStyle,
          ]}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
        >
          {children}
        </ScrollView>
      ) : (
        <View
          style={[
            styles.content,
            {
              paddingTop: safeArea ? insets.top : 0,
              paddingBottom: (safeArea ? insets.bottom : 0) + bottomPadding,
              paddingHorizontal: SPACING.lg,
            },
            contentContainerStyle,
          ]}
        >
          {children}
        </View>
      )}
    </View>
  );

  if (keyboardAvoiding) {
    return (
      <KeyboardAvoidingView
        style={[styles.keyboard, { backgroundColor }]}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        {content}
      </KeyboardAvoidingView>
    );
  }

  return content;
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
  keyboard: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
  },
});
