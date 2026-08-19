import { useCallback, useEffect, useMemo } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { ELISE_IDENTITY } from '../../constants/elise';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { AnimatedStylistAvatar } from '../stylist/AnimatedStylistAvatar';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useAvatarSpeechState } from '../../stores/avatarSpeechStore';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { deriveAvatarMouthState } from '../../services/avatarSpeechMotion';
import { isAvatarEngineActive } from '../../services/avatars/avatarVisualMode';
import { resolveAvatarMotionEpoch } from '../../services/avatars/avatarMotionEpoch';
import { observeAvatarShadowFrame } from '../../services/avatars/avatarShadowBridge';

interface StyleChatHeaderProps {
  showBadge?: boolean;
  isThinking?: boolean;
  sessionId?: string;
}

export function navigateStyleChatHome() {
  router.dismissTo('/');
}

export function useStyleChatHomeBackHandler(bypassRef?: { current: boolean }) {
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        if (bypassRef?.current) return false;
        navigateStyleChatHome();
        return true;
      });

      return () => {
        subscription.remove();
      };
    }, [bypassRef])
  );
}

export function StyleChatHeader({
  showBadge = false,
  isThinking = false,
  sessionId,
}: StyleChatHeaderProps) {
  const insets = useSafeAreaInsets();
  const { identity } = useStylistIdentity();
  const { user } = useAuthSession();
  const reducedMotion = useReducedMotion();
  const speechState = useAvatarSpeechState();
  const actorId = user?.id ?? null;
  const isSpeaking =
    Boolean(actorId && sessionId) &&
    speechState.actorId === actorId &&
    speechState.sessionId === sessionId &&
    speechState.stylistId === identity.avatarId &&
    speechState.avatarId === identity.avatarId &&
    speechState.phase === 'playing';
  const mouthState = useMemo(() => {
    if (!isSpeaking) return 'closed';
    return deriveAvatarMouthState({
      phase: speechState.phase,
      playbackSeconds: speechState.playbackSeconds,
      alignment: speechState.alignment,
      reducedMotion,
    });
  }, [isSpeaking, speechState.phase, speechState.playbackSeconds, speechState.alignment, reducedMotion]);

  // Avatar Engine V10 shadow observation.
  //
  // The legacy value above is computed, rendered and remains authoritative.
  // V10 recalculates the SAME snapshot and records metrics, then its answer is
  // discarded. Nothing below changes a pixel.
  //
  // It runs in an effect rather than during render for two reasons: the visible
  // path must not pay for V10's calculation, and a shadow system must never sit
  // between the host and what it draws. It also reuses the `speechState` this
  // component already subscribed to, so no second subscription, no duplicated
  // speech state and no second playback clock is introduced.
  const engineActive = isAvatarEngineActive();
  useEffect(() => {
    if (!engineActive) return;
    observeAvatarShadowFrame({
      avatarId: identity.avatarId,
      speech: speechState,
      scopeMatches: isSpeaking,
      reduceMotion: reducedMotion,
      foreground: true,
      motionEpoch: resolveAvatarMotionEpoch({
        actorId,
        sessionId: sessionId ?? null,
        avatarId: identity.avatarId,
      }),
      hostNowMs: Date.now(),
      legacyMouthState: mouthState,
    });
  }, [engineActive, identity.avatarId, speechState, isSpeaking, reducedMotion, actorId, sessionId, mouthState]);

  const displayName = identity.displayName;
  const headerAccessibilityLabel = `${displayName}, ${ELISE_IDENTITY.role}`;

  let avatarState: 'idle' | 'thinking' | 'speaking' = 'idle';
  if (isSpeaking) {
    avatarState = 'speaking';
  } else if (isThinking) {
    avatarState = 'thinking';
  }

  return (
    <View
      testID="style-chat-header"
      style={styles.container}
    >
      <View
        style={[
          styles.topRow,
          { paddingTop: Math.max(SPACING.xl, insets.top + SPACING.sm) },
        ]}
      >
        <View
          style={styles.avatarWrap}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        >
          <AnimatedStylistAvatar
            avatarId={identity.avatarId}
            size={67}
            state={avatarState}
            mouthState={mouthState}
            reducedMotion={reducedMotion}
            accessibilityLabel={`${displayName} avatar`}
          />
        </View>

        <View
          style={styles.stylistText}
          accessible
          accessibilityRole="header"
          accessibilityLabel={headerAccessibilityLabel}
        >
          <Text style={styles.stylistName} numberOfLines={1} maxFontSizeMultiplier={1.4}>
            {displayName}
          </Text>
          <Text style={styles.stylistGreeting} numberOfLines={1} maxFontSizeMultiplier={1.3}>
            {ELISE_IDENTITY.role}
          </Text>
        </View>
        {isSpeaking || isThinking ? (
          <View
            style={[
              styles.statusDot,
              isSpeaking && styles.statusDotActive,
              isThinking && !isSpeaking && styles.statusDotThinking,
            ]}
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
          />
        ) : null}
        {showBadge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} maxFontSizeMultiplier={1.2}>
              {STYLE_CHAT_COPY.premiumBadge}
            </Text>
          </View>
        ) : null}

        <Pressable
          testID="style-chat-home-button"
          accessibilityRole="button"
          accessibilityLabel="Return to Home"
          accessibilityHint="Closes StyleChat and returns to the Home screen"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={navigateStyleChatHome}
          style={({ pressed }) => [styles.homeButton, pressed ? styles.homeButtonPressed : null]}
        >
          <Text style={styles.homeButtonText} maxFontSizeMultiplier={1.2}>Home</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingBottom: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.ivory,
    zIndex: 10,
    elevation: 4,
  },
  topRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
    gap: SPACING.sm,
  },
  homeButton: {
    minHeight: 44,
    minWidth: 52,
    justifyContent: 'center',
  },
  homeButtonPressed: {
    opacity: 0.72,
  },
  homeButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
    textTransform: 'none',
  },
  avatarWrap: {
    flexShrink: 0,
  },
  stylistText: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
  },
  stylistName: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    color: LUXURY.colors.ink,
    flexShrink: 1,
  },
  stylistGreeting: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.graphite,
    marginTop: 2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: LUXURY.colors.borderStrong,
    flexShrink: 0,
  },
  statusDotActive: {
    backgroundColor: LUXURY.colors.success,
  },
  statusDotThinking: {
    backgroundColor: LUXURY.colors.gold,
  },
  badge: {
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'rgba(198, 161, 91, 0.10)',
  },
  badgeText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 2.2,
    color: LUXURY.colors.goldText,
  },
});
