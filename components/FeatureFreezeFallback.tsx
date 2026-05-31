import React from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { COLORS, LAYOUT, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../constants/theme';
import { useFeatureFreeze } from '../hooks/useFeatureFreeze';

type FeatureFreezeFallbackProps = {
  cta?: 'closet' | 'scan';
  loading?: boolean;
};

export function FeatureFreezeFallback({ cta = 'closet', loading = false }: FeatureFreezeFallbackProps) {
  const { message } = useFeatureFreeze();
  const label = cta === 'scan' ? 'START SCAN' : 'BACK TO CLOSET';
  const target = cta === 'scan' ? '/scan' : '/library';

  return (
    <View style={styles.root}>
      <View style={styles.panel}>
        <Text style={styles.eyebrow}>TEMPORARILY UNAVAILABLE</Text>
        {loading ? (
          <ActivityIndicator color={COLORS.accent} />
        ) : (
          <>
            <Text style={styles.message}>{message}</Text>
            <Pressable
              accessibilityRole="button"
              style={({ pressed }) => [styles.button, pressed ? styles.buttonPressed : null]}
              onPress={() => router.replace(target)}
            >
              <Text style={styles.buttonText}>{label}</Text>
            </Pressable>
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    justifyContent: 'center',
    backgroundColor: COLORS.canvasWarm,
    paddingHorizontal: LAYOUT.screenPadding,
  },
  panel: {
    borderRadius: RADIUS.lg,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    padding: SPACING.xl,
    gap: SPACING.lg,
    ...SHADOWS.editorialRaised,
  },
  eyebrow: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    textAlign: 'center',
  },
  message: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextPrimary,
    textAlign: 'center',
  },
  button: {
    minHeight: 50,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.gold,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
  },
  buttonPressed: {
    opacity: 0.82,
  },
  buttonText: {
    ...TYPOGRAPHY.cta,
    color: COLORS.textInverse,
  },
});
