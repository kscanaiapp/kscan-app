import { View, Text, StyleSheet } from 'react-native';
import { COLORS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';

interface StyleChatHeaderProps {
  showBadge?: boolean;
}

export function StyleChatHeader({ showBadge = true }: StyleChatHeaderProps) {
  return (
    <View testID="style-chat-header" style={styles.container}>
      <Text style={styles.title}>{STYLE_CHAT_COPY.header}</Text>
      <Text style={styles.subtitle}>{STYLE_CHAT_COPY.subtitle}</Text>
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
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.lg,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
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
