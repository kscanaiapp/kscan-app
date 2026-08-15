import { useCallback, useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  BackHandler,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { ELISE_IDENTITY } from '../../constants/elise';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { AnimatedStylistAvatar } from '../stylist/AnimatedStylistAvatar';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { useAvatarMotionState } from '../../hooks/useAvatarMotionState';
import {
  useAvatarMotionExpression,
  useAvatarMotionMode,
} from '../../hooks/useAvatarConversationMotion';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import {
  decideMotionAnnouncement,
  getAvatarMotionStatusText,
} from '../../services/avatarMotionStatus';
import type { AvatarMotionMode } from '../../services/avatarMotionState';
import { useAvatarTapAcknowledgement } from '../../hooks/useAvatarTapAcknowledgement';

interface StyleChatHeaderProps {
  showBadge?: boolean;
  isThinking?: boolean;
  sessionId?: string;
  onScanPress?: () => void;
  scanDisabled?: boolean;
  scanDisabledHint?: string;
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
  onScanPress,
  scanDisabled = false,
  scanDisabledHint,
}: StyleChatHeaderProps) {
  const insets = useSafeAreaInsets();
  const { identity } = useStylistIdentity();
  const { user } = useAuthSession();
  const reducedMotion = useReducedMotion();
  // Discrete projection: this subscription emits only when a visible field
  // changes, so the header no longer rerenders on playback-position ticks.
  const speechState = useAvatarMotionState();
  const actorId = user?.id ?? null;
  const isSpeaking =
    Boolean(actorId && sessionId) &&
    speechState.actorId === actorId &&
    speechState.sessionId === sessionId &&
    speechState.stylistId === identity.avatarId &&
    speechState.avatarId === identity.avatarId &&
    speechState.phase === 'playing';
  const mouthState = !isSpeaking || reducedMotion ? 'closed' : speechState.mouth;
  const conversationMode = useAvatarMotionMode();
  const displayName = identity.displayName;
  const headerAccessibilityLabel = `${displayName}, ${ELISE_IDENTITY.role}`;

  const conversationExpression = useAvatarMotionExpression();

  let avatarState: 'idle' | 'listening' | 'thinking' | 'speaking' | 'reacting' = 'idle';
  if (isSpeaking) {
    avatarState = 'speaking';
  } else if (isThinking || conversationMode === 'thinking') {
    avatarState = 'thinking';
  } else if (conversationMode === 'listening') {
    avatarState = 'listening';
  } else if (conversationMode === 'reacting') {
    // KSB29-M02. There was no branch for this at all, so a tap set `reacting`
    // and the renderer silently kept showing idle. Ordered AFTER speaking and
    // thinking so an acknowledgement can never mask a higher-priority state.
    avatarState = 'reacting';
  }

  // Textual equivalent for every semantic state. This is the accessible
  // channel: it exists with motion on, with motion off, and under Reduce
  // Motion, and it never describes playback frames or mouth changes.
  // The ACCESSIBLE status stays idle during a reaction: the acknowledgement is a
  // brief visual courtesy, and announcing it would interrupt a screen-reader
  // user mid-sentence for something that conveys no state change.
  const statusMode: AvatarMotionMode = avatarState === 'reacting' ? 'idle' : avatarState;
  const statusText = getAvatarMotionStatusText({ mode: statusMode, stylistName: displayName });
  const lastAnnouncedRef = useRef<AvatarMotionMode | null>(null);
  useEffect(() => {
    // One announcement per semantic transition; repeats within a state
    // (including every playback tick during speech) are suppressed.
    const decision = decideMotionAnnouncement(
      statusMode,
      lastAnnouncedRef.current,
      displayName,
    );
    lastAnnouncedRef.current = decision.nextAnnouncedMode;
    if (decision.announce && decision.text) {
      AccessibilityInfo.announceForAccessibility(decision.text);
    }
  }, [statusMode, displayName]);

  // Tap acknowledgement: enabled only with the motion flag on. The service
  // arbitrates (idle/listening only, cooldown), so a tap can never interrupt
  // speech, restart completed speech, or reach any backend.
  const { onAvatarPress, enabled: tapAcknowledgementEnabled } = useAvatarTapAcknowledgement({
    displayName,
    reducedMotion,
  });

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
        {tapAcknowledgementEnabled ? (
          <Pressable
            testID="style-chat-avatar-pressable"
            style={styles.avatarWrap}
            accessibilityRole="button"
            accessibilityLabel={`Say hello to ${displayName}`}
            accessibilityHint={`${displayName} gives a brief acknowledgement`}
            hitSlop={{ top: 4, bottom: 4, left: 4, right: 4 }}
            onPress={onAvatarPress}
          >
            <AnimatedStylistAvatar
              avatarId={identity.avatarId}
              size={67}
              state={avatarState}
              mouthState={mouthState}
              expression={conversationExpression}
              reducedMotion={reducedMotion}
              accessibilityLabel={`${displayName} avatar`}
            />
          </Pressable>
        ) : (
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
              expression={conversationExpression}
              reducedMotion={reducedMotion}
              accessibilityLabel={`${displayName} avatar`}
            />
          </View>
        )}

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
            {statusText ?? ELISE_IDENTITY.role}
          </Text>
        </View>
        {statusText ? (
          <Text
            testID="style-chat-avatar-status"
            style={styles.visuallyHiddenStatus}
            accessibilityLiveRegion="polite"
            maxFontSizeMultiplier={1.3}
          >
            {statusText}
          </Text>
        ) : null}
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
          style={({ pressed }) => [styles.navButton, styles.navButtonLeft, pressed ? styles.navButtonPressed : null]}
        >
          <Text style={styles.navButtonText} maxFontSizeMultiplier={1.2}>Home</Text>
        </Pressable>

        {onScanPress ? (
          <Pressable
            testID="style-chat-scan-button"
            accessibilityRole="button"
            accessibilityLabel="Add visual context"
            accessibilityHint={
              scanDisabled
                ? scanDisabledHint ?? 'Remove an image before adding another.'
                : 'Choose the camera or upload images from your photo library'
            }
            accessibilityState={{ disabled: scanDisabled }}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={onScanPress}
            disabled={scanDisabled}
            style={({ pressed }) => [
              styles.navButton,
              styles.navButtonRight,
              pressed && !scanDisabled ? styles.navButtonPressed : null,
              scanDisabled ? styles.navButtonDisabled : null,
            ]}
          >
            <Text style={styles.navButtonText} maxFontSizeMultiplier={1.2}>Scan</Text>
          </Pressable>
        ) : null}
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
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'relative',
    paddingHorizontal: SPACING.xl,
    gap: SPACING.sm,
  },
  navButton: {
    minHeight: 44,
    minWidth: 52,
    justifyContent: 'center',
  },
  navButtonLeft: {
    alignItems: 'flex-start',
  },
  navButtonRight: {
    alignItems: 'flex-end',
  },
  navButtonPressed: {
    opacity: 0.72,
  },
  navButtonDisabled: {
    opacity: 0.38,
  },
  navButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
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
  // Zero-size live region: the visible status already appears under the
  // stylist name, so this exists only to carry polite announcements without
  // changing layout.
  visuallyHiddenStatus: {
    width: 0,
    height: 0,
    opacity: 0,
    position: 'absolute',
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
