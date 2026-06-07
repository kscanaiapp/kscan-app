import { View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import type { StyleChatSession } from '../../services/style-chat/types';

interface StyleChatSessionListProps {
  sessions: StyleChatSession[];
  loading: boolean;
  error: string | null;
  onNewSession: () => void;
  onSelectSession?: (session: StyleChatSession) => void;
}

export function StyleChatSessionList({
  sessions,
  loading,
  error,
  onNewSession,
  onSelectSession,
}: StyleChatSessionListProps) {
  return (
    <View testID="style-chat-session-list" style={styles.container}>
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
          <Pressable
            key={session.id}
            style={({ pressed }) => [styles.sessionRow, pressed ? styles.sessionRowPressed : null]}
            onPress={() => onSelectSession?.(session)}
            accessibilityRole="button"
            accessibilityLabel={session.title}
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
    flex: 1,
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
