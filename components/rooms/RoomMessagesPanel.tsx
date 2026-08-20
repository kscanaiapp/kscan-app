import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
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
  ROOM_MESSAGES_MESSAGING_UNAVAILABLE,
  ROOM_MESSAGES_STALE_ERROR,
  ROOM_MESSAGES_LOAD_ERROR,
  sendRoomMessage,
  type RoomMessage,
} from '../../services/roomMessages';
import {
  bumpCollabActorGeneration,
  createCollabRequestId,
  getCollabActorGeneration,
  isCurrentCollabGeneration,
  listBlockableCounterparties,
  resolveCollaborationAccess,
  startCollaborationBoundedRefresh,
  type BlockableCounterparty,
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
const COMPOSER_UNAVAILABLE_PLACEHOLDER = 'Messaging is unavailable.';
const HIDDEN_PARTICIPANT_COPY = 'Hidden participant';
const SAFETY_SECTION_TITLE = 'Room Safety';
const SAFETY_SECTION_SUBTITLE =
  'Block someone in this room, whether or not they have sent a message.';

/** Access revalidation cadence while a room screen is open and focused. */
const ACCESS_REVALIDATE_MS = 30_000;

function threadsEnabled() {
  return DRESSING_ROOM_THREADS_V1;
}

/**
 * Message catch-up polling stays behind its original flag: enabling it changes
 * the network profile of every open room, which is a product decision, not a
 * safety one.
 */
function messageSyncEnabled() {
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
  blocking,
  reportingUser,
}: {
  message: RoomMessage;
  onReport: (message: RoomMessage) => void;
  onReportUser: (message: RoomMessage) => void;
  onBlock: (message: RoomMessage) => void;
  onReply?: (message: RoomMessage) => void;
  replyEnabled: boolean;
  /** This message's sender has a block in flight. */
  blocking: boolean;
  /** This message's sender has a user-report in flight. */
  reportingUser: boolean;
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
              style={styles.inlineAction}
              accessibilityRole="button"
              accessibilityLabel="Reply to message"
              accessibilityHint="Reply to this message in the room"
              testID={`room-message-reply-${message.id}`}
            >
              <Text style={styles.replyButtonText}>Reply</Text>
            </TouchableOpacity>
          ) : null}
          {!message.isMine ? (
            <TouchableOpacity
              onPress={() => onReportUser(message)}
              disabled={reportingUser}
              style={[styles.inlineAction, reportingUser ? styles.inlineActionDisabled : null]}
              accessibilityRole="button"
              accessibilityLabel="Report user"
              accessibilityHint="Send this account to K Scan AI for review"
              accessibilityState={{ disabled: reportingUser, busy: reportingUser }}
              testID={`room-message-report-user-${message.id}`}
            >
              <Text style={styles.reportButtonText}>
                {reportingUser ? 'Reporting…' : 'Report user'}
              </Text>
            </TouchableOpacity>
          ) : null}
          {!message.isMine ? (
            <TouchableOpacity
              onPress={() => onBlock(message)}
              disabled={blocking}
              style={[styles.inlineAction, blocking ? styles.inlineActionDisabled : null]}
              accessibilityRole="button"
              accessibilityLabel="Block user"
              accessibilityHint="Stop Dressing Room interaction with this account"
              accessibilityState={{ disabled: blocking, busy: blocking }}
              testID={`room-message-block-${message.id}`}
            >
              <Text style={styles.reportButtonText}>{blocking ? 'Blocking…' : 'Block'}</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => onReport(message)}
            style={styles.inlineAction}
            accessibilityRole="button"
            accessibilityLabel="Report message"
            accessibilityHint="Report and hide this message on this device"
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

/**
 * A sender hidden by Report & Hide. Their content stays hidden, but Block must
 * remain reachable: hiding used to remove the only route to blocking them.
 */
function HiddenSenderRow({
  senderId,
  onBlock,
  blocking,
}: {
  senderId: string;
  onBlock: (senderId: string) => void;
  blocking: boolean;
}) {
  return (
    <View style={styles.hiddenCard} testID={`room-hidden-sender-${senderId}`}>
      <Text style={styles.hiddenLabel}>{HIDDEN_PARTICIPANT_COPY}</Text>
      <TouchableOpacity
        style={[styles.pillButton, blocking ? styles.pillButtonDisabled : null]}
        onPress={() => onBlock(senderId)}
        disabled={blocking}
        accessibilityRole="button"
        accessibilityLabel="Block user"
        accessibilityHint="Stop Dressing Room interaction with this hidden account"
        accessibilityState={{ disabled: blocking, busy: blocking }}
        testID={`room-hidden-sender-block-${senderId}`}
      >
        <Text style={styles.pillButtonText}>{blocking ? 'Blocking…' : 'Block'}</Text>
      </TouchableOpacity>
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
  // The backend's live, block-aware capability. Optimistic until the first
  // resolve so the composer does not flicker disabled on every mount; the
  // backend remains the final authority on every send regardless.
  const [canMessage, setCanMessage] = useState(true);
  const [counterparties, setCounterparties] = useState<BlockableCounterparty[]>([]);
  const [blockingUserId, setBlockingUserId] = useState<string | null>(null);
  const [reportingUserId, setReportingUserId] = useState<string | null>(null);
  const sendInFlightRef = useRef(false);
  const pendingSendRef = useRef<{
    logicalKey: string;
    clientMessageId: string;
  } | null>(null);
  // Single-flight guards. Refs (not state) so a second tap in the same frame,
  // before React re-renders the disabled button, is still rejected.
  const blockInFlightRef = useRef(false);
  const reportUserInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  /** Last known signed-in account, so a self-block can never be offered. */
  const currentUserIdRef = useRef<string | null>(null);
  const accessVersionRef = useRef(0);
  const newestCursorRef = useRef<MessageCursor | null>(null);
  const syncStopRef = useRef<null | (() => void)>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const clearInteractiveState = useCallback(() => {
    setMessages([]);
    setReplyTo(null);
    setOlderCursor(null);
    newestCursorRef.current = null;
    pendingSendRef.current = null;
    setDraft('');
    setSendError(null);
  }, []);

  /** Applies a revoked-access outcome uniformly: stop sending, drop protected
   *  state, and show neutral copy that never discloses a block. */
  const applyAccessRevoked = useCallback(() => {
    if (!mountedRef.current) return;
    setAccessRevoked(true);
    setCanMessage(false);
    setCounterparties([]);
    clearInteractiveState();
    setLoadError(ROOM_MESSAGES_ACCESS_ERROR);
  }, [clearInteractiveState]);

  /**
   * Re-resolves server-authoritative access. Returns the capability so callers
   * (notably send) can act on a fresh answer instead of a cached one.
   * Safety-critical, so this is never gated on a feature flag.
   */
  const revalidateAccess = useCallback(async (): Promise<{
    ok: boolean;
    canMessage: boolean;
  }> => {
    if (!roomId) return { ok: false, canMessage: false };
    const generation = getCollabActorGeneration();
    try {
      const access = await resolveCollaborationAccess(roomId);
      if (!mountedRef.current || !isCurrentCollabGeneration(generation)) {
        return { ok: false, canMessage: false };
      }
      if (!access.ok) {
        applyAccessRevoked();
        return { ok: false, canMessage: false };
      }
      accessVersionRef.current = access.accessVersion;
      setCanMessage(access.canMessage);
      return { ok: true, canMessage: access.canMessage };
    } catch {
      // Transient failures must not fabricate a denial; the backend still
      // enforces on the next real mutation.
      return { ok: true, canMessage: true };
    }
  }, [applyAccessRevoked, roomId]);

  const loadCounterparties = useCallback(async () => {
    if (!roomId) return;
    try {
      const { data } = await supabase.auth.getSession();
      const currentUserId = data.session?.user?.id ?? null;
      currentUserIdRef.current = currentUserId;
      const rows = await listBlockableCounterparties({
        roomId,
        currentUserId,
        roomOwnerId,
      });
      if (!mountedRef.current) return;
      setCounterparties(rows);
    } catch {
      if (mountedRef.current) setCounterparties([]);
    }
  }, [roomId, roomOwnerId]);

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
      if (!mountedRef.current) return;
      setMessages(fetchedPage.messages);
      setOlderCursor(fetchedPage.nextCursor);
      newestCursorRef.current = fetchedPage.newestCursor;
      accessVersionRef.current = fetchedPage.accessVersion;
      setHiddenIds(new Set(hiddenContentIds));
      setHiddenUserIds(new Set(hiddenUserIdsResult));
      // Reading messages proves canView, not canMessage: an owner whose only
      // participant is blocked still reads history but cannot send.
      void revalidateAccess();
      void loadCounterparties();
    } catch (err: any) {
      if (!mountedRef.current) return;
      clearInteractiveState();
      setHiddenIds(new Set());
      setHiddenUserIds(new Set());
      const message = typeof err?.message === 'string' ? err.message : ROOM_MESSAGES_LOAD_ERROR;
      setLoadError(message);
      if (message === ROOM_MESSAGES_ACCESS_ERROR) {
        setAccessRevoked(true);
        setCanMessage(false);
        setCounterparties([]);
      }
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [clearInteractiveState, loadCounterparties, revalidateAccess, roomId]);

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

  const reportUserById = useCallback(
    (targetUserId: string) => {
      if (!targetUserId || currentUserIdRef.current === targetUserId) return;
      // Reject the second tap before React can re-render the disabled button.
      if (reportUserInFlightRef.current) return;
      reportUserInFlightRef.current = true;

      const release = () => {
        reportUserInFlightRef.current = false;
        if (mountedRef.current) setReportingUserId(null);
      };

      Alert.alert(
        'Report this user?',
        'We will review this account for violations of our community guidelines. This does not block them — use Block user separately if you also want to stop interacting with them.',
        [
          // Cancel must release the guard, or the control stays dead for the
          // rest of the session.
          { text: 'Cancel', style: 'cancel', onPress: release },
          {
            text: 'Report user',
            style: 'destructive',
            onPress: async () => {
              if (mountedRef.current) setReportingUserId(targetUserId);
              try {
                const result = await submitContentReport({
                  targetType: 'user',
                  targetId: targetUserId,
                  reportedUserId: targetUserId,
                  roomId,
                  reasonCategory: 'inappropriate',
                });
                if (result.ok) {
                  Alert.alert('Thanks. We received your report.');
                } else {
                  Alert.alert("We couldn't send that report. Please try again.");
                }
              } finally {
                release();
              }
            },
          },
        ],
        { onDismiss: release },
      );
    },
    [roomId],
  );

  const handleReportUser = useCallback(
    (message: RoomMessage) => {
      if (!message.senderId || message.isMine) return;
      reportUserById(message.senderId);
    },
    [reportUserById],
  );

  /**
   * Block by account id, so every entry point (a message, a hidden sender, or
   * the safety roster) shares one guarded implementation.
   */
  const blockUserById = useCallback(
    (targetUserId: string, targetIsRoomOwner: boolean) => {
      if (!targetUserId || currentUserIdRef.current === targetUserId) return;
      if (blockInFlightRef.current) return;
      blockInFlightRef.current = true;

      const release = () => {
        blockInFlightRef.current = false;
        if (mountedRef.current) setBlockingUserId(null);
      };

      // Consequence copy follows the viewer's real relationship to the room,
      // resolved by the caller from authoritative room data.
      const title = 'Block this user?';
      const body = isOwner
        ? 'They will no longer be able to access shared Dressing Rooms with you or send you Dressing Room messages. Existing messages may be retained for safety and recordkeeping.'
        : targetIsRoomOwner
          ? 'You will leave this shared Dressing Room and will no longer receive or send Dressing Room messages with this user. Existing messages may be retained for safety and recordkeeping.'
          : 'You will leave this shared Dressing Room. Existing messages may be retained for safety and recordkeeping.';

      Alert.alert(
        title,
        body,
        [
          { text: 'Cancel', style: 'cancel', onPress: release },
          {
            text: 'Block user',
            style: 'destructive',
            onPress: async () => {
              if (mountedRef.current) setBlockingUserId(targetUserId);
              try {
                await blockDressingRoomUser(targetUserId);
                Alert.alert('User blocked.');
                // The backend applied every access consequence in the same
                // transaction; re-resolve rather than assume what changed.
                await revalidateAccess();
                void load();
              } catch (err: any) {
                const errorMessage =
                  typeof err?.message === 'string'
                    ? err.message
                    : DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR;
                Alert.alert(errorMessage);
              } finally {
                release();
              }
            },
          },
        ],
        { onDismiss: release },
      );
    },
    [isOwner, load, revalidateAccess],
  );

  const handleBlock = useCallback(
    (message: RoomMessage) => {
      if (!message.senderId || message.isMine) return;
      blockUserById(message.senderId, message.senderId === roomOwnerId);
    },
    [blockUserById, roomOwnerId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user?.id ?? null;
      bumpCollabActorGeneration(nextUserId);
      currentUserIdRef.current = nextUserId;
      clearInteractiveState();
      setCounterparties([]);
      if (nextUserId) {
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

  /**
   * Bounded access revalidation for an already-open room.
   *
   * Deliberately NOT gated on DRESSING_ROOM_REALTIME_SYNC_V1: that flag is set
   * in no EAS profile, so gating it here meant a blocked counterparty's open
   * screen never observed the block, and the collaboration_access_version the
   * block transaction bumps had no consumer at all. Access revalidation is a
   * safety guarantee and must not depend on an unset flag.
   *
   * Message catch-up stays behind the flag — only the access check is
   * unconditional — and the interval is the slower access-only cadence unless
   * full sync is on, so this is not a high-frequency loop.
   */
  useEffect(() => {
    if (!roomId || accessRevoked) return;
    const syncMessages = messageSyncEnabled();
    const generation = getCollabActorGeneration();
    const handle = startCollaborationBoundedRefresh({
      roomId,
      actorGeneration: generation,
      knownAccessVersion: accessVersionRef.current,
      intervalMs: syncMessages ? undefined : ACCESS_REVALIDATE_MS,
      onAccessLost: applyAccessRevoked,
      onTick: async (accessVersion) => {
        accessVersionRef.current = accessVersion;
        // Refresh the capability every tick so an owner whose last unblocked
        // participant just left observes canMessage:false without a reload.
        void revalidateAccess();
        if (!syncMessages) return;
        const page = await catchUpRoomMessages({
          roomId,
          fromCursor: newestCursorRef.current,
        });
        if (!isCurrentCollabGeneration(generation) || !mountedRef.current) return;
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
  }, [accessRevoked, applyAccessRevoked, revalidateAccess, roomId]);

  // Foreground resume: also unconditional, for the same reason.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || accessRevoked || !mountedRef.current) return;
      void revalidateAccess();
    });
    return () => sub.remove();
  }, [accessRevoked, revalidateAccess]);

  // Screen focus: returning to the room re-checks before anything is shown as
  // interactive. Declared after the auth-transition effect above so an actor
  // switch is applied before a focus-driven revalidation runs.
  useFocusEffect(
    useCallback(() => {
      if (!accessRevoked) void revalidateAccess();
    }, [accessRevoked, revalidateAccess]),
  );

  const normalizedDraft = normalizeMessageBody(draft);
  const draftLength = normalizedDraft.length;
  const draftTooLong = draftLength > ROOM_MESSAGE_MAX_LENGTH;
  const composerEnabled = !accessRevoked && canMessage;
  const canSend = !sending && composerEnabled && draftLength > 0 && !draftTooLong;
  // Defense in depth: listBlockableCounterparties already excludes self, and
  // the backend rejects a self-block outright.
  const blockableCounterparties = useMemo(
    () => counterparties.filter((entry) => entry.userId !== currentUserIdRef.current),
    [counterparties],
  );

  const handleSend = async () => {
    if (!canSend || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setSendError(null);
    const sendGeneration = getCollabActorGeneration();
    const parentMessageId =
      threadsEnabled() && replyTo && !replyTo.parentMessageId ? replyTo.id : null;

    // Reuse one idempotency key across retries of the same logical draft, so a
    // retried send is deduped by the backend ledger instead of double-posting.
    const logicalKey = `${normalizedDraft}\u0000${parentMessageId ?? ''}`;
    const pending = pendingSendRef.current;
    const clientMessageId =
      pending?.logicalKey === logicalKey ? pending.clientMessageId : createCollabRequestId();
    pendingSendRef.current = { logicalKey, clientMessageId };

    try {
      // Revalidate before the write. The backend is still the final authority
      // (create_dressing_room_message re-checks and raises 42501), but this
      // turns a permanent denial into truthful copy instead of a generic
      // "please try again" the user would retry forever.
      const access = await revalidateAccess();
      if (!isCurrentCollabGeneration(sendGeneration) || !mountedRef.current) return;
      if (!access.ok) return; // applyAccessRevoked already surfaced neutral copy
      if (!access.canMessage) {
        setSendError(ROOM_MESSAGES_MESSAGING_UNAVAILABLE);
        return;
      }

      const sent = await sendRoomMessage(roomId, draft, {
        parentMessageId,
        clientMessageId,
      });
      if (!isCurrentCollabGeneration(sendGeneration) || accessRevoked || !mountedRef.current) {
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
      if (pendingSendRef.current?.clientMessageId === clientMessageId) {
        pendingSendRef.current = null;
      }
    } catch (err: any) {
      if (!isCurrentCollabGeneration(sendGeneration) || !mountedRef.current) {
        return;
      }
      const message = typeof err?.message === 'string' ? err.message : ROOM_MESSAGE_SEND_ERROR;
      if (message === ROOM_MESSAGES_STALE_ERROR) {
        clearInteractiveState();
        return;
      }
      if (message === ROOM_MESSAGES_ACCESS_ERROR) {
        applyAccessRevoked();
        return;
      }
      setSendError(message);
    } finally {
      sendInFlightRef.current = false;
      if (mountedRef.current) setSending(false);
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
          // Senders hidden by Report & Hide still need a Block route, so they
          // are surfaced as content-free rows rather than filtered away.
          const hiddenSenderIds = [...new Set(
            messages
              .map((message) => message.senderId)
              .filter((senderId) => Boolean(senderId) && hiddenUserIds.has(senderId)),
          )];
          return visibleMessages.length === 0 && hiddenSenderIds.length === 0 ? (
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
              {visibleMessages.length === 0 ? (
                <Text style={styles.statusText}>{MESSAGES_FILTERED_EMPTY_COPY}</Text>
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
                  blocking={blockingUserId === message.senderId}
                  reportingUser={reportingUserId === message.senderId}
                />
              ))}
              {hiddenSenderIds.map((senderId) => (
                <HiddenSenderRow
                  key={`hidden-${senderId}`}
                  senderId={senderId}
                  blocking={blockingUserId === senderId}
                  onBlock={(target) => blockUserById(target, target === roomOwnerId)}
                />
              ))}
            </View>
          );
        })()
      )}

      {!accessRevoked && blockableCounterparties.length > 0 ? (
        <View style={styles.safetyCard} testID="room-safety-controls">
          <Text style={styles.safetyTitle} accessibilityRole="header">
            {SAFETY_SECTION_TITLE}
          </Text>
          <Text style={styles.safetySubtitle}>{SAFETY_SECTION_SUBTITLE}</Text>
          {blockableCounterparties.map((counterparty) => (
            <View key={counterparty.userId} style={styles.safetyRow}>
              <Text style={styles.safetyLabel}>
                {counterparty.isRoomOwner ? 'Room owner' : 'Participant'}
              </Text>
              <TouchableOpacity
                style={[
                  styles.pillButton,
                  blockingUserId === counterparty.userId ? styles.pillButtonDisabled : null,
                ]}
                onPress={() => blockUserById(counterparty.userId, counterparty.isRoomOwner)}
                disabled={blockingUserId === counterparty.userId}
                accessibilityRole="button"
                accessibilityLabel="Block user"
                accessibilityHint="Stop Dressing Room interaction with this account"
                accessibilityState={{
                  disabled: blockingUserId === counterparty.userId,
                  busy: blockingUserId === counterparty.userId,
                }}
                testID={`room-safety-block-${counterparty.userId}`}
              >
                <Text style={styles.pillButtonText}>
                  {blockingUserId === counterparty.userId ? 'Blocking…' : 'Block'}
                </Text>
              </TouchableOpacity>
            </View>
          ))}
        </View>
      ) : null}

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
        {!composerEnabled ? (
          <Text style={styles.composerNotice} testID="room-messages-unavailable-notice">
            {accessRevoked ? ROOM_MESSAGES_ACCESS_ERROR : ROOM_MESSAGES_MESSAGING_UNAVAILABLE}
          </Text>
        ) : null}
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={composerEnabled ? COMPOSER_PLACEHOLDER : COMPOSER_UNAVAILABLE_PLACEHOLDER}
          placeholderTextColor={LUXURY.colors.stone}
          multiline
          textAlignVertical="top"
          maxLength={ROOM_MESSAGE_MAX_LENGTH}
          editable={!sending && composerEnabled}
          style={styles.composerInput}
          testID="room-messages-input"
          accessibilityLabel="Message composer"
          accessibilityHint="Type a message about this room"
          accessibilityState={{ disabled: !composerEnabled }}
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
    // B-04: on a non-mine, reply-eligible message, messageMetaRight can hold
    // a timestamp plus up to 3 inline actions (Reply/Report/Report
    // user/Block). Their combined intrinsic width exceeds the available
    // card width on small iPhones, and RN's row default (flexShrink: 0,
    // flexWrap: 'nowrap') does not shrink or wrap that content — it
    // overflows the card. Wrapping this row lets the actions drop to a
    // second line instead.
    flexWrap: 'wrap',
    rowGap: SPACING.xs,
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
    flexWrap: 'wrap',
    flexShrink: 1,
    justifyContent: 'flex-end',
    gap: SPACING.sm,
  },
  reportButtonText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.error,
    fontWeight: '600',
  },
  // Minimum comfortable hit target for the inline meta-row actions, which sit
  // side by side and include destructive ones.
  inlineAction: {
    minHeight: 36,
    minWidth: 44,
    paddingHorizontal: SPACING.xs,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inlineActionDisabled: {
    opacity: 0.45,
  },
  hiddenCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
  },
  hiddenLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    flex: 1,
  },
  safetyCard: {
    marginTop: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    gap: SPACING.sm,
    ...SHADOWS.editorialSmall,
  },
  safetyTitle: {
    ...LUXURY.typography.sectionLabel,
    color: LUXURY.colors.stone,
  },
  safetySubtitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
  },
  safetyRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.sm,
  },
  safetyLabel: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
    flex: 1,
  },
  composerNotice: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
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
