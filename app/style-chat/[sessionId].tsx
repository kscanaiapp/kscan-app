import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  Alert,
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
import { ELISE_IDENTITY, ELISE_LOADING_COPY, STYLE_MEMORY_COPY } from '../../constants/elise';
import {
  StyleChatHeader,
  useStyleChatHomeBackHandler,
} from '../../components/style-chat/StyleChatHeader';
import { StyleChatBubble } from '../../components/style-chat/StyleChatBubble';
import { StyleChatInput } from '../../components/style-chat/StyleChatInput';
import { StyleChatContextPreview } from '../../components/style-chat/StyleChatContextPreview';
import { StyleChatStyleDnaCard } from '../../components/style-chat/StyleChatStyleDnaCard';
import { useStyleChat } from '../../hooks/useStyleChat';
import { getFriendlyStyleChatError } from '../../services/style-chat/styleChatErrors';
import { deleteStyleChatSession } from '../../services/style-chat/styleChatRepository';
import {
  getStyleChatHandoffContext,
  clearStyleChatHandoffContext,
} from '../../services/style-chat/styleChatHandoffContext';
import type { StyleChatMessage } from '../../services/style-chat/types';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { useStyleDnaPreferences } from '../../hooks/useStyleDnaPreferences';
import { useWeatherStyling } from '../../hooks/useWeatherStyling';
import { StyleChatWeatherPrompt, StyleChatWeatherChip } from '../../components/style-chat/StyleChatWeatherPrompt';
import { WEATHER_COPY } from '../../constants/weatherStyling';
import {
  buildStyleDnaSummaryText,
  getStyleDnaProfileSummary,
  resetLocalStyleDnaProfile,
  type LocalStyleDnaProfileSummary,
} from '../../services/style-dna/localStyleDnaProfile';
import { STYLE_DNA_ENABLED } from '../../services/style-dna/localStyleDnaFeedbackStore';
import { buildStyleDnaContext } from '../../services/style-dna/styleDnaContext';
import { AI_STYLIST_UI_ENABLED, STYLECHAT_ATTACHMENTS_ENABLED } from '../../constants/featureFlags';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { matchOccasionFromText } from '../../types/fashionReasoning';
import { StyleChatAttachmentBar } from '../../components/style-chat/StyleChatAttachmentBar';
import { StyleChatPhotoIntake } from '../../components/style-chat/StyleChatPhotoIntake';
import { useStyleChatAttachments } from '../../hooks/useStyleChatAttachments';
import {
  getDraftComposerText,
  setDraftComposerText,
} from '../../services/style-chat/styleChatAttachmentStore';
import { stopAvatarSpeechPlayback } from '../../services/avatarSpeech';
import {
  contextFromReusedV2,
  routeEliseAttachment,
} from '../../services/style-chat/eliseAttachmentRouting';

