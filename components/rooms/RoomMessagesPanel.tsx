import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Linking,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import {
  listRoomMessages,
  normalizeMessageBody,
  ROOM_MESSAGE_MAX_LENGTH,
  ROOM_MESSAGE_SEND_ERROR,
  ROOM_MESSAGES_LOAD_ERROR,
  sendRoomMessage,
  type RoomMessage,
} from '../../services/roomMessages';
import {
  addHiddenContentId,
  addHiddenUserId,
  readHiddenContentIds,
  readHiddenUserIds,
} from '../../services/ugcSafetyStore';
import { submitContentReport } from '../../services/contentReports';

// Shared In-App Room Chat v1.
// Backend-backed (services/roomMessages). Renders for AUTHENTICATED users only —
// the room owner (Dressing Room detail screen) or an authorized participant who
// joined via a share token (shared room screen). Never render for anonymous
// preview viewers; the messages table is never exposed on the public preview.

const MESSAGES_EMPTY_COPY = 'No messages yet. Start the conversation about this room.';
const MESSAGES_FILTERED_EMPTY_COPY =
  'You have reported or hidden all recent activity in this room.';
const COMPOSER_PLACEHOLDER = 'Message about this room…';

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
}: {
  message: RoomMessage;
  onReport: (message: RoomMessage) => void;
}) {
  return (
    <View style={styles.messageCard}>
      <View style={styles.messageMetaRow}>
        <Text style={styles.messageSender}>{message.isMine ? 'You' : 'Participant'}</Text>
        <View style={styles.messageMetaRight}>
          <Text style={styles.messageTime}>{formatMessageTimestamp(message.createdAt)}</Text>
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

export function RoomMessagesPanel({ roomId }: { roomId: string }) {
  const [messages, setMessages] = useState<RoomMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [hiddenIds, setHiddenIds] = useState<Set<string> | null>(null);
  const [hiddenUserIds, setHiddenUserIds] = useState<Set<string> | null>(null);
  const sendInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const [fetchedMessages, hiddenContentIds, hiddenUserIdsResult] = await Promise.all([
        listRoomMessages(roomId),
        readHiddenContentIds().catch(() => [] as string[]),
        readHiddenUserIds().catch(() => [] as string[]),
      ]);
      setMessages(fetchedMessages);
      setHiddenIds(new Set(hiddenContentIds));
      setHiddenUserIds(new Set(hiddenUserIdsResult));
    } catch (err: any) {
      // err.message is always a friendly string from services/roomMessages —
      // never a raw Supabase/Postgres/RLS error, and never a message body.
      setMessages([]);
      setHiddenIds(new Set());
      setHiddenUserIds(new Set());
      setLoadError(typeof err?.message === 'string' ? err.message : ROOM_MESSAGES_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

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
              // 1. Immediate in-memory hide so there is no state flash.
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

              // 2. Persist hide/block in the background; UI does not wait.
              const [contentPersisted, userPersisted] = await Promise.all([
                addHiddenContentId(message.id),
                message.senderId ? addHiddenUserId(message.senderId) : Promise.resolve(true),
              ]);

              if (!contentPersisted || !userPersisted) {
                Alert.alert("We couldn't hide this content right now. Please try again.");
                return;
              }

              // 3. Attempt server-side report insert asynchronously. Failure must not unhide.
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
                  'Thanks. We received your report and hid this content on this device.'
                );
                return;
              }

              // Migration may not be deployed yet; fall back to email/local hide.
              let emailOpened = false;
              try {
                const supported = await Linking.canOpenURL(mailto);
                if (supported) {
                  await Linking.openURL(mailto);
                  emailOpened = true;
                }
              } catch {
                emailOpened = false;
              }

              if (emailOpened) {
                Alert.alert(
                  'Thanks. This content has been hidden on this device. If needed, your report can also be sent to K Scan AI support.'
                );
              } else {
                Alert.alert(
                  'Thanks. This content has been hidden on this device. If needed, your report can also be sent to K Scan AI support.'
                );
              }
            },
          },
        ]
      );
    },
    [roomId]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const normalizedDraft = normalizeMessageBody(draft);
  const draftLength = normalizedDraft.length;
  const draftTooLong = draftLength > ROOM_MESSAGE_MAX_LENGTH;
  const canSend = !sending && draftLength > 0 && !draftTooLong;

  const handleSend = async () => {
    if (!canSend || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setSendError(null);
    try {
      const sent = await sendRoomMessage(roomId, draft);
      setMessages((current) => [...current, sent]);
      setDraft('');
    } catch (err: any) {
      setSendError(typeof err?.message === 'string' ? err.message : ROOM_MESSAGE_SEND_ERROR);
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
          <TouchableOpacity
            style={styles.pillButton}
            onPress={() => { void load(); }}
            testID="room-messages-retry-button"
            accessibilityRole="button"
            accessibilityLabel="Retry loading messages"
          >
            <Text style={styles.pillButtonText}>Retry</Text>
          </TouchableOpacity>
        </View>
      ) : (
        (() => {
          const visibleMessages = messages.filter(
            (message) =>
              !hiddenIds.has(message.id) && !hiddenUserIds.has(message.senderId)
          );
          return visibleMessages.length === 0 ? (
            <View style={styles.statusCard}>
              <Text style={styles.statusText}>
                {messages.length === 0 ? MESSAGES_EMPTY_COPY : MESSAGES_FILTERED_EMPTY_COPY}
              </Text>
            </View>
          ) : (
            <View style={styles.messageList} testID="room-messages-list">
              {visibleMessages.map((message) => (
                <MessageRow key={message.id} message={message} onReport={handleReport} />
              ))}
            </View>
          );
        })()
      )}

      <View style={styles.composerCard}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={COMPOSER_PLACEHOLDER}
          placeholderTextColor={LUXURY.colors.stone}
          multiline
          textAlignVertical="top"
          maxLength={ROOM_MESSAGE_MAX_LENGTH}
          editable={!sending}
          style={styles.composerInput}
          testID="room-messages-input"
          accessibilityLabel="Message composer"
          accessibilityHint="Type a message about this room"
        />
        <View style={styles.composerFooter}>
          <Text style={[styles.charCount, draftTooLong ? styles.charCountError : null]}>
            {draftLength}/{ROOM_MESSAGE_MAX_LENGTH}
          </Text>
          <TouchableOpacity
            style={[styles.pillButton, !canSend ? styles.pillButtonDisabled : null]}
            onPress={() => { void handleSend(); }}
            disabled={!canSend}
            testID="room-messages-send-button"
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityHint="Send your message to the room"
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
