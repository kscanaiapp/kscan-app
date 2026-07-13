import { useCallback } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { ELISE_IDENTITY } from '../../constants/elise';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { AnimatedStylistAvatar } from '../stylist/AnimatedStylistAvatar';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useStylistGreeting } from '../../hooks/useStylistGreeting';

interface StyleChatHeaderProps {
  showBadge?: boolean;
  isThinking?: boolean;
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

export function StyleChatHeader({ showBadge = true, isThinking = false }: StyleChatHeaderProps) {
  const insets = useSafeAreaInsets();
  const { identity } = useStylistIdentity();
  const reducedMotion = useReducedMotion();
  const { greetingText, isSpeaking, canSpeak } = useStylistGreeting();
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
      accessibilityRole="header"
      accessibilityLabel={headerAccessibilityLabel}
    >
      <View
        style={[
          styles.topRow,
          { paddingTop: Math.max(SPACING.xl, insets.top + SPACING.sm) },
        ]}
      >
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

        <View style={styles.titleWrap}>
          <Text
            style={styles.title}
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.85}
            maxFontSizeMultiplier={1.2}
            accessibilityLabel={headerAccessibilityLabel}
          >
            {displayName}
          </Text>
        </View>

        <View style={styles.rightSpacer} />
      </View>

      <View style={styles.stylistRow}>
        <AnimatedStylistAvatar
          avatarId={identity.avatarId}
          size={40}
          state={avatarState}
          reducedMotion={reducedMotion}
          accessibilityLabel={`${displayName} avatar`}
        />
        <View style={styles.stylistText}>
          <Text style={styles.stylistName} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            {displayName}
          </Text>
          <Text style={styles.stylistGreeting} numberOfLines={1} maxFontSizeMultiplier={1.2}>
            {greetingText}
          </Text>
        </View>
        <View
          style={[
            styles.statusDot,
            isSpeaking && styles.statusDotActive,
            isThinking && !isSpeaking && styles.statusDotThinking,
          ]}
          accessibilityLabel={
            isSpeaking ? `${displayName} is speaking` : isThinking ? `${displayName} is thinking` : `${displayName} is idle`
          }
        />
        {showBadge ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText} maxFontSizeMultiplier={1.2}>
              {STYLE_CHAT_COPY.premiumBadge}
            </Text>
          </View>
        ) : null}
      </View>

    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingBottom: SPACING.lg,
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
  },
  homeButton: {
    minHeight: 44,
    minWidth: 60,
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
  titleWrap: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  rightSpacer: {
    width: 60,
  },
  title: {
    ...LUXURY.typography.brandMark,
    fontSize: 18,
    letterSpacing: 2,
    color: LUXURY.colors.ink,
    textAlign: 'center',
    width: '100%',
  },
  stylistRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
    marginTop: SPACING.sm,
    gap: SPACING.sm,
  },
  stylistText: {
    flex: 1,
    minWidth: 0,
  },
  stylistName: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    color: LUXURY.colors.ink,
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
  subtitleRow: {
    width: '100%',
    paddingHorizontal: SPACING.xl,
    marginTop: SPACING.xs,
    alignItems: 'center',
  },
  subtitle: {
    ...LUXURY.typography.caption,
    letterSpacing: 1.6,
    fontSize: 10,
    color: LUXURY.colors.goldBrushed,
    textAlign: 'center',
  },
  badge: {
    marginTop: SPACING.sm,
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
