import { useRef, useEffect, useState } from 'react';
import {
  Alert,
  SafeAreaView,
  View,
  Text,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Pressable,
  StyleSheet,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import {
  StyleChatHeader,
  useStyleChatHomeBackHandler,
} from '../../components/style-chat/StyleChatHeader';
import { StyleChatBubble } from '../../components/style-chat/StyleChatBubble';
import { StyleChatInput } from '../../components/style-chat/StyleChatInput';
import { useStyleChat } from '../../hooks/useStyleChat';
import { deleteStyleChatSession } from '../../services/style-chat/styleChatRepository';
import type { StyleChatMessage } from '../../services/style-chat/types';

function getFriendlyStyleChatError(message?: string | null) {
  if (!message) return null;
  if (message === STYLE_CHAT_COPY.systemLimitNotice) return message;
  if (message === STYLE_CHAT_COPY.burstLimitNotice) {
    return "You've sent several messages quickly. Please wait a moment before sending another.";
  }

  const lower = message.toLowerCase();
  if (lower.includes('timeout') || lower.includes('timed out') || lower.includes('abort')) {
    return 'This is taking longer than usual. Please wait or try again.';
  }
  if (lower.includes('rate') || lower.includes('limit') || lower.includes('too many')) {
    return "You've sent several messages quickly. Please wait a moment before sending another.";
  }
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('connect')) {
    return "We couldn't connect. Please check your internet and try again.";
  }
  if (lower.includes('provider') || lower.includes('model') || lower.includes('generate')) {
    return "We couldn't generate a response right now. Please try again later.";
  }
  return "We couldn't update this chat right now. Please try again.";
}

export default function StyleChatSessionScreen() {
  const isDeleteDialogOpenRef = useRef(false);
  useStyleChatHomeBackHandler(isDeleteDialogOpenRef);

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

  const [isDeleting, setIsDeleting] = useState(false);
  const listRef = useRef<FlatList<StyleChatMessage>>(null);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const horizontalSafePadding = {
    paddingLeft: Math.max(SPACING.xl, insets.left),
    paddingRight: Math.max(SPACING.xl, insets.right),
  };

  // Scroll to bottom when messages arrive or update
  useEffect(() => {
    if (messages.length > 0) {
      setTimeout(() => listRef.current?.scrollToEnd({ animated: true }), 50);
    }
  }, [messages.length]);

  const handleDeleteSession = () => {
    const clearDialog = () => { isDeleteDialogOpenRef.current = false; };
    isDeleteDialogOpenRef.current = true;
    Alert.alert(
      'Delete this StyleChat conversation?',
      'This will remove the conversation and its messages. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel', onPress: clearDialog },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            clearDialog();
            if (!sessionId) return;
            setIsDeleting(true);
            try {
              await deleteStyleChatSession(sessionId);
              router.replace('/style-chat');
            } catch (err: unknown) {
              console.error('Delete StyleChat session failed', err);
              setIsDeleting(false);
              Alert.alert(
                'Could not delete conversation',
                "We couldn't update this chat right now. Please try again.",
              );
            }
          },
        },
      ],
      { cancelable: true, onDismiss: clearDialog },
    );
  };

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

  const isLimitNotice = error === STYLE_CHAT_COPY.systemLimitNotice
    || error === STYLE_CHAT_COPY.burstLimitNotice;
  const friendlyError = getFriendlyStyleChatError(error);
  const ErrorBanner = error ? (
    <View testID="style-chat-error-state" style={styles.errorBanner}>
      <Text style={styles.errorText}>{friendlyError}</Text>
      {!isLimitNotice ? (
        <Pressable
          onPress={() => { clearError(); retryLastMessage(); }}
          style={styles.retryLink}
          accessibilityRole="button"
          accessibilityLabel="Retry"
        >
          <Text style={styles.retryLinkText}>RETRY</Text>
        </Pressable>
      ) : null}
    </View>
  ) : null;

  return (
    <SafeAreaView testID="style-chat-screen" style={styles.safe}>
      <StatusBar style="light" />
      <StyleChatHeader showBadge={false} />
      <View style={[styles.sessionMeta, horizontalSafePadding]}>
        <Text style={styles.sessionLabel} numberOfLines={1}>
          {session?.title ?? 'SESSION'} · {sessionId?.slice(-8).toUpperCase()}
        </Text>
        <Pressable
          testID="style-chat-delete-button"
          style={({ pressed }) => [
            styles.sessionDeleteBtn,
            pressed && !isDeleting ? styles.sessionDeleteBtnPressed : null,
          ]}
          onPress={handleDeleteSession}
          disabled={isDeleting}
          accessibilityRole="button"
          accessibilityLabel="Delete this conversation"
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 8 }}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color={COLORS.error} />
          ) : (
            <Text style={styles.sessionDeleteText} testID="style-chat-delete-confirm">DELETE</Text>
          )}
        </Pressable>
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
          style={[styles.messageList, isLandscape ? styles.messageListLandscape : null]}
          contentContainerStyle={[
            messages.length === 0 ? styles.listContentEmpty : styles.listContent,
            isLandscape ? styles.listContentLandscape : null,
          ]}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
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
    minHeight: 0,
  },
  sessionMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.xs,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  sessionLabel: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.textSecondary,
    fontSize: 11,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingRight: SPACING.sm,
  },
  sessionDeleteBtn: {
    minHeight: 44,
    minWidth: 64,
    flexShrink: 0,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  sessionDeleteBtnPressed: {
    opacity: 0.6,
  },
  sessionDeleteText: {
    ...TYPOGRAPHY.chipLabel,
    fontSize: 11,
    letterSpacing: 2,
    color: COLORS.error,
  },
  listContent: {
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xl,
  },
  messageList: {
    flex: 1,
    minHeight: 0,
  },
  messageListLandscape: {
    minHeight: 80,
  },
  listContentLandscape: {
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.lg,
  },
  listContentEmpty: {
    flexGrow: 1,
    justifyContent: 'center',
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xl,
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
