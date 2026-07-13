import React from 'react';
import { Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';
import { router } from 'expo-router';
import { AnimatedAvatar } from '../avatars/AnimatedAvatar';
import { useAvatarGreeting } from '../../services/avatars/useAvatarGreeting';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

export interface StylistGreetingCardProps {
  actorKey: string;
  avatarId?: string;
  style?: ViewStyle;
  testID?: string;
}

export function StylistGreetingCard({ actorKey, avatarId, style, testID }: StylistGreetingCardProps) {
  const {
    greetingText,
    isSpeaking,
    canSpeak,
    dismiss,
    replay,
    stop,
  } = useAvatarGreeting({ actorKey, avatarId, enabled: true });

  const state = isSpeaking ? 'speaking' : 'idle';

  return (
    <View style={[styles.card, style]} testID={testID ?? 'stylist-greeting-card'}>
      <View style={styles.row}>
        <AnimatedAvatar
          avatarId={avatarId}
          size={56}
          state={state}
          reducedMotion={false}
          style={styles.avatar}
        />
        <View style={styles.text}>
          <Text style={styles.label} numberOfLines={1}>
            YOUR AI STYLIST
          </Text>
          <Text style={styles.greeting} numberOfLines={2}>
            {greetingText}
          </Text>
        </View>
      </View>

      <View style={styles.actions}>
        <Pressable
          testID="stylist-greeting-ask-button"
          onPress={() => router.push('/style-chat')}
          style={({ pressed }) => [styles.askButton, pressed && styles.askButtonPressed]}
          accessibilityRole="button"
          accessibilityLabel="Ask StyleChat"
          accessibilityHint="Open a StyleChat session"
        >
          <Text style={styles.askButtonText}>Ask StyleChat</Text>
        </Pressable>

        {canSpeak && isSpeaking ? (
          <Pressable
            testID="stylist-greeting-stop-button"
            onPress={stop}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Stop greeting"
          >
            <Text style={styles.iconButtonText}>■</Text>
          </Pressable>
        ) : canSpeak ? (
          <Pressable
            testID="stylist-greeting-replay-button"
            onPress={replay}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Replay greeting"
          >
            <Text style={styles.iconButtonText}>▶</Text>
          </Pressable>
        ) : null}

        {isSpeaking ? (
          <Pressable
            testID="stylist-greeting-dismiss-button"
            onPress={dismiss}
            style={({ pressed }) => [styles.iconButton, pressed && styles.iconButtonPressed]}
            accessibilityRole="button"
            accessibilityLabel="Dismiss greeting"
          >
            <Text style={styles.iconButtonText}>✕</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    marginBottom: SPACING.xxl,
    ...SHADOWS.editorialSmall,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
  },
  avatar: {
    flexShrink: 0,
  },
  text: {
    flex: 1,
    minWidth: 0,
    gap: SPACING.xs,
  },
  label: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 10,
    letterSpacing: 1.4,
    color: LUXURY.colors.stone,
  },
  greeting: {
    ...LUXURY.typography.body,
    fontSize: 14,
    lineHeight: 20,
    color: LUXURY.colors.ink,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  askButton: {
    flex: 1,
    minHeight: 40,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
  },
  askButtonPressed: {
    opacity: 0.85,
  },
  askButtonText: {
    ...LUXURY.typography.cta,
    fontSize: 13,
    color: LUXURY.colors.inverse,
  },
  iconButton: {
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: LUXURY.colors.plumMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconButtonPressed: {
    opacity: 0.8,
  },
  iconButtonText: {
    fontSize: 14,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
});
