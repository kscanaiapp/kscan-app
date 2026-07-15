import { useCallback } from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { ELISE_IDENTITY } from '../../constants/elise';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';

interface StyleChatHeaderProps {
  showBadge?: boolean;
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
  showBadge = true,
  onScanPress,
  scanDisabled = false,
  scanDisabledHint,
}: StyleChatHeaderProps) {
  const insets = useSafeAreaInsets();
  const { identity } = useStylistIdentity();
  const displayName = identity.displayName;
  const headerAccessibilityLabel = `${displayName}, ${ELISE_IDENTITY.role}`;

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
        ) : (
          <View style={styles.rightSpacer} />
        )}
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
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    position: 'relative',
    paddingHorizontal: SPACING.xl,
  },
  navButton: {
    minHeight: 44,
    width: 72,
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
  titleWrap: {
    position: 'absolute',
    left: 96,
    right: 96,
    alignItems: 'center',
    minWidth: 0,
  },
  rightSpacer: {
    width: 72,
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
