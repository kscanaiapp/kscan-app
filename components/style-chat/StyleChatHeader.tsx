import { useCallback } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';

interface StyleChatHeaderProps {
  showBadge?: boolean;
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

export function StyleChatHeader({ showBadge = true }: StyleChatHeaderProps) {
  const insets = useSafeAreaInsets();

  return (
    <View testID="style-chat-header" style={styles.container}>
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
          <Text style={styles.title} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.85} maxFontSizeMultiplier={1.2}>
            {STYLE_CHAT_COPY.header}
          </Text>
        </View>

        <View style={styles.rightSpacer} />
      </View>

      <View style={styles.subtitleRow}>
        <Text style={styles.subtitle} numberOfLines={1} maxFontSizeMultiplier={1.2}>
          {STYLE_CHAT_COPY.subtitle}
        </Text>
      </View>

      {showBadge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText} maxFontSizeMultiplier={1.2}>
            {STYLE_CHAT_COPY.premiumBadge}
          </Text>
        </View>
      ) : null}
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
