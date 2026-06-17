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
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { STYLE_CHAT_COPY } from '../../constants/styleChat';
import {
  StyleChatHeader,
  useStyleChatHomeBackHandler,
} from '../../components/style-chat/StyleChatHeader';
import { StyleChatBubble } from '../../components/style-chat/StyleChatBubble';
import { StyleChatInput } from '../../components/style-chat/StyleChatInput';
import { StyleChatContextPreview } from '../../components/style-chat/StyleChatContextPreview';
import { useStyleChat } from '../../hooks/useStyleChat';
import { getFriendlyStyleChatError } from '../../services/style-chat/styleChatErrors';
import { deleteStyleChatSession } from '../../services/style-chat/styleChatRepository';
import {
  getStyleChatHandoffContext,
  clearStyleChatHandoffContext,
} from '../../services/style-chat/styleChatHandoffContext';
import type { StyleChatMessage } from '../../services/style-chat/types';

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

  const [handoffContext, setHandoffContext] = useState(() => getStyleChatHandoffContext());

  // Consume handoff context on mount and clear it when leaving the session.
  useEffect(() => {
    const ctx = getStyleChatHandoffContext();
    if (ctx) {
      setHandoffContext(ctx);
    }
    return () => {
      clearStyleChatHandoffContext();
    };
  }, []);

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
      <ActivityIndicator size="small" color={LUXURY.colors.plum} />
      <Text style={styles.statusText}>Loading conversation…</Text>
    </View>
  ) : (
    <View testID="style-chat-empty-state" style={styles.centred}>
      <Text style={styles.emptyTitle}>New styling session</Text>
      <Text style={styles.emptyText}>{STYLE_CHAT_COPY.emptyChat}</Text>
    </View>
  );

  const ThinkingIndicator = isSending ? (
    <View testID="style-chat-thinking-indicator" style={styles.thinking}>
      <ActivityIndicator size="small" color={LUXURY.colors.plum} />
      <Text style={styles.thinkingText}>Styling…</Text>
    </View>
  ) : null;

  const isLimitNotice = error === STYLE_CHAT_COPY.systemLimitNotice
    || error === STYLE_CHAT_COPY.burstLimitNotice;
  const friendlyError = getFriendlyStyleChatError(error);
  const ErrorBanner = error ? (
    <View
      testID="style-chat-error-state"
      style={[styles.errorBanner, isLimitNotice ? styles.limitBanner : null]}
      accessibilityRole="alert"
    >
      <Text style={[styles.errorText, isLimitNotice ? styles.limitText : null]}>{friendlyError}</Text>
      {!isLimitNotice ? (
        <Pressable
          onPress={() => { clearError(); retryLastMessage(); }}
          style={styles.retryLink}
          accessibilityRole="button"
          accessibilityLabel="Retry"
          accessibilityHint="Resend the last message"
        >
          <Text style={styles.retryLinkText}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  ) : null;

  const ContextPreviewHeader = handoffContext ? (
    <StyleChatContextPreview
      context={handoffContext}
      onDismiss={() => setHandoffContext(null)}
    />
  ) : null;

  return (
    <SafeAreaView testID="style-chat-screen" style={styles.safe}>
      <StatusBar style="dark" />
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
          accessibilityHint="Permanently remove this session and its messages"
          accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
          hitSlop={{ top: 8, bottom: 8, left: 12, right: 8 }}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color={LUXURY.colors.error} />
          ) : (
            <Text style={styles.sessionDeleteText} testID="style-chat-delete-confirm">Delete</Text>
          )}
        </Pressable>
      </View>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={0}
      >
        <FlatList
          ref={listRef}
          data={messages}
          keyExtractor={item => item.id}
          renderItem={renderMessage}
          ListEmptyComponent={ListEmpty}
          ListHeaderComponent={ContextPreviewHeader}
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
    backgroundColor: LUXURY.colors.ivory,
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
    borderBottomColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.ivory,
  },
  sessionLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 11,
    flex: 1,
    flexShrink: 1,
    minWidth: 0,
    paddingRight: SPACING.sm,
    letterSpacing: 1.4,
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
    ...LUXURY.typography.caption,
    fontSize: 12,
    letterSpacing: 1.4,
    color: LUXURY.colors.error,
    fontWeight: '600',
  },
  listContent: {
    paddingTop: SPACING.xl,
    paddingBottom: SPACING.xl,
  },
  messageList: {
    flex: 1,
    minHeight: 0,
    backgroundColor: LUXURY.colors.ivory,
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
  emptyTitle: {
    ...LUXURY.typography.bodyStrong,
    textAlign: 'center',
    color: LUXURY.colors.ink,
    marginBottom: SPACING.sm,
  },
  emptyText: {
    ...LUXURY.typography.body,
    textAlign: 'center',
    color: LUXURY.colors.graphite,
    lineHeight: 24,
  },
  statusText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    marginTop: SPACING.sm,
  },
  thinking: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.sm,
    gap: SPACING.sm,
  },
  thinkingText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 12,
    fontWeight: '600',
  },
  errorBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: SPACING.xl,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.28)',
    backgroundColor: 'rgba(130, 48, 56, 0.07)',
  },
  limitBanner: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'rgba(198, 161, 91, 0.10)',
  },
  errorText: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.error,
    flex: 1,
  },
  limitText: {
    color: LUXURY.colors.goldText,
  },
  retryLink: {
    marginLeft: SPACING.sm,
    minHeight: 44,
    justifyContent: 'center',
  },
  retryLinkText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
});
