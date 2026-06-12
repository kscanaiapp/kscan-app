import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
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

// Private In-App Room Messaging v1.
// Rendered only inside the authenticated Dressing Room detail screen.
// Must never be rendered on public preview routes (app/(public)/rooms/*).

const ACCESSIBLE_GOLD_TEXT = '#72521E';
const MESSAGES_EMPTY_COPY = 'Discuss this room with people you invite.';
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

function MessageRow({ message }: { message: RoomMessage }) {
  return (
    <View style={styles.messageCard}>
      <View style={styles.messageMetaRow}>
        <Text style={styles.messageSender}>{message.isMine ? 'You' : 'Collaborator'}</Text>
        <Text style={styles.messageTime}>{formatMessageTimestamp(message.createdAt)}</Text>
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
  const sendInFlightRef = useRef(false);

  const load = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setLoadError(null);
    try {
      setMessages(await listRoomMessages(roomId));
    } catch (err: any) {
      // err.message is always a friendly string from services/roomMessages —
      // never a raw Supabase/Postgres/RLS error, and never a message body.
      setLoadError(typeof err?.message === 'string' ? err.message : ROOM_MESSAGES_LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [roomId]);

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

      {loading ? (
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
      ) : messages.length === 0 ? (
        <View style={styles.statusCard}>
          <Text style={styles.statusText}>{MESSAGES_EMPTY_COPY}</Text>
        </View>
      ) : (
        <View style={styles.messageList} testID="room-messages-list">
          {messages.map((message) => (
            <MessageRow key={message.id} message={message} />
          ))}
        </View>
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
