import { ScrollView, View, Text, Pressable, ActivityIndicator, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { EmptyStateCard } from '../luxury';
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
    <ScrollView
      testID="style-chat-session-list"
      style={styles.container}
      contentContainerStyle={[styles.content, safeContainerPadding]}
      showsVerticalScrollIndicator={false}
      keyboardShouldPersistTaps="handled"
    >
      {loading ? (
        <View style={styles.centred}>
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.statusText}>Loading sessions…</Text>
        </View>
      ) : error ? (
        <View style={styles.centred}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : safeSessions.length === 0 ? (
        <EmptyStateCard
          testID="style-chat-empty-state"
          title="Ask Your AI Stylist"
          subtitle="Start a session for outfit ideas, product comparisons, or styling advice."
          action={{
            label: STYLE_CHAT_COPY.newSessionCta,
            onPress: onNewSession,
            accessibilityLabel: 'New StyleChat session',
            testID: 'style-chat-new-session-button',
          }}
        />
      ) : (
        <View style={styles.list}>
          <Text style={styles.sectionLabel} accessibilityRole="header">
            Recent Sessions
          </Text>
          {safeSessions.map(session => {
            const title = typeof session.title === 'string' && session.title.trim()
              ? session.title
              : 'New Styling Session';
            const mode = typeof session.mode === 'string'
              ? session.mode.replace(/_/g, ' ').toUpperCase()
              : 'GENERAL';
            const updatedAt = typeof session.updatedAt === 'string'
              ? new Date(session.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              : '';

            return (
              <View key={session.id} style={styles.sessionRowContainer}>
                <View style={styles.sessionCard}>
                  <Pressable
                    style={({ pressed }) => [styles.sessionRowContent, pressed ? styles.sessionRowPressed : null]}
                    onPress={() => onSelectSession?.(session)}
                    accessibilityRole="button"
                    accessibilityLabel={`${title}, ${mode}${updatedAt ? `, last active ${updatedAt}` : ''}`}
                    accessibilityHint="Open this StyleChat session"
                  >
                    <Text style={styles.sessionTitle} numberOfLines={1}>{title}</Text>
                    <View style={styles.sessionMetaRow}>
                      <Text style={styles.sessionMode} numberOfLines={1}>{mode}</Text>
                      {updatedAt ? <Text style={styles.sessionDate}>{updatedAt}</Text> : null}
                    </View>
                  </Pressable>
                  <Pressable
                    testID="style-chat-delete-button"
                    style={({ pressed }) => [styles.deleteBtn, pressed ? styles.deleteBtnPressed : null]}
                    onPress={() => onDeleteSession?.(session)}
                    accessibilityRole="button"
                    accessibilityLabel={`Delete ${title}`}
                    accessibilityHint="Permanently remove this conversation"
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Text style={styles.deleteBtnText}>✕</Text>
                  </Pressable>
                </View>
              </View>
            );
          })}
        </View>
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
        accessibilityHint="Start a new styling conversation"
        accessibilityRole="button"
        accessibilityState={{ disabled: loading || newSessionDisabled, busy: loading }}
        disabled={loading || newSessionDisabled}
      >
        <Text style={[styles.newBtnText, loading || newSessionDisabled ? styles.newBtnTextDisabled : null]}>
          {STYLE_CHAT_COPY.newSessionCta}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
    padding: SPACING.xl,
  },
  centred: {
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.xxl,
    minHeight: 160,
  },

  errorText: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.error,
    fontSize: 14,
    lineHeight: 22,
  },
  statusText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginTop: SPACING.sm,
  },
  list: {
    flex: 1,
  },
  sectionLabel: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.md,
  },
  sessionRowContainer: {
    minWidth: 0,
    marginBottom: SPACING.md,
  },
  sessionCard: {
    flexDirection: 'row',
    alignItems: 'stretch',
    minWidth: 0,
    minHeight: 64,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...LUXURY.cards.product.shadow,
  },
  sessionRowContent: {
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    padding: SPACING.md,
  },
  sessionRowPressed: {
    backgroundColor: LUXURY.colors.cream,
  },
  sessionTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    flexShrink: 1,
    minWidth: 0,
  },
  sessionMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.xs,
  },
  sessionMode: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    flexShrink: 1,
    minWidth: 0,
  },
  sessionDate: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginLeft: SPACING.sm,
  },
  deleteBtn: {
    width: 48,
    flexShrink: 0,
    justifyContent: 'center',
    alignItems: 'center',
    borderLeftWidth: 1,
    borderLeftColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.warmWhite,
  },
  deleteBtnPressed: {
    backgroundColor: LUXURY.colors.cream,
  },
  deleteBtnText: {
    fontSize: 14,
    color: LUXURY.colors.error,
    fontWeight: '600',
  },
  newBtn: {
    height: 56,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: SPACING.lg,
    ...LUXURY.buttons.primary.shadow,
  },
  newBtnPressed: {
    backgroundColor: LUXURY.colors.plumCore,
  },
  newBtnDisabled: {
    backgroundColor: LUXURY.colors.plumMuted,
  },
  newBtnText: {
    ...LUXURY.typography.cta,
    color: LUXURY.colors.inverse,
  },
  newBtnTextDisabled: {
    color: LUXURY.colors.stone,
  },
});
