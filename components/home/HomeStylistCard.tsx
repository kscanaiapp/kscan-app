import React, { useCallback } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  DEFAULT_STYLIST_IDENTITY,
  type StylistIdentity,
} from '../../constants/stylistIdentity';
import { AnimatedStylistAvatar } from '../stylist/AnimatedStylistAvatar';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useStylistGreeting } from '../../hooks/useStylistGreeting';
import { PrimaryButton } from '../luxury';

const DEFAULT_SUGGESTIONS = [
  'What should I wear tonight?',
  'Help me style this new top.',
  'What looks good with these shoes?',
];

interface HomeStylistCardProps {
  identity: StylistIdentity;
  hasSessions?: boolean;
  onStartConversation: () => void;
  onOpenConversations: () => void;
  onPersonalize: () => void;
  suggestions?: string[];
  disabled?: boolean;
}

export function HomeStylistCard({
  identity,
  hasSessions = false,
  onStartConversation,
  onOpenConversations,
  onPersonalize,
  suggestions = DEFAULT_SUGGESTIONS,
  disabled = false,
}: HomeStylistCardProps) {
  const displayName = identity.displayName || DEFAULT_STYLIST_IDENTITY.displayName;
  const ctaLabel = hasSessions ? 'CONTINUE CONVERSATION' : 'START A CONVERSATION';
  const ctaButtonLabel = hasSessions ? 'Continue chat' : 'Start chat';
  const reducedMotion = useReducedMotion();
  const { greetingText, isSpeaking, canSpeak, dismiss, replay, stop } =
    useStylistGreeting();

  const handleCta = useCallback(() => {
    if (hasSessions) {
      onOpenConversations();
    } else {
      onStartConversation();
    }
  }, [hasSessions, onOpenConversations, onStartConversation]);

  return (
    <View style={styles.section}>
      <View style={styles.sectionHeaderRow}>
        <View style={styles.sectionHeaderLeft}>
          <Text style={styles.sparkle}>✦</Text>
          <Text style={styles.sectionHeaderTitle} accessibilityRole="header">
            YOUR STYLIST
          </Text>
        </View>
        <Pressable
          onPress={onOpenConversations}
          disabled={disabled}
          style={({ pressed }) => [
            styles.sectionHeaderAction,
            pressed && !disabled && styles.sectionHeaderActionPressed,
          ]}
          accessibilityRole="button"
          accessibilityLabel={`Chat with ${displayName}`}
          accessibilityHint="Open your conversations"
        >
          <Text style={styles.sectionHeaderActionText} numberOfLines={1}>
            Chat with {displayName} ›
          </Text>
        </Pressable>
      </View>

      <View style={styles.card}>
        <View style={styles.cardLeft}>
          <View style={styles.avatarWrap}>
            <AnimatedStylistAvatar
              avatarId={identity.avatarId}
              size={72}
              state={isSpeaking ? 'speaking' : 'idle'}
              reducedMotion={reducedMotion}
              accessibilityLabel={`${displayName} avatar`}
            />
          </View>
          <Pressable
            onPress={onPersonalize}
            disabled={disabled}
            style={styles.personalizeLink}
            accessibilityRole="button"
            accessibilityLabel={`Personalize ${displayName}`}
          >
            <Text
              style={styles.personalizeLinkText}
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.85}
            >
              Personalize
            </Text>
          </Pressable>
        </View>

        <View style={styles.cardCenter}>
          <Text style={styles.cardTitle} accessibilityRole="header">
            Ask {displayName}
          </Text>
          <Text style={styles.cardGreeting} numberOfLines={2}>
            {greetingText}
          </Text>
          {canSpeak ? (
            <View style={styles.speechControls}>
              {isSpeaking ? (
                <>
                  <Pressable
                    onPress={stop}
                    style={({ pressed }) => [
                      styles.speechButton,
                      pressed && styles.speechButtonPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Stop greeting"
                  >
                    <Text style={styles.speechButtonText}>■</Text>
                  </Pressable>
                  <Pressable
                    onPress={dismiss}
                    style={({ pressed }) => [
                      styles.speechButton,
                      pressed && styles.speechButtonPressed,
                    ]}
                    accessibilityRole="button"
                    accessibilityLabel="Dismiss greeting"
                  >
                    <Text style={styles.speechButtonText}>✕</Text>
                  </Pressable>
                </>
              ) : (
                <Pressable
                  onPress={replay}
                  style={({ pressed }) => [
                    styles.speechButton,
                    pressed && styles.speechButtonPressed,
                  ]}
                  accessibilityRole="button"
                  accessibilityLabel="Replay greeting"
                >
                  <Text style={styles.speechButtonText}>▶</Text>
                </Pressable>
              )}
            </View>
          ) : null}
          <PrimaryButton
            title={ctaButtonLabel}
            onPress={handleCta}
            disabled={disabled}
            accessibilityLabel={ctaLabel}
            accessibilityHint={
              hasSessions ? 'Continue your current conversation' : 'Start a new conversation'
            }
            style={styles.ctaButton}
            textStyle={styles.ctaButtonText}
          />
        </View>

        <View style={styles.cardRight}>
          {suggestions.slice(0, 3).map((prompt) => (
            <Pressable
              key={prompt}
              onPress={onStartConversation}
              disabled={disabled}
              style={({ pressed }) => [
                styles.promptChip,
                pressed && !disabled && styles.promptChipPressed,
              ]}
              accessibilityRole="button"
              accessibilityLabel={`Example prompt: ${prompt}`}
            >
              <Text style={styles.promptChipText} numberOfLines={2}>
                {prompt}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginBottom: SPACING.xxl,
  },
  sectionHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.md,
    gap: SPACING.sm,
  },
  sectionHeaderLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.xs,
    flex: 1,
    minWidth: 0,
  },
  sparkle: {
    fontSize: 14,
    color: LUXURY.colors.goldBrushed,
  },
  sectionHeaderTitle: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
  },
  sectionHeaderAction: {
    flexShrink: 0,
    minHeight: 44,
    justifyContent: 'center',
  },
  sectionHeaderActionPressed: {
    opacity: 0.7,
  },
  sectionHeaderActionText: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 13,
    color: LUXURY.colors.plum,
  },
  card: {
    flexDirection: 'row',
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    padding: SPACING.lg,
    gap: SPACING.md,
    ...LUXURY.cards?.product?.shadow,
  },
  cardLeft: {
    alignItems: 'center',
    justifyContent: 'center',
    width: 88,
    gap: SPACING.sm,
  },
  avatarWrap: {
    alignItems: 'center',
  },
  personalizeLink: {
    minHeight: 28,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  personalizeLinkText: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    color: LUXURY.colors.plum,
    textDecorationLine: 'underline',
  },
  cardCenter: {
    flex: 1,
    justifyContent: 'center',
    gap: SPACING.sm,
    minWidth: 0,
  },
  cardTitle: {
    ...LUXURY.typography.displayTitle,
    fontSize: 20,
    color: LUXURY.colors.ink,
  },
  cardGreeting: {
    ...LUXURY.typography.body,
    fontSize: 13,
    lineHeight: 20,
    color: LUXURY.colors.graphite,
  },
  speechControls: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
    marginTop: SPACING.xs,
  },
  speechButton: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: LUXURY.colors.plumMuted,
    alignItems: 'center',
    justifyContent: 'center',
  },
  speechButtonPressed: {
    opacity: 0.8,
  },
  speechButtonText: {
    fontSize: 11,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  ctaButton: {
    alignSelf: 'stretch',
    minWidth: 0,
    minHeight: 48,
    paddingHorizontal: SPACING.md,
    marginTop: SPACING.xs,
  },
  ctaButtonText: {
    fontSize: 14,
    lineHeight: 20,
    letterSpacing: 0.2,
    textTransform: 'none',
    textAlign: 'center',
  },
  cardRight: {
    width: 130,
    justifyContent: 'center',
    gap: SPACING.sm,
  },
  promptChip: {
    backgroundColor: LUXURY.colors.cream,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  promptChipPressed: {
    backgroundColor: LUXURY.colors.plumMuted,
  },
  promptChipText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    lineHeight: 16,
    color: LUXURY.colors.graphite,
  },
});
