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
}

export function StyleChatSessionList({
  sessions,
  loading,
  error,
  onNewSession,
  onSelectSession,
  onDeleteSession,
}: StyleChatSessionListProps) {
  const insets = useSafeAreaInsets();
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
      ) : sessions.length === 0 ? (
        <View testID="style-chat-empty-state" style={styles.centred}>
          <Text style={styles.emptyText}>{STYLE_CHAT_COPY.emptySessionList}</Text>
        </View>
      ) : (
        sessions.map(session => (
          <View key={session.id} style={styles.sessionRowContainer}>
            <Pressable
              style={({ pressed }) => [styles.sessionRowContent, pressed ? styles.sessionRowPressed : null]}
              onPress={() => onSelectSession?.(session)}
              accessibilityRole="button"
              accessibilityLabel={session.title}
            >
              <Text style={styles.sessionTitle} numberOfLines={1}>{session.title}</Text>
              <Text style={styles.sessionMode} numberOfLines={1}>{session.mode.replace(/_/g, ' ').toUpperCase()}</Text>
            </Pressable>
            <Pressable
              testID="style-chat-delete-button"
              style={({ pressed }) => [styles.deleteBtn, pressed ? styles.deleteBtnPressed : null]}
              onPress={() => onDeleteSession?.(session)}
              accessibilityRole="button"
              accessibilityLabel={`Delete ${session.title}`}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={styles.deleteBtnText}>✕</Text>
            </Pressable>
          </View>
        ))
      )}

      <Pressable
        testID="style-chat-new-session-button"
        style={({ pressed }) => [styles.newBtn, pressed ? styles.newBtnPressed : null]}
        onPress={onNewSession}
        accessibilityLabel="New StyleChat session"
        accessibilityRole="button"
        disabled={loading}
      >
        <Text style={styles.newBtnText}>{STYLE_CHAT_COPY.newSessionCta}</Text>
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
    color: COLORS.errorSoft,
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
    padding: SPACING.lg,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
  },
  sessionRowPressed: {
    backgroundColor: COLORS.surfaceStrong,
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
    borderWidth: 1,
    borderColor: COLORS.error,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(182, 84, 84, 0.08)',
  },
  deleteBtnPressed: {
    backgroundColor: 'rgba(182, 84, 84, 0.22)',
  },
  deleteBtnText: {
    fontSize: 13,
    color: COLORS.errorSoft,
    fontWeight: '600' as const,
  },
  newBtn: {
    height: 52,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: 'rgba(45, 31, 94, 0.35)',
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.lg,
  },
  newBtnPressed: {
    backgroundColor: 'rgba(45, 31, 94, 0.6)',
  },
  newBtnText: {
    ...TYPOGRAPHY.cta,
    fontSize: 13,
    letterSpacing: 3,
    color: COLORS.chrome,
  },
});
