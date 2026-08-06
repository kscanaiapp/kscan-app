import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  AppState,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import {
  DRESSING_ROOM_COLLABORATION_V1,
  DRESSING_ROOM_REALTIME_SYNC_V1,
  DRESSING_ROOM_THREADS_V1,
} from '../../constants/featureFlags';
import {
  listRoomMessagesPage,
  catchUpRoomMessages,
  mergeRoomMessages,
  normalizeMessageBody,
  ROOM_MESSAGE_MAX_LENGTH,
  ROOM_MESSAGE_SEND_ERROR,
  ROOM_MESSAGES_ACCESS_ERROR,
  ROOM_MESSAGES_STALE_ERROR,
  ROOM_MESSAGES_LOAD_ERROR,
  sendRoomMessage,
  type RoomMessage,
} from '../../services/roomMessages';
import {
  bumpCollabActorGeneration,
  getCollabActorGeneration,
  isCurrentCollabGeneration,
  startCollaborationBoundedRefresh,
  type MessageCursor,
} from '../../services/dressingRoomCollaboration';
import { supabase } from '../../services/supabaseClient';
import {
  addHiddenContentId,
  addHiddenUserId,
  readHiddenContentIds,
  readHiddenUserIds,
} from '../../services/ugcSafetyStore';
import { submitContentReport } from '../../services/contentReports';
import {
  blockDressingRoomUser,
  DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
} from '../../services/dressingRoomBlocks';

const MESSAGES_EMPTY_COPY = 'No messages yet. Start the conversation about this room.';
const MESSAGES_FILTERED_EMPTY_COPY =
  'You have reported or hidden all recent activity in this room.';
const COMPOSER_PLACEHOLDER = 'Message about this room…';

function threadsEnabled() {
  return DRESSING_ROOM_THREADS_V1;
}

function syncEnabled() {
  return DRESSING_ROOM_COLLABORATION_V1 && DRESSING_ROOM_REALTIME_SYNC_V1;
}

