import { useState } from 'react';
import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { GenderStylingContext } from '../../constants/genderStylingContext';

const OPTIONS: { value: GenderStylingContext; label: string }[] = [
  { value: 'man', label: 'Man' },
  { value: 'woman', label: 'Woman' },
  { value: 'prefer_not_to_say', label: 'Choose not to say' },
];

/**
 * First-use gate shown in place of the Elise entry point when no
 * gender_styling_context is stored yet. Dismissed only after a successful
 * save (the caller re-renders normally once `useGenderStylingContext().value`
 * becomes non-null) — a failed save leaves this card mounted so the user can
 * retry without losing their place.
 */
export function GenderStylingContextPrompt({
  onSelect,
  saving,
  error,
}: {
  onSelect: (value: GenderStylingContext) => void;
  saving?: boolean;
  error?: string | null;
}) {
  const [pending, setPending] = useState<GenderStylingContext | null>(null);

  return (
    <View style={styles.wrap} testID="gender-styling-context-prompt">
      <View style={styles.card} accessibilityRole="summary">
        <Text style={styles.title} accessibilityRole="header">
          Are you a:
        </Text>
        <Text style={styles.body}>
          This helps Elise give you a better starting point. You can change this later.
        </Text>
        <View style={styles.options}>
          {OPTIONS.map((option) => {
            const isPending = saving && pending === option.value;
            return (
              <Pressable
                key={option.value}
                onPress={() => {
                  setPending(option.value);
                  onSelect(option.value);
                }}
                disabled={saving}
                style={({ pressed }) => [
                  styles.optionBtn,
                  pressed && !saving && styles.optionBtnPressed,
                ]}
                accessibilityRole="button"
                accessibilityLabel={option.label}
                accessibilityState={{ disabled: saving, busy: isPending }}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
              >
                {isPending ? (
                  <ActivityIndicator size="small" color={LUXURY.colors.inverse} />
                ) : (
                  <Text style={styles.optionText}>{option.label}</Text>
                )}
              </Pressable>
            );
          })}
        </View>
        {error ? (
          <Text testID="gender-styling-context-error" style={styles.error} accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    backgroundColor: LUXURY.colors.ivory,
  },
  card: {
    width: '100%',
    maxWidth: 420,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    color: LUXURY.colors.ink,
    marginBottom: SPACING.sm,
    textAlign: 'center',
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 19,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
    marginBottom: SPACING.lg,
  },
  options: {
    gap: SPACING.sm,
  },
  optionBtn: {
    minHeight: 48,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumSoft,
  },
  optionBtnPressed: {
    opacity: 0.85,
  },
  optionText: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    fontWeight: '600',
    color: LUXURY.colors.inverse,
    letterSpacing: 0.4,
  },
  error: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
});
