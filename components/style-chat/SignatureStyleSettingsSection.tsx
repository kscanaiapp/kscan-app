import { useCallback, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { PrivacyToggle } from '../PrivacyToggle';
import { useStyleDnaPreferences } from '../../hooks/useStyleDnaPreferences';
import { resetLocalStyleDnaProfile } from '../../services/style-dna/localStyleDnaProfile';
import { SectionHeader } from '../luxury';

interface SignatureStyleSettingsSectionProps {
  userKey: string | null | undefined;
}

export function SignatureStyleSettingsSection({ userKey }: SignatureStyleSettingsSectionProps) {
  const { preferences, loading, updatePreferences } = useStyleDnaPreferences({ userKey });
  const [isResetting, setIsResetting] = useState(false);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  const handlePreferenceChange = useCallback(
    async (update: Parameters<typeof updatePreferences>[0]) => {
      setPreferenceError(null);
      try {
        await updatePreferences(update);
      } catch {
        setPreferenceError("Couldn't save Signature Style settings. Please try again.");
      }
    },
    [updatePreferences],
  );

  const handleReset = useCallback(() => {
    if (!userKey || isResetting) return;
    Alert.alert(
      'Reset Signature Style?',
      'This removes the Signature Style preferences learned from your feedback on this device. It does not affect your account, chats, portraits, or other settings.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setIsResetting(true);
            try {
              await resetLocalStyleDnaProfile(userKey);
            } catch {
              Alert.alert('Could not reset Signature Style', 'Please try again.');
            } finally {
              setIsResetting(false);
            }
          },
        },
      ],
    );
  }, [userKey, isResetting]);

  if (!userKey) {
    return (
      <View style={styles.card}>
        <SectionHeader title="Signature Style" subtitle="Sign in to manage your learning preferences" />
        <Text style={styles.disabledBody}>
          Signature Style learning is available once you are signed in.
        </Text>
      </View>
    );
  }

  return (
    <View style={styles.card}>
      <SectionHeader
        title="Signature Style"
        subtitle="Control how Elise learns from your feedback"
      />

      {loading ? (
        <View style={styles.loadingRow}>
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.loadingText}>Loading preferences…</Text>
        </View>
      ) : (
        <>
          <PrivacyToggle
            title="Learn from my feedback"
            body="Allow Elise to learn when you choose to rate a recommendation."
            value={preferences.learnFromFeedback}
            disabled={loading}
            onChange={(value) => {
              void handlePreferenceChange({ learnFromFeedback: value });
            }}
          />

          <PrivacyToggle
            title="Show feedback controls in conversations"
            body={
              preferences.learnFromFeedback
                ? 'Display optional feedback actions on eligible recommendations.'
                : 'Available when feedback learning is turned on.'
            }
            value={preferences.showFeedbackControls}
            disabled={loading || !preferences.learnFromFeedback}
            onChange={(value) => {
              void handlePreferenceChange({ showFeedbackControls: value });
            }}
          />

          {preferenceError ? (
            <Text style={styles.preferenceError} accessibilityLiveRegion="polite">
              {preferenceError}
            </Text>
          ) : null}

          <Pressable
            onPress={handleReset}
            disabled={isResetting}
            style={({ pressed }) => [
              styles.resetButton,
              pressed && !isResetting ? styles.resetButtonPressed : null,
            ]}
            accessibilityRole="button"
            accessibilityLabel="Reset Signature Style"
            accessibilityHint="Clears learned Signature Style preferences for this account on this device"
            accessibilityState={{ disabled: isResetting, busy: isResetting }}
          >
            {isResetting ? (
              <ActivityIndicator size="small" color={LUXURY.colors.error} />
            ) : (
              <Text style={styles.resetText}>Reset Signature Style</Text>
            )}
          </Pressable>

          <Text style={styles.microcopy}>
            Signature Style data is stored on this device only. Turning learning off does not erase
            existing preferences; reset clears them.
          </Text>
        </>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    borderRadius: RADIUS.xl,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    gap: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  loadingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    paddingVertical: SPACING.md,
  },
  loadingText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  disabledBody: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  resetButton: {
    minHeight: 44,
    justifyContent: 'center',
    alignItems: 'flex-start',
    paddingHorizontal: SPACING.sm,
    marginTop: SPACING.xs,
  },
  resetButtonPressed: {
    opacity: 0.68,
  },
  resetText: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.error,
    fontWeight: '600',
    letterSpacing: 0.8,
  },
  microcopy: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    lineHeight: 15,
    color: LUXURY.colors.stone,
    marginTop: SPACING.xs,
  },
  preferenceError: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    fontSize: 11,
    lineHeight: 16,
  },
});
