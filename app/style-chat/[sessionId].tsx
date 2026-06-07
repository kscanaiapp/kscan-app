import { useRef, useEffect } from 'react';
import {
  SafeAreaView,
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import { StyleChatHeader } from '../../components/style-chat/StyleChatHeader';
import { StyleChatBubble } from '../../components/style-chat/StyleChatBubble';
import { StyleChatInput } from '../../components/style-chat/StyleChatInput';
import { useStyleChat } from '../../hooks/useStyleChat';
import type { StyleChatMessage } from '../../services/style-chat/types';

export default function StyleChatSessionScreen() {
  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const {
    session,
    messages,
    loadingSession,
    loadingMessages,
    isSending,
    error,
    canSend,
    sendMessage,
    retryLastMessage,
    clearError,
  } = useStyleChat(sessionId ?? '');

  const listRef = useRef<FlatList<StyleChatMessage>>(null);

  // Scroll to bottom when messages arrive or update
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages.length]);

  const isLoading = loadingSession || loadingMessages;

  const renderMessage = ({ item }: { item: StyleChatMessage }) => (
    <StyleChatBubble message={item} />
  );

  const ListEmpty = isLoading ? (
    <View style={styles.centred}>
      <ActivityIndicator size="small" color={COLORS.accent} />
    </View>
  ) : (
    <View testID="style-chat-empty-state" style={styles.centred}>
      <Text style={styles.emptyText}>{STYLE_CHAT_COPY.emptyChat}</Text>
    </View>
  );

  const ThinkingIndicator = isSending ? (
    <View testID="style-chat-thinking-indicator" style={styles.thinking}>
      <ActivityIndicator size="small" color={COLORS.accent} />
      <Text style={styles.thinkingText}>Styling…</Text>
    </View>
  ) : null;

  const ErrorBanner = error ? (
    <View testID="style-chat-error-state" style={styles.errorBanner}>
      <Text style={styles.errorText}>{error}</Text>
      <Pressable
        onPress={() => { clearError(); retryLastMessage(); }}
        style={styles.retryLink}
        accessibilityRole="button"
        accessibilityLabel="Retry"
      >
        <Text style={styles.retryLinkText}>RETRY</Text>
      </Pressable>
    </View>
  ) : null;

  return (
    <SafeAreaView testID="style-chat-screen" style={styles.safe}>
      <StatusBar style="light" />
      <StyleChatHeader showBadge={false} />
      <View style={styles.sessionMeta}>
        <Text style={styles.sessionLabel} numberOfLines={1}>
          {session?.title ?? 'SESSION'} · {sessionId?.slice(-8).toUpperCase()}
        </Text>
      </View>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={item => item.id}
          renderItem={renderMessage}
          ListEmptyComponent={ListEmpty}
          ListFooterComponent={ThinkingIndicator}
          contentContainerStyle={
            messages.length === 0 ? styles.listContentEmpty : styles.listContent
          }
          showsVerticalScrollIndicator={false}
        />
        {ErrorBanner}
        <StyleChatInput onSend={text => { void sendMessage(text); }} disabled={!canSend} />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  flex: {
    flex: 1,
  },
  sessionMeta: {
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sessionLabel: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.textTertiary,
    fontSize: 9,
  },
  listContent: {
    paddingVertical: SPACING.lg,
  },
  listContentEmpty: {
    flex: 1,
    justifyContent: 'center',
  },
  centred: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xxl,
    minHeight: 120,
  },
  emptyText: {
    ...TYPOGRAPHY.body,
    textAlign: 'center',
    color: COLORS.textSecondary,
    lineHeight: 24,
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  thinkingText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.accent,
    fontSize: 11,
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: SPACING.xl,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.error,
    backgroundColor: 'rgba(182, 84, 84, 0.12)',
  },
  errorText: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.errorSoft,
    flex: 1,
  },
  retryLink: {
    marginLeft: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryLinkText: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.accent,
  },
});
