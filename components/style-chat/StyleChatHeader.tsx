import { useCallback } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
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
          { paddingTop: insets.top > 0 ? SPACING.md : SPACING.xl },
        ]}
      >
        <Pressable
          testID="style-chat-home-button"
          accessibilityRole="button"
          accessibilityLabel="Return to Home"
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          onPress={navigateStyleChatHome}
          style={({ pressed }) => [styles.homeButton, pressed ? styles.homeButtonPressed : null]}
        >
          <Text style={styles.homeButtonText} maxFontSizeMultiplier={1.2}>HOME</Text>
        </Pressable>

        <View style={styles.titleWrap}>
          <Text style={styles.title} numberOfLines={1} maxFontSizeMultiplier={1.2}>
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
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.darkOverlayBorder,
    backgroundColor: COLORS.bg,
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
    minWidth: 88,
    justifyContent: 'center',
  },
  homeButtonPressed: {
    opacity: 0.72,
  },
  homeButtonText: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.chrome,
    letterSpacing: 3,
  },
  titleWrap: {
    flex: 1,
    alignItems: 'center',
    minWidth: 0,
  },
  rightSpacer: {
    width: 88,
  },
  title: {
    ...TYPOGRAPHY.brand,
    fontSize: 18,
    letterSpacing: 3,
  },
  subtitleRow: {
    width: '100%',
    paddingHorizontal: SPACING.xl,
    marginTop: SPACING.xs,
    alignItems: 'center',
  },
  subtitle: {
    ...TYPOGRAPHY.caption,
    letterSpacing: 2,
    color: COLORS.textSecondary,
    textAlign: 'center',
  },
  badge: {
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    borderRadius: 3,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(214, 179, 106, 0.24)',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '600' as const,
    letterSpacing: 2.2,
    color: COLORS.chromeMuted,
  },
});
