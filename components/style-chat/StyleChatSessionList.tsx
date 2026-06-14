import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import type { StyleChatSession } from '../../services/style-chat/types';

interface StyleChatSessionListProps {
  sessions: StyleChatSession[];
  loading: boolean;
  error: string | null;
  onNewSession: () => void;
  onSelectSession?: (session: StyleChatSession) => void;
  onDeleteSession?: (session: StyleChatSession) => void;
  newSessionDisabled?: boolean;
}

export function StyleChatSessionList({
  sessions,
  loading,
  error,
  onNewSession,
  onSelectSession,
  onDeleteSession,
  newSessionDisabled = false,
}: StyleChatSessionListProps) {
  const insets = useSafeAreaInsets();
  const safeSessions = Array.isArray(sessions) ? sessions : [];
  const safeContainerPadding = {
    paddingLeft: Math.max(SPACING.xl, insets.left),
    paddingRight: Math.max(SPACING.xl, insets.right),
  };

  return (
    <View testID="style-chat-session-list" style={[styles.container, safeContainerPadding]}>
      {loading ? (
        <View style={styles.centred}>
          <ActivityIndicator size="small" color={COLORS.accent} />
        </View>
      ) : error ? (
        <View style={styles.centred}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : safeSessions.length === 0 ? (
        <View testID="style-chat-empty-state" style={styles.centred}>
          <Text style={styles.emptyText}>{STYLE_CHAT_COPY.emptySessionList}</Text>
        </View>
      ) : (
        safeSessions.map(session => {
          const title = typeof session.title === 'string' && session.title.trim()
            ? session.title
            : 'New Styling Session';
          const mode = typeof session.mode === 'string'
            ? session.mode.replace(/_/g, ' ').toUpperCase()
            : 'GENERAL';

          return (
            <View key={session.id} style={styles.sessionRowContainer}>
              <Pressable
                style={({ pressed }) => [styles.sessionRowContent, pressed ? styles.sessionRowPressed : null]}
                onPress={() => onSelectSession?.(session)}
                accessibilityRole="button"
                accessibilityLabel={title}
              >
                <Text style={styles.sessionTitle} numberOfLines={1}>{title}</Text>
                <Text style={styles.sessionMode} numberOfLines={1}>{mode}</Text>
              </Pressable>
              <Pressable
                testID="style-chat-delete-button"
                style={({ pressed }) => [styles.deleteBtn, pressed ? styles.deleteBtnPressed : null]}
                onPress={() => onDeleteSession?.(session)}
                accessibilityRole="button"
                accessibilityLabel={`Delete ${title}`}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              >
                <Text style={styles.deleteBtnText}>✕</Text>
              </Pressable>
            </View>
          );
        })
      )}

      <Pressable
        testID="style-chat-new-session-button"
        style={({ pressed }) => [
          styles.newBtn,
          loading || newSessionDisabled ? styles.newBtnDisabled : null,
          pressed && !loading && !newSessionDisabled ? styles.newBtnPressed : null,
        ]}
        onPress={onNewSession}
        accessibilityLabel="New StyleChat session"
        accessibilityRole="button"
        disabled={loading || newSessionDisabled}
      >
        <Text style={[styles.newBtnText, loading || newSessionDisabled ? styles.newBtnTextDisabled : null]}>
          {STYLE_CHAT_COPY.newSessionCta}
        </Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    padding: SPACING.xl,
  },
  centred: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xxl,
    minHeight: 160,
  },
  emptyText: {
    ...TYPOGRAPHY.body,
    textAlign: 'center',
    color: COLORS.textSecondary,
    lineHeight: 24,
  },
  errorText: {
    ...TYPOGRAPHY.body,
    textAlign: 'center',
    color: COLORS.chatErrorText,
    fontSize: 13,
    lineHeight: 21,
  },
  sessionRowContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 0,
    marginBottom: SPACING.sm,
  },
  sessionRowContent: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    padding: SPACING.md,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.chatHairline,
    backgroundColor: COLORS.chatSessionCardBg,
  },
  sessionRowPressed: {
    backgroundColor: COLORS.chatPressTint,
  },
  sessionTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.textPrimary,
    flexShrink: 1,
    minWidth: 0,
  },
  sessionMode: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.accent,
    marginTop: 4,
    flexShrink: 1,
    minWidth: 0,
  },
  deleteBtn: {
    marginLeft: SPACING.sm,
    width: 44,
    height: 44,
    flexShrink: 0,
    borderRadius: RADIUS.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(130, 48, 56, 0.28)',
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(130, 48, 56, 0.05)',
  },
  deleteBtnPressed: {
    backgroundColor: 'rgba(130, 48, 56, 0.14)',
  },
  deleteBtnText: {
    fontSize: 13,
    color: COLORS.error,
    fontWeight: '600' as const,
  },
  newBtn: {
    height: 52,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.champagneGold,
    borderTopColor: COLORS.chatGlossTop,
    backgroundColor: COLORS.chatSendBg,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.lg,
  },
  newBtnPressed: {
    backgroundColor: COLORS.chatSendPressed,
  },
  newBtnDisabled: {
    backgroundColor: 'rgba(116, 36, 94, 0.18)',
    borderColor: COLORS.champagneGold,
    borderTopColor: COLORS.champagneGold,
  },
  newBtnText: {
    ...TYPOGRAPHY.cta,
    fontSize: 13,
    letterSpacing: 3,
    color: COLORS.textInverse,
  },
  newBtnTextDisabled: {
    color: COLORS.accent,
  },
});
