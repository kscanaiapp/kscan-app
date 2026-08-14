import { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import {
  AccessibilityInfo,
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
  Keyboard,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { CONVERSATION_MAX_WIDTH } from '../../services/responsiveLayout';
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
import { useEliseVisualContext } from '../../hooks/useEliseVisualContext';
import { EliseVisualContextBar } from '../../components/style-chat/EliseVisualContextBar';
import { EliseVisualSourceMenu } from '../../components/style-chat/EliseVisualSourceMenu';
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
import { AI_STYLIST_UI_ENABLED, ELISE_LEGACY_PHOTO_INTAKE_ENABLED, ELISE_VISUAL_ATTACHMENTS_V1_ENABLED, STYLECHAT_ATTACHMENTS_ENABLED } from '../../constants/featureFlags';
import { useFeatureFreeze } from '../../hooks/useFeatureFreeze';
import { useEliseSpeechCue } from '../../hooks/useEliseSpeechCue';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { matchOccasionFromText } from '../../types/fashionReasoning';
import { StyleChatAttachmentBar } from '../../components/style-chat/StyleChatAttachmentBar';
import { StyleChatActiveItemBar } from '../../components/style-chat/StyleChatActiveItemBar';
import { StyleChatFollowUpBar } from '../../components/style-chat/StyleChatFollowUpBar';
import { StyleChatPhotoIntake } from '../../components/style-chat/StyleChatPhotoIntake';
import { useStyleChatAttachments } from '../../hooks/useStyleChatAttachments';
import {
  ELISE_IMAGE_LOOP_COPY,
  describeClosetState,
  followUpImpressionKey,
  loopTelemetryPayload,
  resolveActiveItemContext,
  resolveActiveItemFashionContext,
  resolveFollowUpActions,
  resolveStyleTarget,
} from '../../services/style-chat/eliseImageStylingLoop';
import { emitClosetCandidateEvent } from '../../services/closetTelemetry';
import {
  DRESSING_ROOM_ANCHOR_MESSAGES,
  PRIVATE_DRESSING_ROOM_ROUTE,
  dressingRoomAnchorParams,
  isAnchorRefused,
  preflightDressingRoomAnchor,
} from '../../services/privateDressingRoomChatHandoff';
import { createActorRequest } from '../../services/actorContext';
import {
  getDraftComposerText,
  setDraftComposerText,
  clearDraftAttachments,
} from '../../services/style-chat/styleChatAttachmentStore';
import { stopAvatarSpeechPlayback } from '../../services/avatarSpeech';
import { getStyleChatComposerControls } from '../../services/style-chat/styleChatComposerControls';

export default function StyleChatSessionScreen() {
  const isDeleteDialogOpenRef = useRef(false);
  const visualSourceMenuOpenRef = useRef(false);
  useStyleChatHomeBackHandler(isDeleteDialogOpenRef);

  const { sessionId } = useLocalSearchParams<{ sessionId: string }>();
  const stableSessionId = sessionId ?? '';
  const { user } = useAuthSession();
  const { identity } = useStylistIdentity();
  const speakEliseCue = useEliseSpeechCue();
  const stylistDisplayName = identity.displayName;
  // Style Memory Phase 0 local feedback key. StyleChat is auth-only, so this is
  // populated whenever messages exist; null hides the local feedback UI.
  const userKey = user ? `user:${user.id}` : null;
  const actorKey = userKey;
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
  const [composerText, setComposerTextState] = useState(() => getDraftComposerText(stableSessionId, actorKey));
  const [visualSourceMenuVisible, setVisualSourceMenuVisible] = useState(false);

  useEffect(() => {
    setComposerTextState(getDraftComposerText(stableSessionId, actorKey));
  }, [stableSessionId, actorKey]);

  const setComposerText = useCallback(
    (next: string) => {
      setComposerTextState(next);
      setDraftComposerText(stableSessionId, next, actorKey);
      if (next.trim().length > 0 && user?.id) {
        void stopAvatarSpeechPlayback({
          actorId: user.id,
          sessionId: stableSessionId,
          avatarId: identity.avatarId,
        });
      }
    },
    [stableSessionId, actorKey, user?.id, identity.avatarId],
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
    collection,
    entries: visualContextEntries,
    isProcessing: visualContextProcessing,
    hasReadyEntry,
    hasBlockedEntry,
    remainingSlots,
    fashionContextV2: visualFashionContext,
    getRemainingCapacity,
    startScan,
    startUpload,
    remove: removeVisualContextEntry,
    retry: retryVisualContextEntry,
    setFocusedEntry,
    clear: clearVisualContext,
    uploadUnavailableReason,
  } = useEliseVisualContext(stableSessionId, actorKey);

  const activeContextForGeneration = useMemo(() => {
    const readyEntries = visualContextEntries
      .filter((entry) => entry.status === 'ready')
      .sort((left, right) => left.order - right.order);
    if (readyEntries.length > 0) {
      const focusedReadyEntry = readyEntries.find(
        (entry) => entry.id === collection?.focusedEntryId,
      ) ?? null;
      const sourceEntry = focusedReadyEntry ?? readyEntries[0];
      const source: 'camera' | 'upload' = sourceEntry.source === 'scan' ? 'camera' : 'upload';
      return {
        source,
        visualCollection: {
          evidence: readyEntries.map((entry) => ({
            id: entry.id,
            order: entry.order,
            source: entry.source,
            title: entry.title,
            summary: entry.summary ?? null,
            category: entry.category ?? null,
            colors: entry.colors ?? null,
            materials: entry.materials ?? null,
            silhouette: entry.silhouette ?? null,
            styleAttributes: entry.styleAttributes ?? null,
            brand: entry.brand ?? null,
            confidence: entry.confidence ?? null,
          })),
          ...(focusedReadyEntry ? { focusEvidenceId: focusedReadyEntry.id } : {}),
        },
      };
    }
    return handoffContext ?? null;
  }, [visualContextEntries, collection?.focusedEntryId, handoffContext]);

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
    activeContext: activeContextForGeneration,
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
              clearVisualContext();
              clearDraftAttachments(sessionId, { actorKey });
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

  const ContextPreviewHeader = handoffContext && !hasReadyEntry ? (
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
  // Phase 2 Closet attachments + Elise visual attachment composer.
  // ELISE_VISUAL_ATTACHMENTS_V1_ENABLED enables the unified composer control
  // (camera/gallery/item pickers → V2). STYLECHAT_ATTACHMENTS_ENABLED remains
  // the subordinate Closet-attachment capability under aiStylist.
  const attachmentsEnabled =
    (ELISE_VISUAL_ATTACHMENTS_V1_ENABLED ||
      (AI_STYLIST_UI_ENABLED && STYLECHAT_ATTACHMENTS_ENABLED)) &&
    (ELISE_VISUAL_ATTACHMENTS_V1_ENABLED || isStylistFeatureEnabled('aiStylist'));
  const visualAttachmentsEnabled = ELISE_VISUAL_ATTACHMENTS_V1_ENABLED;
  // The LEGACY photo intake (pre-visual-attachment modal, legacy scan-identify
  // contract) requires an EXPLICIT opt-in on top of the composed flags. The
  // previous `attachmentsEnabled && !visualAttachmentsEnabled` gate failed
  // open: omitting the visual-attachments variable from a profile that enables
  // attachments would silently revive this route. Absence of a variable must
  // never activate a dormant identification path.
  const legacyPhotoIntakeEnabled =
    attachmentsEnabled && !visualAttachmentsEnabled && ELISE_LEGACY_PHOTO_INTAKE_ENABLED;
  const chatAttachments = useStyleChatAttachments(sessionId ?? '');
  const [photoIntakeVisible, setPhotoIntakeVisible] = useState(false);
  const [attachMenuOpen, setAttachMenuOpen] = useState(false);

  // Flag OFF: clear attachment state and discard pending async results.
  useEffect(() => {
    if (attachmentsEnabled) return;
    chatAttachments.clearAttachments({ keepText: true });
    setAttachMenuOpen(false);
    setPhotoIntakeVisible(false);
  }, [attachmentsEnabled, chatAttachments.clearAttachments]);

  /**
   * The item Elise is currently discussing.
   *
   * Derived from the live composer drafts rather than held in its own state, so
   * there is no second store to keep in sync and nothing to invalidate: the
   * attachment store is already reset on sign-out and on an actor change
   * (AuthSessionContext → resetAttachmentStore), which means this context clears
   * with it and can never survive into another account's conversation.
   */
  const activeItem = useMemo(
    () => resolveActiveItemContext(chatAttachments.attachments),
    [chatAttachments.attachments],
  );

  /**
   * Deterministic speech for the two states this screen OWNS.
   *
   * Driven by the resolved context rather than by the tap handlers, and that is
   * the point in both cases:
   *
   * `image_understood` — resolveActiveItemContext only returns a context once the
   * attachment has left the pending states, so a context existing IS the proof
   * that identification finished and produced something nameable. Speaking off
   * the picker callback instead would have Elise claim she can see the piece
   * while identification was still running.
   *
   * `closet_saved` — `owned` is true only when persistence reported saved AND
   * handed back a committed item id. saveDirectImageToCloset answers {ok:true}
   * for an already-saved item and for a save already in flight too, so the tap
   * result is not evidence that anything was newly committed; the ownership flag
   * is.
   *
   * The cue is keyed on draftId, so each item speaks once and a rerender,
   * refocus or foreground return replays nothing — while a genuinely different
   * item still gets its own cue.
   */
  useEffect(() => {
    if (!activeItem) return;
    speakEliseCue('image_understood', activeItem.draftId, stableSessionId);
  }, [activeItem?.draftId, speakEliseCue, stableSessionId]);

  useEffect(() => {
    if (!activeItem?.owned) return;
    speakEliseCue('closet_saved', activeItem.draftId, stableSessionId);
  }, [activeItem?.draftId, activeItem?.owned, speakEliseCue, stableSessionId]);

  /**
   * Impressions and the accessible state announcement.
   *
   * Keyed on the offered SET, not on renders: a chat screen rerenders on every
   * keystroke, and a per-render event would say more about typing speed than
   * about the feature. The refs hold comparison keys only — never an id that is
   * emitted.
   */
  const followUpImpressionRef = useRef<string | null>(null);
  const closetAnnouncementRef = useRef<string | null>(null);
  useEffect(() => {
    if (!attachmentsEnabled) return;
    const key = followUpImpressionKey(activeItem);
    if (!activeItem || !key) {
      followUpImpressionRef.current = null;
      closetAnnouncementRef.current = null;
      return;
    }

    if (followUpImpressionRef.current !== key) {
      followUpImpressionRef.current = key;
      const payload = loopTelemetryPayload(activeItem);
      emitClosetCandidateEvent('elise_image_followup_shown', payload);
      if (resolveFollowUpActions(activeItem).some((action) => action.type === 'save_to_closet')) {
        emitClosetCandidateEvent('elise_image_save_prompt_shown', payload);
      }
    }

    /**
     * Announce the Closet transition, and say what it unlocked.
     *
     * Success must be legible without animation, and Style This Item must be
     * DISCOVERABLE when it appears — a screen reader user should not have to
     * hunt the row again to find out that saving changed what is on offer.
     * Skipped on the first observation so re-entering the screen does not
     * announce a state the user already knows.
     */
    const closetLine = describeClosetState(activeItem);
    const previous = closetAnnouncementRef.current;
    closetAnnouncementRef.current = closetLine;
    if (previous !== null && previous !== closetLine) {
      AccessibilityInfo.announceForAccessibility(
        activeItem.owned
          ? `${closetLine}. ${ELISE_IMAGE_LOOP_COPY.styleThisItemLabel} is now available.`
          : closetLine,
      );
    }
    if (activeItem.owned && previous !== null && previous !== closetLine) {
      emitClosetCandidateEvent('elise_image_saved', loopTelemetryPayload(activeItem));
    }
  }, [activeItem, attachmentsEnabled]);

  /**
   * THE ONE SEND PIPELINE.
   *
   * The composer and every follow-up chip call this, so a chip is genuinely "a
   * faster way of asking Elise a normal question" rather than a second code path
   * that can drift from the one the send rules were written against. It is
   * extracted verbatim from the composer's previous inline handler; the only
   * additions are `clearComposer` (a chip must not wipe text the user typed) and
   * the persistent-context branch below.
   */
  const submitMessage = useCallback(
    async (text: string, options?: { clearComposer?: boolean }) => {
      const clearComposer = options?.clearComposer !== false;
      weather.markStylingIntent();
      if (attachmentsEnabled && chatAttachments.hasActiveAttachments) {
        // Send rule: attachment-bearing sends require every attachment
        // ready; pending/failed chips block the send (remove to send
        // text only). The snapshot is immutable for this operation.
        if (!chatAttachments.canSendWithAttachments) return;
        const snapshot = chatAttachments.snapshotForSend();
        // Focus must be included when present — never send without it.
        if (
          chatAttachments.focusedDraftId &&
          !snapshot.drafts.some(
            (draft) => draft.draftId === chatAttachments.focusedDraftId,
          )
        ) {
          Alert.alert(
            'Attachment',
            'Elise could not access the selected image or item. Remove it or try again.',
          );
          return;
        }
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
        await sendMessage(text, {
          attachments: {
            references: snapshot.references,
            drafts: snapshot.drafts,
            ...(snapshot.fashionContext
              ? { fashionContext: snapshot.fashionContext }
              : {}),
            onSending: () => chatAttachments.markSending(snapshot.drafts),
            onSent: () => {
              chatAttachments.markSent(snapshot.drafts);
              if (hasReadyEntry) clearVisualContext();
              if (clearComposer) setComposerText('');
            },
            onSendFailed: () => chatAttachments.markSendFailed(snapshot.drafts),
          },
        });
        return;
      }

      if (hasReadyEntry) {
        // Phase 2B.3: header-gallery references carry canonical identity
        // when the flag is on. It rides the same additive field as every
        // other Elise source, so there is one identity contract on the wire.
        //
        // This branch takes precedence over the persistent active-item context
        // below: a LIVE visual entry is what the user is looking at right now,
        // and grounding the reply in a previously sent photo instead would
        // answer about the wrong garment.
        const sentWithVisual = await sendMessage(
          text,
          visualFashionContext
            ? {
              attachments: {
                references: [],
                drafts: [],
                fashionContext: visualFashionContext,
              },
            }
            : undefined,
        );
        if (!sentWithVisual) return;
        // Only clear the visual context and draft after a successful send.
        clearVisualContext();
        if (clearComposer) setComposerText('');
        return;
      }

      /**
       * The item is already sent, and the conversation is still about it.
       *
       * Carrying its canonical identity forward is what makes a follow-up
       * context-aware WITHOUT a second upload, a second identification, a second
       * Closet candidate or a second charge: this object was derived and
       * validated when the photo was attached, and it is the styling-safe
       * projection — no image, no evidence id, no candidate id. Re-sending it is
       * re-sending JSON the client already holds, through the same additive
       * `fashionContextV2` field a Scanner handoff uses.
       *
       * It is honest because it is visible: the context bar above the composer
       * names the item, and clearing that bar stops this from being attached.
       */
      const carriedContext =
        attachmentsEnabled && activeItem
          ? resolveActiveItemFashionContext(chatAttachments.attachments, activeItem.draftId)
          : null;

      const sent = await sendMessage(
        text,
        carriedContext
          ? {
            attachments: {
              references: [],
              drafts: [],
              fashionContext: carriedContext,
            },
          }
          : undefined,
      );
      if (!sent) return;
      if (clearComposer) setComposerText('');
    },
    [
      activeItem,
      attachmentsEnabled,
      chatAttachments,
      clearVisualContext,
      hasReadyEntry,
      sendMessage,
      setComposerText,
      visualFashionContext,
      weather,
    ],
  );

  /**
   * A follow-up chip submits its predefined prompt as a normal message.
   *
   * The user's typed text is deliberately left alone: tapping "What shoes work?"
   * must not silently discard a half-written question.
   */
  const handleFollowUpPrompt = useCallback(
    (prompt: string) => {
      if (isSending) return;
      // `actionType: 'prompt'` — the TYPE, never the question. The sink's
      // allowlist would drop a stray free-text field, but the projection means
      // there is nothing to drop.
      if (activeItem) {
        emitClosetCandidateEvent('elise_image_followup_selected', {
          ...loopTelemetryPayload(activeItem),
          actionType: 'prompt',
        });
      }
      void submitMessage(prompt, { clearComposer: false });
    },
    [activeItem, isSending, submitMessage],
  );

  /** Post-answer Closet progression. Optional, never a precondition for anything. */
  const handleSaveActiveItemToCloset = useCallback(() => {
    if (!activeItem) return;
    emitClosetCandidateEvent('elise_image_save_selected', {
      ...loopTelemetryPayload(activeItem),
      actionType: 'save_to_closet',
    });
    void chatAttachments.saveDirectImageToCloset(activeItem.draftId).then((result) => {
      if (!result.ok) Alert.alert('Closet', result.message);
    });
  }, [activeItem, chatAttachments]);

  /**
   * THE NAVIGATION LATCH.
   *
   * A ref, not state, and claimed SYNCHRONOUSLY before the first await — the
   * same discipline the photo-intake picker guard needed. State would not be
   * committed before a second tap arrived, and a timer would only make the race
   * narrower rather than closing it. It is released on refusal and deliberately
   * NOT released on success: the destination now owns the interaction, and the
   * focus effect below clears it when the user comes back.
   */
  const styleHandoffRef = useRef(false);
  useFocusEffect(
    useCallback(() => {
      styleHandoffRef.current = false;
    }, []),
  );

  /**
   * Style This Item — the conversion point of this loop.
   *
   * Build 3 owns styling. This confirms the handoff is entitled to happen and
   * that the destination will actually honour the anchor, then hands the saved
   * Closet item to the EXISTING route contract, which creates or reuses the
   * session, composes through the approved path, persists the active Look and
   * renders it. No parallel outfit editor, no duplicated item, no new schema.
   */
  const openDressingRoomForActiveItem = useCallback(() => {
    if (styleHandoffRef.current) return;
    if (!activeItem) return;
    styleHandoffRef.current = true;
    const draftId = activeItem.draftId;
    const telemetry = loopTelemetryPayload(activeItem);
    // One selection event per accepted tap, emitted after the latch is claimed
    // so a rapid double tap produces one event as well as one navigation.
    emitClosetCandidateEvent('elise_image_style_item_selected', {
      ...telemetry,
      actionType: activeItem.styled ? 'open_dressing_room' : 'style_this_item',
    });

    // THE OWNERSHIP BOUNDARY, re-proved against the LIVE drafts rather than
    // against whatever the chip captured when it rendered. An unsaved candidate
    // stops here and never reaches the Closet read.
    const target = resolveStyleTarget(chatAttachments.attachments, draftId);
    if (!target) {
      styleHandoffRef.current = false;
      Alert.alert('Dressing Room', ELISE_IMAGE_LOOP_COPY.ownershipBlockedMessage);
      return;
    }

    const actorRequest = createActorRequest();
    void preflightDressingRoomAnchor({
      closetItemId: target.closetItemId,
      actorId: user?.id ?? null,
      actorRequest,
    })
      .then((decision) => {
        if (isAnchorRefused(decision)) {
          styleHandoffRef.current = false;
          Alert.alert('Dressing Room', DRESSING_ROOM_ANCHOR_MESSAGES[decision.reason]);
          return;
        }
        // Marked before the push so the follow-up row has already progressed to
        // "Open Dressing Room" by the time the user navigates back.
        chatAttachments.markStyledInDressingRoom(draftId);
        emitClosetCandidateEvent('elise_image_dressing_room_opened', telemetry);
        // Only an ACCEPTED handoff speaks. The ownership refusal and the anchor
        // refusal both return above, and the latch means a rapid double tap
        // produces one cue as well as one navigation. Keyed on the committed
        // Closet item so styling a different piece speaks again.
        speakEliseCue('style_item', decision.closetItemId, stableSessionId);
        router.push({
          pathname: PRIVATE_DRESSING_ROOM_ROUTE,
          params: dressingRoomAnchorParams(decision.closetItemId),
        });
      })
      .catch(() => {
        styleHandoffRef.current = false;
        Alert.alert('Dressing Room', ELISE_IMAGE_LOOP_COPY.handoffFailedMessage);
      });
  }, [activeItem, chatAttachments, user?.id, speakEliseCue, stableSessionId]);

  /** Stop styling this item. The photo is removed from the composer entirely. */
  const handleClearActiveItem = useCallback(() => {
    if (!activeItem) return;
    emitClosetCandidateEvent('elise_image_context_cleared', loopTelemetryPayload(activeItem));
    chatAttachments.removeAttachment(activeItem.draftId);
  }, [activeItem, chatAttachments]);

  /**
   * Replace the active item through the EXISTING attachment intake.
   *
   * The old attachment is dropped first so the composer never holds two direct
   * images while the picker is open — `removeAttachment` also releases the old
   * Closet candidate unless it was saved, which is the behaviour that keeps an
   * abandoned photo from lingering as a reservation.
   *
   * PLATFORM DIFFERENCE, DELIBERATE. This line reaches the intake through the
   * visual attachment composer, which is the iOS entry point; the legacy photo
   * intake modal is behind an explicit opt-in and must not be revived by a
   * control that merely wants to pick another photo.
   *
   * With NEITHER route enabled this control cannot complete — and it is also
   * unreachable: a direct image can only be created by one of those two intakes,
   * so with both off there is no active item and the bar does not render.
   */
  const handleChangeActiveItem = useCallback(() => {
    if (activeItem) {
      emitClosetCandidateEvent('elise_image_context_replaced', loopTelemetryPayload(activeItem));
      chatAttachments.removeAttachment(activeItem.draftId);
    }
    if (visualAttachmentsEnabled) setAttachMenuOpen(true);
    else if (legacyPhotoIntakeEnabled) setPhotoIntakeVisible(true);
  }, [activeItem, chatAttachments, visualAttachmentsEnabled, legacyPhotoIntakeEnabled]);

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

  const composerControls = getStyleChatComposerControls({
    hasValidDraft: composerText.trim().length > 0,
    isSessionUnavailable: !stableSessionId || (!loadingSession && !session),
    isDeletingSession: isDeleting,
    isSubmitting: isSending,
    hasQueuedEvidence: visualContextEntries.some((entry) => entry.status === 'preparing'),
    hasPreparingEvidence: visualContextEntries.some((entry) => entry.status === 'analyzing'),
    hasBlockedEvidence: visualContextEntries.some((entry) => entry.status === 'blocked'),
    hasFailedEvidence: visualContextEntries.some((entry) => entry.status === 'failed'),
    hasAdditionalSendBlock:
      !canSend ||
      (attachmentsEnabled &&
        chatAttachments.hasActiveAttachments &&
        !chatAttachments.canSendWithAttachments),
  });

  const closeVisualSourceMenu = useCallback(() => {
    visualSourceMenuOpenRef.current = false;
    setVisualSourceMenuVisible(false);
  }, []);

  const openVisualSourceMenu = useCallback(() => {
    if (
      visualSourceMenuOpenRef.current ||
      !composerControls.inputEditable ||
      getRemainingCapacity() === 0
    ) {
      return;
    }
    visualSourceMenuOpenRef.current = true;
    Keyboard.dismiss();
    setVisualSourceMenuVisible(true);
  }, [composerControls.inputEditable, getRemainingCapacity]);

  const visualCollectionFull = remainingSlots === 0;
  const scanActionDisabled = visualCollectionFull || !composerControls.inputEditable;

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
          styles.conversationColumn,
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
      <EliseVisualContextBar
        entries={visualContextEntries}
        focusedEntryId={collection?.focusedEntryId ?? null}
        hasBlockedEntry={hasBlockedEntry}
        onRemove={removeVisualContextEntry}
        onRetry={retryVisualContextEntry}
        onFocus={setFocusedEntry}
        onClear={clearVisualContext}
        uploadUnavailableReason={uploadUnavailableReason}
      />
      {ErrorBanner}
      {attachmentsEnabled ? (
        <StyleChatActiveItemBar
          context={activeItem}
          onClear={handleClearActiveItem}
          onChange={handleChangeActiveItem}
          disabled={isSending}
        />
      ) : null}
      {attachmentsEnabled ? (
        <StyleChatFollowUpBar
          context={activeItem}
          handlers={{
            onPrompt: handleFollowUpPrompt,
            onSaveToCloset: handleSaveActiveItemToCloset,
            // All three reach the same anchored workspace: Build 3's slot editor
            // is where "change something" already lives, so there is no second
            // destination and no second editor.
            onStyleThisItem: openDressingRoomForActiveItem,
            onOpenDressingRoom: openDressingRoomForActiveItem,
            onChangeSomething: openDressingRoomForActiveItem,
          }}
          disabled={isSending}
        />
      ) : null}
      {attachmentsEnabled ? (
        <StyleChatAttachmentBar
          attachments={chatAttachments.attachments}
          focusedDraftId={chatAttachments.focusedDraftId}
          onAddOwnedItem={(item, scan) => chatAttachments.addOwnedItem(item, scan)}
          onAddLook={(look) => chatAttachments.addLook(look)}
          onDirectImage={(uri, source) => chatAttachments.addDirectImage(uri, source)}
          onAddDressingRoomItem={(input) => chatAttachments.addDressingRoomItem(input)}
          onAddSharedItem={(input) => chatAttachments.addSharedItem(input)}
          onUploadPhoto={legacyPhotoIntakeEnabled ? () => setPhotoIntakeVisible(true) : undefined}
          onRemove={chatAttachments.removeAttachment}
          onRetry={(draftId, items, localScans) =>
            chatAttachments.retryAttachment(draftId, items, localScans)
          }
          onSaveToCloset={(draftId) => {
            void chatAttachments.saveDirectImageToCloset(draftId).then((result) => {
              if (!result.ok) Alert.alert('Closet', result.message);
            });
          }}
          onFocus={chatAttachments.setFocusedAttachment}
          atAttachmentLimit={chatAttachments.atAttachmentLimit}
          atDirectImageLimit={chatAttachments.atDirectImageLimit}
          showAttachButton={!visualAttachmentsEnabled}
          menuOpen={visualAttachmentsEnabled ? attachMenuOpen : undefined}
          onMenuOpenChange={visualAttachmentsEnabled ? setAttachMenuOpen : undefined}
          disabled={isSending}
        />
      ) : null}
      <View style={[styles.composerWrap, styles.conversationColumn]}>
        <StyleChatInput
          stylistDisplayName={stylistDisplayName}
          value={composerText}
          onChangeText={setComposerText}
          showAttachButton={visualAttachmentsEnabled && attachmentsEnabled}
          onAttachPress={
            visualAttachmentsEnabled && attachmentsEnabled
              ? () => setAttachMenuOpen(true)
              : undefined
          }
          onSend={(text) => { void submitMessage(text, { clearComposer: true }); }}
          inputEditable={composerControls.inputEditable}
          sendDisabled={composerControls.sendDisabled}
          sendBusy={isSending}
        />
      </View>
      {legacyPhotoIntakeEnabled ? (
        <StyleChatPhotoIntake
          visible={photoIntakeVisible}
          onClose={() => setPhotoIntakeVisible(false)}
          onAttached={(resolved, summary) => {
            const result = chatAttachments.addResolvedOwnedItem(resolved, summary, {
              isDirectImage: true,
            });
            if (!result.ok) {
              Alert.alert('Attachment', result.message);
            }
          }}
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
        onScanPress={openVisualSourceMenu}
        scanDisabled={scanActionDisabled}
        scanDisabledHint={
          visualCollectionFull
            ? 'Remove an image before adding another.'
            : 'This session is unavailable.'
        }
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
      <EliseVisualSourceMenu
        visible={visualSourceMenuVisible}
        onClose={closeVisualSourceMenu}
        onScan={() => startScan(composerText)}
        onUpload={startUpload}
        cameraDisabled={visualCollectionFull}
        uploadDisabled={visualCollectionFull}
      />
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
  // Readable conversation column: inert on phones, caps and centers messages
  // and composer on regular-width iPad windows.
  conversationColumn: {
    width: '100%',
    maxWidth: CONVERSATION_MAX_WIDTH,
    alignSelf: 'center',
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