function formatMessageTimestamp(createdAt: string) {
  const date = new Date(createdAt);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function MessageRow({
  message,
  onReport,
  onReportUser,
  onBlock,
  onReply,
  replyEnabled,
}: {
  message: RoomMessage;
  onReport: (message: RoomMessage) => void;
  onReportUser: (message: RoomMessage) => void;
  onBlock: (message: RoomMessage) => void;
  onReply?: (message: RoomMessage) => void;
  replyEnabled: boolean;
}) {
  const isReply = Boolean(message.parentMessageId);
  return (
    <View
      style={[styles.messageCard, isReply ? styles.replyCard : null]}
      accessibilityLabel={isReply ? 'Reply message' : 'Room message'}
    >
      <View style={styles.messageMetaRow}>
        <Text style={styles.messageSender}>
          {message.isMine ? 'You' : 'Participant'}
          {isReply ? ' · Reply' : ''}
        </Text>
        <View style={styles.messageMetaRight}>
          <Text style={styles.messageTime}>{formatMessageTimestamp(message.createdAt)}</Text>
          {replyEnabled && !isReply && onReply ? (
            <TouchableOpacity
              onPress={() => onReply(message)}
              accessibilityRole="button"
              accessibilityLabel="Reply to message"
              testID={`room-message-reply-${message.id}`}
            >
              <Text style={styles.replyButtonText}>Reply</Text>
            </TouchableOpacity>
          ) : null}
          {!message.isMine ? (
            <TouchableOpacity
              onPress={() => onReportUser(message)}
              accessibilityRole="button"
              accessibilityLabel="Report user"
              testID={`room-message-report-user-${message.id}`}
            >
              <Text style={styles.reportButtonText}>Report user</Text>
            </TouchableOpacity>
          ) : null}
          {!message.isMine ? (
            <TouchableOpacity
              onPress={() => onBlock(message)}
              accessibilityRole="button"
              accessibilityLabel="Block user"
              testID={`room-message-block-${message.id}`}
            >
              <Text style={styles.reportButtonText}>Block</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => onReport(message)}
            accessibilityRole="button"
            accessibilityLabel="Report message"
            testID={`room-message-report-${message.id}`}
          >
            <Text style={styles.reportButtonText}>Report</Text>
          </TouchableOpacity>
        </View>
      </View>
      <Text style={styles.messageBody}>{message.body}</Text>
    </View>
  );
}

export function RoomMessagesPanel({
  roomId,
  isOwner = false,
  roomOwnerId = null,
}: {
  roomId: string;
  /** True when the current viewer owns this Dressing Room. */
  isOwner?: boolean;
  /** The room owner's user id, when known to the caller (used only to pick
   *  confirmation copy for Block user — participant-blocks-owner vs.
   *  participant-blocks-fellow-participant). Optional: when absent, the
   *  participant confirmation defaults to the safer "you may leave this
   *  room" copy. */
  roomOwnerId?: string | null;
}) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string> | null>(null);
  const [hiddenUserIds, setHiddenUserIds] = useState<Set<string> | null>(null);
  const [replyTo, setReplyTo] = useState<RoomMessage | null>(null);
  const [olderCursor, setOlderCursor] = useState<MessageCursor | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [accessRevoked, setAccessRevoked] = useState(false);
  const sendInFlightRef = useRef(false);
  const accessVersionRef = useRef(0);
  const newestCursorRef = useRef<MessageCursor | null>(null);
  const syncStopRef = useRef<null | (() => void)>(null);

  const clearInteractiveState = useCallback(() => {
    setMessages([]);
    setReplyTo(null);
    setOlderCursor(null);
    newestCursorRef.current = null;
    setDraft('');
    setSendError(null);
  }, []);

  const load = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setLoadError(null);
    setAccessRevoked(false);
    try {
      const [fetchedPage, hiddenContentIds, hiddenUserIdsResult] = await Promise.all([
        listRoomMessagesPage({ roomId }),
        readHiddenContentIds().catch(() => [] as string[]),
        readHiddenUserIds().catch(() => [] as string[]),
      ]);
      setMessages(fetchedPage.messages);
      setOlderCursor(fetchedPage.nextCursor);
      newestCursorRef.current = fetchedPage.newestCursor;
      accessVersionRef.current = fetchedPage.accessVersion;
      setHiddenIds(new Set(hiddenContentIds));
      setHiddenUserIds(new Set(hiddenUserIdsResult));
    } catch (err: any) {
      clearInteractiveState();
      setHiddenIds(new Set());
      setHiddenUserIds(new Set());
      const message = typeof err?.message === 'string' ? err.message : ROOM_MESSAGES_LOAD_ERROR;
      setLoadError(message);
      if (message === ROOM_MESSAGES_ACCESS_ERROR) {
        setAccessRevoked(true);
      }
    } finally {
      setLoading(false);
    }
  }, [clearInteractiveState, roomId]);

  const loadOlder = useCallback(async () => {
    if (!olderCursor || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await listRoomMessagesPage({
        roomId,
        cursor: olderCursor,
        direction: 'older',
      });
      setMessages((current) => mergeRoomMessages(page.messages, current));
      setOlderCursor(page.nextCursor);
      accessVersionRef.current = page.accessVersion;
    } catch (err: any) {
      const message = typeof err?.message === 'string' ? err.message : ROOM_MESSAGES_LOAD_ERROR;
      if (message === ROOM_MESSAGES_ACCESS_ERROR) {
        setAccessRevoked(true);
        clearInteractiveState();
        setLoadError(message);
      }
    } finally {
      setLoadingOlder(false);
    }
  }, [clearInteractiveState, loadingOlder, olderCursor, roomId]);

  const handleReport = useCallback(
    (message: RoomMessage) => {
      Alert.alert(
        'Report content',
        'Report & Hide will immediately hide this content on this device and filter content from this sender when their id is known.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report & Hide',
            style: 'destructive',
            onPress: async () => {
              setHiddenIds((current) => {
                const next = new Set<string>(current ?? new Set<string>());
                next.add(message.id);
                return next;
              });
              if (message.senderId) {
                setHiddenUserIds((current) => {
                  const next = new Set<string>(current ?? new Set<string>());
                  next.add(message.senderId);
                  return next;
                });
              }

              const [contentPersisted, userPersisted] = await Promise.all([
                addHiddenContentId(message.id),
                message.senderId ? addHiddenUserId(message.senderId) : Promise.resolve(true),
              ]);

              if (!contentPersisted || !userPersisted) {
                Alert.alert("We couldn't hide this content right now. Please try again.");
                return;
              }

              const reportResult = await submitContentReport({
                targetType: 'message',
                targetId: message.id,
                reportedUserId: message.senderId || null,
                roomId,
                reasonCategory: 'inappropriate',
              });

              const subject = 'Report content in K Scan AI';
              const body = `Please review this shared content.\n\nRoom ID:\n${roomId}\n\nContent ID:\n${message.id}\n\nContent type:\nmessage\n\nReason:\n`;
              const mailto = `mailto:kscanai.app@gmail.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

              if (reportResult.ok && reportResult.serverAccepted) {
                Alert.alert(
                  'Thanks. We received your report and hid this content on this device.',
                );
                return;
              }

              try {
                const supported = await Linking.canOpenURL(mailto);
                if (supported) await Linking.openURL(mailto);
              } catch {
                // local hide already applied
              }

              Alert.alert(
                'Thanks. This content has been hidden on this device. If needed, your report can also be sent to K Scan AI support.',
              );
            },
          },
        ],
      );
    },
    [roomId],
  );

  const handleReportUser = useCallback(
    (message: RoomMessage) => {
      if (!message.senderId || message.isMine) return;
      Alert.alert(
        'Report this user?',
        'We will review this account for violations of our community guidelines. This does not block them — use Block user separately if you also want to stop interacting with them.',
        [
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report user',
            style: 'destructive',
            onPress: async () => {
              const result = await submitContentReport({
                targetType: 'user',
                targetId: message.senderId,
                reportedUserId: message.senderId,
                roomId,
                reasonCategory: 'inappropriate',
              });
              if (result.ok) {
                Alert.alert('Thanks. We received your report.');
              } else {
                Alert.alert("We couldn't send that report. Please try again.");
              }
            },
          },
        ],
      );
    },
    [roomId],
  );

  const handleBlock = useCallback(
    (message: RoomMessage) => {
      if (!message.senderId || message.isMine) return;

      const blockingOwner = message.senderId === roomOwnerId;
      const title = 'Block this user?';
      const body = isOwner
        ? 'They will no longer be able to access shared Dressing Rooms with you or send you Dressing Room messages. Existing messages may be retained for safety and recordkeeping.'
        : blockingOwner
          ? 'You will leave this shared Dressing Room and will no longer receive or send Dressing Room messages with this user. Existing messages may be retained for safety and recordkeeping.'
          : 'You will leave this shared Dressing Room. Existing messages may be retained for safety and recordkeeping.';

      Alert.alert(title, body, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block user',
          style: 'destructive',
          onPress: async () => {
            try {
              await blockDressingRoomUser(message.senderId);
              Alert.alert('User blocked.');
              // The backend has already applied every access consequence in
              // the same transaction; the next load/access check reflects it.
              void load();
            } catch (err: any) {
              const errorMessage =
                typeof err?.message === 'string'
                  ? err.message
                  : DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR;
              Alert.alert(errorMessage);
            }
          },
        },
      ]);
    },
    [isOwner, load, roomOwnerId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      bumpCollabActorGeneration(session?.user?.id ?? null);
      clearInteractiveState();
      if (session?.user?.id) {
        void load();
      } else {
        syncStopRef.current?.();
        syncStopRef.current = null;
      }
    });
    return () => {
      data.subscription.unsubscribe();
    };
  }, [clearInteractiveState, load]);

  useEffect(() => {
    if (!syncEnabled() || !roomId || accessRevoked) return;
    const generation = getCollabActorGeneration();
    const handle = startCollaborationBoundedRefresh({
      roomId,
      actorGeneration: generation,
      knownAccessVersion: accessVersionRef.current,
      onAccessLost: () => {
        setAccessRevoked(true);
        clearInteractiveState();
        setLoadError(ROOM_MESSAGES_ACCESS_ERROR);
      },
      onTick: async (accessVersion) => {
        accessVersionRef.current = accessVersion;
        const page = await catchUpRoomMessages({
          roomId,
          fromCursor: newestCursorRef.current,
        });
        if (!isCurrentCollabGeneration(generation)) return;
        setMessages((current) => mergeRoomMessages(current, page.messages));
        if (page.newestCursor) newestCursorRef.current = page.newestCursor;
        accessVersionRef.current = page.accessVersion;
      },
    });
    syncStopRef.current = handle.stop;
    return () => {
      handle.stop();
      syncStopRef.current = null;
    };
  }, [accessRevoked, clearInteractiveState, roomId]);

  useEffect(() => {
    if (!syncEnabled()) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && !accessRevoked) {
        void load();
      }
    });
    return () => sub.remove();
  }, [accessRevoked, load]);

  const normalizedDraft = normalizeMessageBody(draft);
  const draftLength = normalizedDraft.length;
  const draftTooLong = draftLength > ROOM_MESSAGE_MAX_LENGTH;
  const canSend = !sending && !accessRevoked && draftLength > 0 && !draftTooLong;

  const handleSend = async () => {
    if (!canSend || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setSendError(null);
    const sendGeneration = getCollabActorGeneration();
    const parentMessageId =
      threadsEnabled() && replyTo && !replyTo.parentMessageId ? replyTo.id : null;
    try {
      const sent = await sendRoomMessage(roomId, draft, { parentMessageId });
      if (!isCurrentCollabGeneration(sendGeneration) || accessRevoked) {
        return;
      }
      setMessages((current) => mergeRoomMessages(current, [sent]));
      newestCursorRef.current = {
        createdAt: sent.createdAt,
        id: sent.id,
        direction: 'newer',
      };
      setDraft('');
      setReplyTo(null);
    } catch (err: any) {
      if (!isCurrentCollabGeneration(sendGeneration)) {
        return;
      }
      const message = typeof err?.message === 'string' ? err.message : ROOM_MESSAGE_SEND_ERROR;
      if (message === ROOM_MESSAGES_STALE_ERROR) {
        clearInteractiveState();
        return;
      }
      setSendError(message);
      if (message === ROOM_MESSAGES_ACCESS_ERROR) {
        setAccessRevoked(true);
        clearInteractiveState();
      }
    } finally {
      sendInFlightRef.current = false;
      setSending(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel} accessibilityRole="header">
        Room Chat
      </Text>
      <Text style={styles.sectionSubtitle}>Chat with everyone who has access to this room.</Text>

      {loading || hiddenIds === null || hiddenUserIds === null ? (
        <View style={styles.statusCard}>
          <ActivityIndicator size="small" color={LUXURY.colors.plum} />
          <Text style={styles.statusText}>Loading messages…</Text>
        </View>
      ) : loadError ? (
        <View style={styles.statusCard}>
          <Text style={styles.errorText}>{loadError}</Text>
          {!accessRevoked ? (
            <TouchableOpacity
              style={styles.pillButton}
              onPress={() => {
                void load();
              }}
              testID="room-messages-retry-button"
              accessibilityRole="button"
              accessibilityLabel="Retry loading messages"
            >
              <Text style={styles.pillButtonText}>Retry</Text>
            </TouchableOpacity>
          ) : null}
        </View>
      ) : (
        (() => {
          const visibleMessages = messages.filter(
            (message) => !hiddenIds.has(message.id) && !hiddenUserIds.has(message.senderId),
          );
          return visibleMessages.length === 0 ? (
            <View style={styles.statusCard}>
              <Text style={styles.statusText}>
                {messages.length === 0 ? MESSAGES_EMPTY_COPY : MESSAGES_FILTERED_EMPTY_COPY}
              </Text>
            </View>
          ) : (
            <View style={styles.messageList} testID="room-messages-list">
              {olderCursor ? (
                <TouchableOpacity
                  style={styles.pillButton}
                  onPress={() => {
                    void loadOlder();
                  }}
                  disabled={loadingOlder}
                  accessibilityRole="button"
                  accessibilityLabel="Load older messages"
                  testID="room-messages-load-older"
                >
                  {loadingOlder ? (
                    <ActivityIndicator size="small" color={LUXURY.colors.plum} />
                  ) : (
                    <Text style={styles.pillButtonText}>Older</Text>
                  )}
                </TouchableOpacity>
              ) : null}
              {visibleMessages.map((message) => (
                <MessageRow
                  key={message.id}
                  message={message}
                  onReport={handleReport}
                  onReportUser={handleReportUser}
                  onBlock={handleBlock}
                  replyEnabled={threadsEnabled() && !accessRevoked}
                  onReply={(target) => setReplyTo(target)}
                />
              ))}
            </View>
          );
        })()
      )}

      <View style={styles.composerCard}>
        {replyTo ? (
          <View style={styles.replyBanner}>
            <Text style={styles.replyBannerText} numberOfLines={1}>
              Replying to {replyTo.isMine ? 'yourself' : 'participant'}
            </Text>
            <TouchableOpacity
              onPress={() => setReplyTo(null)}
              accessibilityRole="button"
              accessibilityLabel="Cancel reply"
            >
              <Text style={styles.reportButtonText}>Cancel</Text>
            </TouchableOpacity>
          </View>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={COMPOSER_PLACEHOLDER}
          placeholderTextColor={LUXURY.colors.stone}
          multiline
          textAlignVertical="top"
          maxLength={ROOM_MESSAGE_MAX_LENGTH}
          editable={!sending && !accessRevoked}
          style={styles.composerInput}
          testID="room-messages-input"
          accessibilityLabel="Message composer"
          accessibilityHint="Type a message about this room"
          accessibilityState={{ disabled: accessRevoked }}
        />
        <View style={styles.composerFooter}>
          <Text style={[styles.charCount, draftTooLong ? styles.charCountError : null]}>
            {draftLength}/{ROOM_MESSAGE_MAX_LENGTH}
          </Text>
          <TouchableOpacity
            style={[styles.pillButton, !canSend ? styles.pillButtonDisabled : null]}
            onPress={() => {
              void handleSend();
            }}
            disabled={!canSend}
            testID="room-messages-send-button"
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityHint="Send your message to the room"
            accessibilityState={{ disabled: !canSend, busy: sending }}
          >
            {sending ? (
              <ActivityIndicator size="small" color={LUXURY.colors.plum} />
            ) : (
              <Text style={styles.pillButtonText}>Send</Text>
            )}
          </TouchableOpacity>
        </View>
        {sendError ? <Text style={styles.errorText}>{sendError}</Text> : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  section: {
    marginTop: SPACING.xxl,
    marginBottom: SPACING.md,
  },
  sectionLabel: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
    marginBottom: SPACING.xs,
  },
  sectionSubtitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.md,
  },
  statusCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  statusText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    textAlign: 'center',
  },
  errorText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    textAlign: 'center',
    marginTop: SPACING.xs,
  },
  messageList: {
    gap: SPACING.sm,
  },
  messageCard: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  replyCard: {
    marginLeft: SPACING.lg,
    borderColor: LUXURY.colors.gold,
  },
  messageMetaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.xs,
  },
  messageSender: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
    fontWeight: '600',
  },
  messageTime: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  messageMetaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  reportButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    fontWeight: '600',
  },
  replyButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  messageBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
    lineHeight: 22,
  },
  composerCard: {
    marginTop: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  replyBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: SPACING.sm,
  },
  replyBannerText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    flex: 1,
    marginRight: SPACING.sm,
  },
  composerInput: {
    minHeight: 72,
    color: LUXURY.colors.ink,
    fontSize: 15,
    lineHeight: 22,
    paddingHorizontal: SPACING.xs,
    paddingTop: SPACING.xs,
    paddingBottom: SPACING.xs,
  },
  composerFooter: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: SPACING.sm,
  },
  charCount: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  charCountError: {
    color: LUXURY.colors.error,
  },
  pillButton: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.pearl,
    minWidth: 80,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pillButtonDisabled: {
    opacity: 0.45,
  },
  pillButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    letterSpacing: 1.4,
    fontWeight: '600',
    textTransform: 'uppercase',
  },
});
