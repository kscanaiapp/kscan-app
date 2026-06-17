import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';

interface OnboardingStepIndicatorProps {
  step: number;
  totalSteps?: number;
}

/**
 * Simple step indicator for the onboarding flow.
 *
 * Renders "STEP X OF N" with luxury micro-label styling.
 */
export function OnboardingStepIndicator({
  step,
  totalSteps = 6,
}: OnboardingStepIndicatorProps) {
  return (
    <View style={styles.root} testID="onboarding-step-indicator">
      <Text style={styles.label}>
        STEP {step} OF {totalSteps}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    alignItems: 'center',
    paddingVertical: SPACING.md,
  },
  label: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 11,
    letterSpacing: 3,
    color: LUXURY.colors.stone,
  },
});
