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

export function useStyleChatHomeBackHandler() {
  useFocusEffect(
    useCallback(() => {
      const subscription = BackHandler.addEventListener('hardwareBackPress', () => {
        navigateStyleChatHome();
        return true;
      });

      return () => {
        subscription.remove();
      };
    }, [])
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
          <Text style={styles.homeButtonText}>HOME</Text>
        </Pressable>

        <View style={styles.titleWrap}>
          <Text style={styles.title}>{STYLE_CHAT_COPY.header}</Text>
          <Text style={styles.subtitle}>{STYLE_CHAT_COPY.subtitle}</Text>
        </View>

        <View style={styles.rightSpacer} />
      </View>
      {showBadge ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>{STYLE_CHAT_COPY.premiumBadge}</Text>
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
    borderBottomColor: COLORS.border,
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
    paddingHorizontal: 64,
  },
  rightSpacer: {
    width: 88,
  },
  title: {
    ...TYPOGRAPHY.brand,
    fontSize: 18,
    letterSpacing: 5,
  },
  subtitle: {
    ...TYPOGRAPHY.caption,
    letterSpacing: 2,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  badge: {
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: 3,
    borderRadius: 3,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: 'rgba(45, 31, 94, 0.45)',
  },
  badgeText: {
    fontSize: 9,
    fontWeight: '700' as const,
    letterSpacing: 2.5,
    color: COLORS.accent,
  },
});
