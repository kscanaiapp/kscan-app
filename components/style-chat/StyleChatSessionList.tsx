import { View, Text, Pressable, StyleSheet } from 'react-native';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import type { StyleChatSession } from '../../services/style-chat/types';

interface StyleChatSessionListProps {
  sessions: StyleChatSession[];
  onNewSession: () => void;
  onSelectSession?: (session: StyleChatSession) => void;
}

export function StyleChatSessionList({
  sessions,
  onNewSession,
  onSelectSession,
}: StyleChatSessionListProps) {
  return (
    <View testID="style-chat-session-list" style={styles.container}>
      {sessions.length === 0 ? (
        <View testID="style-chat-empty-state" style={styles.emptyState}>
          <Text style={styles.emptyText}>{STYLE_CHAT_COPY.emptySessionList}</Text>
        </View>
      ) : (
        sessions.map(session => (
          <Pressable
            key={session.id}
            style={({ pressed }) => [styles.sessionRow, pressed ? styles.sessionRowPressed : null]}
            onPress={() => onSelectSession?.(session)}
          >
            <Text style={styles.sessionTitle}>{session.title}</Text>
            <Text style={styles.sessionMode}>{session.mode.replace(/_/g, ' ').toUpperCase()}</Text>
          </Pressable>
        ))
      )}

      <Pressable
        testID="style-chat-new-session-button"
        style={({ pressed }) => [styles.newBtn, pressed ? styles.newBtnPressed : null]}
        onPress={onNewSession}
        accessibilityLabel="New StyleChat session"
        accessibilityRole="button"
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
  emptyState: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xxl,
  },
  emptyText: {
    ...TYPOGRAPHY.body,
    textAlign: 'center',
    color: COLORS.textSecondary,
    lineHeight: 24,
  },
  sessionRow: {
    padding: SPACING.lg,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surface,
    marginBottom: SPACING.sm,
  },
  sessionRowPressed: {
    backgroundColor: COLORS.surfaceStrong,
  },
  sessionTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.textPrimary,
  },
  sessionMode: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.accent,
    marginTop: 4,
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