export default function StyleChatSessionScreen() {
  const isDeleteDialogOpenRef = useRef(false);
  useStyleChatHomeBackHandler(isDeleteDialogOpenRef);

  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const stableSessionId = sessionId ?? '';
  const { user } = useAuthSession();
  const { identity } = useStylistIdentity();
  const stylistDisplayName = identity.displayName;
  // Style Memory Phase 0 local feedback key. StyleChat is auth-only, so this is
  // populated whenever messages exist; null hides the local feedback UI.
  const userKey = user ? `user:${user.id}` : null;
  const { preferences: styleDnaPreferences, updatePreferences: updateStyleDnaPreferences } =
    useStyleDnaPreferences({ userKey });
  const weather = useWeatherStyling(sessionId ?? '');
  // Phase 2: build a data-only Style Memory context per send. Reads the local profile
  // fresh each time and self-gates on EXPO_PUBLIC_STYLE_DNA_CONTEXT_ENABLED + the
  // >=3-signal threshold (returns null otherwise). Reading fresh means a reset — which
  // clears local feedback — immediately produces a neutral request with no memoized ctx.
  const getStyleDnaContext = useCallback(async () => {
    if (!userKey) return null;
    try {
      const summary = await getStyleDnaProfileSummary({ userKey });
      return buildStyleDnaContext(summary);
    } catch {
      return null;
    }
  }, [userKey]);

  const [handoffContext, setHandoffContext] = useState(() => getStyleChatHandoffContext());

  /**
   * Canonical identity carried by a Scanner handoff, reused rather than re-run.
   *
   * Routed on the attachment SOURCE (`scanner_handoff`), not on "there is an
   * image": the handoff always has an image, and routing on image presence is
   * exactly how a garment Scanner already identified would be identified a second
   * time — a second charge, a second chance to disagree with itself.
   *
   * null when Scanner ran the legacy contract, which leaves the descriptive
   * `activeContext` fields as the only grounding, exactly as today.
   */
  const handoffFashionContext = useMemo(() => {
    if (!handoffContext?.identificationV2) return null;
    const route = routeEliseAttachment({
      source: 'scanner_handoff',
      identificationV2: handoffContext.identificationV2,
    });
    if (route.kind !== 'reuse_v2') return null;
    return contextFromReusedV2('scanner_handoff', route.identification);
  }, [handoffContext]);
  const [composerText, setComposerTextState] = useState(() => getDraftComposerText(stableSessionId));

  useEffect(() => {
    setComposerTextState(getDraftComposerText(stableSessionId));
  }, [stableSessionId]);

  const setComposerText = useCallback(
    (next: string) => {
      setComposerTextState(next);
      setDraftComposerText(stableSessionId, next);
      if (next.trim().length > 0 && user?.id) {
        void stopAvatarSpeechPlayback({
          actorId: user.id,
          sessionId: stableSessionId,
          avatarId: identity.avatarId,
        });
      }
    },
    [stableSessionId, user?.id, identity.avatarId],
  );

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
  } = useStyleChat(sessionId ?? '', {
    getWeatherLocation: weather.getWeatherLocation,
    getStyleDnaContext,
    activeContext: handoffContext ?? null,
  });

  const [isDeleting, setIsDeleting] = useState(false);
  const [styleDnaSummary, setStyleDnaSummary] = useState<LocalStyleDnaProfileSummary | null>(null);
  const [isLoadingStyleDna, setIsLoadingStyleDna] = useState(false);
  const [isResettingStyleDna, setIsResettingStyleDna] = useState(false);
  const [styleDnaRefreshTick, setStyleDnaRefreshTick] = useState(0);
  const listRef = useRef<FlatList<StyleChatMessage>>(null);
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const isLandscape = width > height;
  const horizontalSafePadding = {
    paddingLeft: Math.max(SPACING.xl, insets.left),
    paddingRight: Math.max(SPACING.xl, insets.right),
  };

  useEffect(() => {
    let cancelled = false;

    if (!STYLE_DNA_ENABLED || !userKey) {
      setStyleDnaSummary(null);
      setIsLoadingStyleDna(false);
      return () => {
        cancelled = true;
      };
    }

    setIsLoadingStyleDna(true);
    void (async () => {
      try {
        const nextSummary = await getStyleDnaProfileSummary({ userKey });
        if (!cancelled) setStyleDnaSummary(nextSummary);
      } catch {
        if (!cancelled) setStyleDnaSummary(null);
      } finally {
        if (!cancelled) setIsLoadingStyleDna(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userKey, styleDnaRefreshTick]);

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
      'Delete this conversation?',
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

  const refreshStyleDnaSummary = () => {
    setStyleDnaRefreshTick((value) => value + 1);
  };

  const handleResetStyleDna = () => {
    if (!userKey || !styleDnaSummary || styleDnaSummary.totalSignals === 0 || isResettingStyleDna) {
      return;
    }
    Alert.alert(
      STYLE_MEMORY_COPY.resetAlertTitle,
      STYLE_MEMORY_COPY.resetAlertMessage,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Reset',
          style: 'destructive',
          onPress: async () => {
            setIsResettingStyleDna(true);
            try {
              await resetLocalStyleDnaProfile(userKey);
              refreshStyleDnaSummary();
            } catch {
              Alert.alert(
                STYLE_MEMORY_COPY.resetErrorAlertTitle,
                STYLE_MEMORY_COPY.resetErrorAlertMessage,
              );
            } finally {
              setIsResettingStyleDna(false);
            }
          },
        },
      ],
    );
  };

  const isLoading = loadingSession || loadingMessages;

  const handleDismissFeedbackEducation = useCallback(() => {
    void updateStyleDnaPreferences({ feedbackEducationDismissed: true }).catch(() => {
      // Keep education visible when local persistence fails; avoid a false dismissal.
    });
  }, [updateStyleDnaPreferences]);

  const renderMessage = ({ item, index }: { item: StyleChatMessage; index: number }) => (
    <StyleChatBubble
      message={item}
      userKey={userKey}
      learnFromFeedback={styleDnaPreferences.learnFromFeedback}
      showFeedbackControls={styleDnaPreferences.showFeedbackControls}
      feedbackEducationDismissed={styleDnaPreferences.feedbackEducationDismissed}
      onDismissFeedbackEducation={handleDismissFeedbackEducation}
      onFeedbackMenuOpened={() => {
        listRef.current?.scrollToIndex({ index, animated: true, viewPosition: 0 });
      }}
      onStyleDnaFeedbackSaved={refreshStyleDnaSummary}
    />
  );

  const ListEmpty = isLoading ? (
    <View style={styles.centred}>
      <ActivityIndicator size="small" color={LUXURY.colors.plum} />
      <Text style={styles.statusText}>Loading conversation…</Text>
    </View>
  ) : (
    <View testID="style-chat-empty-state" style={styles.centred}>
      <Text style={styles.emptyTitle}>Meet {stylistDisplayName}</Text>
      <Text style={styles.emptyText}>
        Your personal AI stylist, built around the clothes you already own.
      </Text>
    </View>
  );

  const ThinkingIndicator = isSending ? (
    <View testID="style-chat-thinking-indicator" style={styles.thinking}>
      <View style={styles.thinkingSpinner}>
        <ActivityIndicator size="small" color={LUXURY.colors.plum} />
      </View>
      <View style={styles.thinkingCopy}>
        <Text style={styles.thinkingText}>{ELISE_LOADING_COPY.thinking}</Text>
        <Text style={styles.thinkingSubtext}>{ELISE_LOADING_COPY.thinkingSubtext}</Text>
      </View>
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

  const styleDnaSummaryText = styleDnaSummary ? buildStyleDnaSummaryText(styleDnaSummary) : null;

  // StyleChat → visual stylist bridge. Passes ONLY the latest user message as
  // a contextHint (never chat history); a conservative local matcher may
  // preselect an occasion, and the raw hint lands in the optional note field.
  // No outfit generation happens inside the chat response.
  const { isFeatureEnabled: isStylistFeatureEnabled } = useFeatureFreeze();
  // Phase 2 Closet attachments: subordinate capability under aiStylist.
  // Disabled → controls hidden, v2 never sent, v1 StyleChat unchanged.
  const attachmentsEnabled =
    AI_STYLIST_UI_ENABLED &&
    STYLECHAT_ATTACHMENTS_ENABLED &&
    isStylistFeatureEnabled('aiStylist');
  const chatAttachments = useStyleChatAttachments(sessionId ?? '');
  const [photoIntakeVisible, setPhotoIntakeVisible] = useState(false);
  const latestUserMessage = [...messages].reverse().find((message) => message.sender === 'user');
  const showStyleMeForThis = Boolean(
    AI_STYLIST_UI_ENABLED &&
    isStylistFeatureEnabled('aiStylist') &&
    latestUserMessage?.content?.trim(),
  );
  const handleStyleMeForThis = () => {
    const contextHint = String(latestUserMessage?.content ?? '').trim().slice(0, 280);
    const matchedOccasion = matchOccasionFromText(contextHint);
    const query = [
      matchedOccasion ? `occasion=${encodeURIComponent(matchedOccasion)}` : null,
      contextHint ? `note=${encodeURIComponent(contextHint)}` : null,
    ]
      .filter(Boolean)
      .join('&');
    router.push(query ? `/stylist?${query}` : '/stylist');
  };
  const StyleMeForThisChip = showStyleMeForThis ? (
    <View style={styles.styleMeWrap}>
      <Pressable
        onPress={handleStyleMeForThis}
        accessibilityRole="button"
        accessibilityLabel="Ask Elise to style this"
        style={styles.styleMeChip}
        testID="style-me-for-this"
      >
        <Text style={styles.styleMeChipText}>STYLE THIS WITH ELISE</Text>
      </Pressable>
    </View>
  ) : null;

  const ChatBody = (
    <>
      <FlatList
        ref={listRef}
        data={messages}
        extraData={[userKey, styleDnaPreferences.learnFromFeedback, styleDnaPreferences.showFeedbackControls, styleDnaPreferences.feedbackEducationDismissed]}
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
        keyboardDismissMode="interactive"
        onContentSizeChange={() => {
          if (messages.length > 0) {
            listRef.current?.scrollToEnd({ animated: true });
          }
        }}
      />
      {weather.enabled ? (
        weather.promptVisible ? (
          <StyleChatWeatherPrompt
            onUseWeather={() => { void weather.acceptWeather(); }}
            onNotNow={() => { void weather.dismissPrompt(); }}
            requesting={weather.requesting}
          />
        ) : weather.chipState === 'active' ? (
          <StyleChatWeatherChip label={WEATHER_COPY.active} />
        ) : weather.chipState === 'denied' ? (
          <Text style={styles.weatherDenied}>{WEATHER_COPY.denied}</Text>
        ) : null
      ) : null}
      {StyleMeForThisChip}
      {ErrorBanner}
      {attachmentsEnabled ? (
        <StyleChatAttachmentBar
          attachments={chatAttachments.attachments}
          onAddOwnedItem={(item) => chatAttachments.addOwnedItem(item)}
          onAddLook={(look) => chatAttachments.addLook(look)}
          onUploadPhoto={() => setPhotoIntakeVisible(true)}
          onRemove={chatAttachments.removeAttachment}
          onRetry={(draftId, items, localScans) => chatAttachments.retryAttachment(draftId, items, localScans)}
          onSaveToCloset={(draftId) => {
            void chatAttachments.saveDirectImageToCloset(draftId).then((result) => {
              if (!result.ok) Alert.alert('Closet', result.message);
            });
          }}
          disabled={isSending}
        />
      ) : null}
      <View style={styles.composerWrap}>
        <StyleChatInput
          stylistDisplayName={stylistDisplayName}
          value={composerText}
          onChangeText={setComposerText}
          onSend={text => {
            weather.markStylingIntent();
            if (attachmentsEnabled && chatAttachments.hasActiveAttachments) {
              // Send rule: attachment-bearing sends require every attachment
              // ready; pending/failed chips block the send (remove to send
              // text only). The snapshot is immutable for this operation.
              if (!chatAttachments.canSendWithAttachments) return;
              const snapshot = chatAttachments.snapshotForSend();
              // Phase 2B.3: an image-backed message must not claim visual
              // grounding it does not have. When identities exist but none is
              // usable, the send is refused rather than quietly downgraded to a
              // text-only send whose reply the transcript would show beside a photo.
              if (snapshot.fashionContextBlockedReason) {
                Alert.alert(
                  'Attachment',
                  'Elise could not read that photo well enough to advise on it. Retry it, or remove it to send just your message.',
                );
                return;
              }
              void sendMessage(text, {
                attachments: {
                  references: snapshot.references,
                  drafts: snapshot.drafts,
                  ...(snapshot.fashionContext
                    ? { fashionContext: snapshot.fashionContext }
                    : {}),
                  onSending: () => chatAttachments.markSending(snapshot.drafts),
                  onSent: () => {
                    chatAttachments.markSent(snapshot.drafts);
                    setComposerText('');
                  },
                  onSendFailed: () => chatAttachments.markSendFailed(snapshot.drafts),
                },
              });
              return;
            }
            // Phase 2B.3: a Scanner handoff carrying a canonical identity sends it
            // through the same additive field as every other Elise source, so
            // there is one identity contract on the wire.
            void sendMessage(text, {
              onUserMessagePersisted: () => setComposerText(''),
              ...(handoffFashionContext
                ? {
                  attachments: {
                    references: [],
                    drafts: [],
                    fashionContext: handoffFashionContext,
                  },
                }
                : {}),
            });
          }}
          disabled={
            !canSend ||
            (attachmentsEnabled &&
              chatAttachments.hasActiveAttachments &&
              !chatAttachments.canSendWithAttachments)
          }
        />
      </View>
      {attachmentsEnabled ? (
        <StyleChatPhotoIntake
          visible={photoIntakeVisible}
          onClose={() => setPhotoIntakeVisible(false)}
          onAttached={(input) => {
            const result = chatAttachments.addUnsavedDirectImage(input);
            if (!result.ok) {
              Alert.alert('Attachment', result.message);
            }
          }}
          onClosetOutcome={chatAttachments.applyClosetOutcome}
        />
      ) : null}
    </>
  );

  return (
    <View testID="style-chat-screen" style={styles.safe}>
      <StatusBar style="dark" />
      <StyleChatHeader
        showBadge={false}
        isThinking={isSending}
        sessionId={stableSessionId}
      />
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
      {STYLE_DNA_ENABLED && userKey ? (
        <StyleChatStyleDnaCard
          summary={styleDnaSummary}
          summaryText={styleDnaSummaryText}
          loading={isLoadingStyleDna}
          resetting={isResettingStyleDna}
          learnFromFeedback={styleDnaPreferences.learnFromFeedback}
          onReset={handleResetStyleDna}
        />
      ) : null}
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'padding'}
        keyboardVerticalOffset={Platform.OS === 'ios' ? insets.top : 0}
      >
        {ChatBody}
      </KeyboardAvoidingView>
    </View>
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
  composerWrap: {
    flexShrink: 0,
  },
  styleMeWrap: {
    alignItems: 'center',
    paddingVertical: SPACING.xs,
  },
  styleMeChip: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xs,
    backgroundColor: LUXURY.colors.pearl,
  },
  styleMeChipText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldText,
    letterSpacing: 1.6,
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
    alignItems: 'flex-start',
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
    gap: SPACING.sm,
  },
  thinkingSpinner: {
    width: 24,
    height: 24,
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  thinkingCopy: {
    flex: 1,
    minWidth: 0,
  },
  thinkingText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    fontSize: 13,
    lineHeight: 19,
  },
  thinkingSubtext: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.4,
    marginTop: SPACING.xxs,
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
  weatherDenied: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    marginHorizontal: SPACING.xl,
    marginBottom: SPACING.xs,
    letterSpacing: 0.6,
  },
});
