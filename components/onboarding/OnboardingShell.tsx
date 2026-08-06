import React from 'react';
import { View, StyleSheet, ViewStyle, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, SPACING } from '../../constants/theme';
import { OnboardingStepIndicator } from './OnboardingStepIndicator';
import { getOnboardingBottomClearance } from '../../services/onboardingLayout';

interface OnboardingShellProps {
  children: React.ReactNode;
  step: number;
  totalSteps?: number;
  style?: ViewStyle;
  testID?: string;
}

/**
 * Shared onboarding screen wrapper.
 *
 * - Warm ivory/cream background (luxury design direction).
 * - Step indicator at the top.
 * - Content area with standard padding and keyboard awareness.
 */
export function OnboardingShell({
  children,
  step,
  totalSteps = 6,
  style,
  testID,
}: OnboardingShellProps) {
  const insets = useSafeAreaInsets();

  const content = (
    <View
      testID={testID}
      style={[
        styles.root,
        { backgroundColor: LUXURY.colors.ivory },
        style,
      ]}
      accessibilityLabel="Onboarding screen"
    >
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={[
          styles.content,
          {
            paddingTop: insets.top + SPACING.lg,
            // Floored, not just insets.bottom: a cold-start frame (before
            // native safe-area insets are measured) or a misreported zero
            // inset must never let interactive content render flush with —
            // or inside — the system navigation area (see BUG-01).
            paddingBottom: getOnboardingBottomClearance(insets.bottom, SPACING.xl),
            paddingHorizontal: SPACING.lg,
          },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <OnboardingStepIndicator step={step} totalSteps={totalSteps} />
        {children}
      </ScrollView>
    </View>
  );

  return (
    <KeyboardAvoidingView
      style={styles.keyboard}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      {content}
    </KeyboardAvoidingView>
  );
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
