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
import { COLORS, RADIUS, SHADOWS, SPACING, TYPOGRAPHY } from '../../constants/theme';
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

// Private In-App Room Messaging v1.
// Rendered only inside the authenticated Dressing Room detail screen.
// Must never be rendered on public preview routes (app/(public)/rooms/*).

const ACCESSIBLE_GOLD_TEXT = '#72521E';
const MESSAGES_EMPTY_COPY = 'Discuss this room with people you invite.';
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
        <Text style={styles.messageSender}>{message.isMine ? 'You' : 'Collaborator'}</Text>
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
              try {
                const supported = await Linking.canOpenURL(mailto);
                if (supported) {
                  await Linking.openURL(mailto);
                }
              } catch {
                // Ignore mailto errors; content is already hidden.
              }

              Alert.alert(
                'Thanks. This content has been hidden on this device. If needed, your report can also be sent to K Scan AI support.'
              );
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
      <Text style={styles.sectionLabel}>ROOM MESSAGES</Text>

      {loading || hiddenIds === null || hiddenUserIds === null ? (
        <View style={styles.statusCard}>
          <ActivityIndicator size="small" color={COLORS.gold} />
          <Text style={styles.statusText}>Loading messages…</Text>
        </View>
      ) : loadError ? (
        <View style={styles.statusCard}>
          <Text style={styles.errorText}>{loadError}</Text>
          <TouchableOpacity
            style={styles.pillButton}
            onPress={() => { void load(); }}
            testID="room-messages-retry-button"
          >
            <Text style={styles.pillButtonText}>RETRY</Text>
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
          placeholderTextColor={COLORS.editorialTextSecondary}
          multiline
          textAlignVertical="top"
          maxLength={ROOM_MESSAGE_MAX_LENGTH}
          editable={!sending}
          style={styles.composerInput}
          testID="room-messages-input"
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
          >
            {sending ? (
              <ActivityIndicator size="small" color={ACCESSIBLE_GOLD_TEXT} />
            ) : (
              <Text style={styles.pillButtonText}>SEND</Text>
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
    ...TYPOGRAPHY.caption,
    color: ACCESSIBLE_GOLD_TEXT,
    letterSpacing: 2.2,
    marginBottom: SPACING.md,
  },
  statusCard: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    paddingVertical: SPACING.lg,
    paddingHorizontal: SPACING.md,
    alignItems: 'center',
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  statusText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
    textAlign: 'center',
  },
  errorText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    textAlign: 'center',
    marginTop: SPACING.xs,
  },
  messageList: {
    gap: SPACING.sm,
  },
  messageCard: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
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
    ...TYPOGRAPHY.caption,
    color: ACCESSIBLE_GOLD_TEXT,
    letterSpacing: 1.4,
  },
  messageTime: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
  },
  messageMetaRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  reportButtonText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.error,
    fontWeight: '600',
  },
  messageBody: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextPrimary,
    lineHeight: 22,
  },
  composerCard: {
    marginTop: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    padding: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  composerInput: {
    minHeight: 72,
    color: COLORS.editorialTextPrimary,
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
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextSecondary,
  },
  charCountError: {
    color: COLORS.error,
  },
  pillButton: {
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.gold,
    backgroundColor: COLORS.surfaceCard,
    minWidth: 72,
    alignItems: 'center',
  },
  pillButtonDisabled: {
    opacity: 0.45,
  },
  pillButtonText: {
    ...TYPOGRAPHY.caption,
    color: ACCESSIBLE_GOLD_TEXT,
    letterSpacing: 1.4,
  },
});
