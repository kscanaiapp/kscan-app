import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  DRESSING_ROOM_MESSAGES_V1,
  DRESSING_ROOM_REALTIME_SYNC_V1,
  DRESSING_ROOM_THREADS_V1,
} from '../../constants/featureFlags';
import {
  listRoomMessages,
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
import {
  isReportServerAccepted,
  submitContentReport,
  submitUserReport,
} from '../../services/contentReports';
import { createSingleFlight } from '../../services/singleFlight';
import {
  blockDressingRoomUser,
  DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
} from '../../services/dressingRoomBlocks';

const MESSAGES_EMPTY_COPY = 'No messages yet. Start the conversation about this room.';
const MESSAGES_FILTERED_EMPTY_COPY =
  'You have reported or hidden all recent activity in this room.';
const SAFETY_SECTION_TITLE = 'Room Safety';
const SAFETY_SECTION_SUBTITLE =
  'Report or block anyone in this room without needing to find one of their messages.';
// The client confirms receipt only — it never asserts a moderation outcome.
const REPORT_USER_SUCCESS_COPY = 'Thanks. We received your report.';
const REPORT_USER_FAILURE_COPY = "We couldn't submit your report. Please try again.";
const COMPOSER_PLACEHOLDER = 'Message about this room…';

function collabMessagesEnabled() {
  return DRESSING_ROOM_COLLABORATION_V1 && DRESSING_ROOM_MESSAGES_V1;
}

function threadsEnabled() {
  return collabMessagesEnabled() && DRESSING_ROOM_THREADS_V1;
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
  blocking,
  reportingUser,
}: {
  message: RoomMessage;
  onReport: (message: RoomMessage) => void;
  onReportUser: (message: RoomMessage) => void;
  onBlock: (message: RoomMessage) => void;
  onReply?: (message: RoomMessage) => void;
  replyEnabled: boolean;
  blocking: boolean;
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
              testID={`room-message-reply-${message.id}`}
            >
              <Text style={styles.replyButtonText}>Reply</Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            onPress={() => onReport(message)}
            style={styles.inlineAction}
            accessibilityRole="button"
            accessibilityLabel="Report message"
            testID={`room-message-report-${message.id}`}
          >
            <Text style={styles.reportButtonText}>Report</Text>
          </TouchableOpacity>
          {!message.isMine && message.senderId ? (
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
          {!message.isMine && message.senderId ? (
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
        </View>
      </View>
      <Text style={styles.messageBody}>{message.body}</Text>
    </View>
  );
}

/**
 * A sender the viewer has already Report & Hidden. Their messages are filtered
 * out, so without this row the only way to escalate to a real account-level
 * block would be to un-hide them first.
 */
function HiddenSenderRow({
  senderId,
  blocking,
  onBlock,
}: {
  senderId: string;
  blocking: boolean;
  onBlock: (senderId: string) => void;
}) {
  return (
    <View style={styles.safetyRow}>
      <Text style={styles.safetyLabel}>Hidden participant</Text>
      <TouchableOpacity
        style={[styles.pillButton, blocking ? styles.pillButtonDisabled : null]}
        onPress={() => onBlock(senderId)}
        disabled={blocking}
        accessibilityRole="button"
        accessibilityLabel="Block user"
        accessibilityHint="Stop Dressing Room interaction with this account"
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
  /** True only when the *viewer* owns this room. Drives block consequence copy. */
  isOwner?: boolean;
  /** The ROOM's owner id — never the current user's id. */
  roomOwnerId?: string | null;
}) {
  /**
   * DEF-030 — the room owner must not stop being reportable because one
   * best-effort lookup failed.
   *
   * The screen resolves the owner once after joining and passes null on
   * failure. `listBlockableCounterparties` then contributes no owner entry, and
   * RLS means a participant's own row is the only participant row they can
   * read (which is skipped as self) -- so `counterparties` came back empty and
   * the whole Room Safety section stopped rendering. In an image-only room
   * with no messages, that removed the ONLY path to Report/Block.
   *
   * `revalidateAccess` already re-resolves access on the panel's own schedule
   * and was discarding `currentOwnerId`. Latching it here lets a failed initial
   * resolution self-heal with no extra request and no change to how rooms are
   * shared, joined, or enforced.
   */
  const [resolvedOwnerId, setResolvedOwnerId] = useState<string | null>(roomOwnerId ?? null);
  const effectiveOwnerId = roomOwnerId ?? resolvedOwnerId;

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
  const [canMessage, setCanMessage] = useState(true);
  const [counterparties, setCounterparties] = useState<BlockableCounterparty[]>([]);
  const [blockingUserId, setBlockingUserId] = useState<string | null>(null);
  const [reportingUserId, setReportingUserId] = useState<string | null>(null);
  const sendInFlightRef = useRef(false);
  // Single-flight guards for the *network* call only. Each is taken
  // immediately before its await and released in a `finally`, never while a
  // confirmation dialog is merely on screen (see DEF-B29-IOS-02B).
  const blockFlightRef = useRef(createSingleFlight());
  const reportUserFlightRef = useRef(createSingleFlight());
  const mountedRef = useRef(true);
  /** Last known signed-in account, so a self-block/self-report is never offered. */
  const currentUserIdRef = useRef<string | null>(null);
  const accessVersionRef = useRef(0);
  const newestCursorRef = useRef<MessageCursor | null>(null);
  const syncStopRef = useRef<null | (() => void)>(null);
  const pendingSendRef = useRef<{
    logicalKey: string;
    clientMessageId: string;
  } | null>(null);

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
    setDraft('');
    setSendError(null);
    pendingSendRef.current = null;
  }, []);

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
        setAccessRevoked(true);
        setCanMessage(false);
        setCounterparties([]);
        clearInteractiveState();
        setLoadError(ROOM_MESSAGES_ACCESS_ERROR);
        return { ok: false, canMessage: false };
      }
      accessVersionRef.current = access.accessVersion;
      // DEF-030: this response already carries the owner id. Latching it is
      // what repairs a failed initial resolution.
      if (typeof access.currentOwnerId === 'string' && access.currentOwnerId) {
        setResolvedOwnerId(access.currentOwnerId);
      }
      setCanMessage(access.canMessage);
      return { ok: true, canMessage: access.canMessage };
    } catch {
      // Transient failures must not fabricate a denial; the backend still
      // enforces on the next real mutation.
      return { ok: true, canMessage: true };
    }
  }, [clearInteractiveState, roomId]);

  const loadCounterparties = useCallback(async () => {
    if (!roomId) return;
    try {
      const { data } = await supabase.auth.getSession();
      const currentUserId = data.session?.user?.id ?? null;
      currentUserIdRef.current = currentUserId;
      const rows = await listBlockableCounterparties({
        roomId,
        currentUserId,
        roomOwnerId: effectiveOwnerId,
      });
      if (!mountedRef.current) return;
      setCounterparties(rows);
    } catch {
      if (mountedRef.current) setCounterparties([]);
    }
  }, [roomId, effectiveOwnerId]);

  const load = useCallback(async () => {
    if (!roomId) return;
    setLoading(true);
    setLoadError(null);
    setAccessRevoked(false);
    try {
      const [fetchedPage, hiddenContentIds, hiddenUserIdsResult] = await Promise.all([
        collabMessagesEnabled()
          ? listRoomMessagesPage({ roomId })
          : listRoomMessages(roomId).then((all) => ({
              messages: all,
              nextCursor: null as MessageCursor | null,
              newestCursor: null as MessageCursor | null,
              accessVersion: 0,
            })),
        readHiddenContentIds().catch(() => [] as string[]),
        readHiddenUserIds().catch(() => [] as string[]),
      ]);
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
      setLoading(false);
    }
  }, [clearInteractiveState, loadCounterparties, revalidateAccess, roomId]);

  const loadOlder = useCallback(async () => {
    if (!collabMessagesEnabled() || !olderCursor || loadingOlder) return;
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

  /**
   * Report an account by id, so every entry point (a message row or the Room
   * Safety roster) shares exactly one guarded implementation.
   *
   * DEF-B29-IOS-02B: no in-flight latch is taken while the confirmation dialog
   * is merely visible. The previous implementation latched before
   * `Alert.alert` and leaned on `{ onDismiss: release }` to recover — but
   * `onDismiss` is Android-only, so any iOS dismissal that never invoked a
   * button left the control permanently dead for the mounted panel. The latch
   * now covers only the network call and is always released in `finally`.
   */
  const reportUserById = useCallback(
    (targetUserId: string) => {
      if (!targetUserId || currentUserIdRef.current === targetUserId) return;

      Alert.alert(
        'Report this user?',
        'We will review this account for violations of our community guidelines. This does not block them — use Block user separately if you also want to stop interacting with them.',
        [
          // Cancel holds no state to release, so cancelling can never disable
          // a later attempt.
          { text: 'Cancel', style: 'cancel' },
          {
            text: 'Report user',
            style: 'destructive',
            onPress: () => {
              // The guard is taken here — at submit time — and released in the
              // runner's `finally`. Rapid confirms cannot produce a second
              // concurrent request.
              void reportUserFlightRef.current.run(async () => {
                if (mountedRef.current) setReportingUserId(targetUserId);
                try {
                  // Target identity is fixed by the service: both target_id
                  // and reported_user_id are the reported account's auth user
                  // id, never a room/participant/message id.
                  const result = await submitUserReport({
                    reportedUserId: targetUserId,
                    roomId,
                    reasonCategory: 'inappropriate',
                  });
                  // DEF-B29-IOS-02C: server acceptance is the ONLY basis for a
                  // receipt confirmation. `ok: true` alone also covers the
                  // local-only outcome (no authenticated session), which never
                  // reached the server and must not be claimed as received.
                  Alert.alert(
                    isReportServerAccepted(result)
                      ? REPORT_USER_SUCCESS_COPY
                      : REPORT_USER_FAILURE_COPY,
                  );
                } catch {
                  Alert.alert(REPORT_USER_FAILURE_COPY);
                } finally {
                  if (mountedRef.current) setReportingUserId(null);
                }
              });
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
      reportUserById(message.senderId);
    },
    [reportUserById],
  );

  /**
   * Block by account id, so every entry point (a message, a hidden sender, or
   * the safety roster) shares one guarded implementation. Same latch contract
   * as reportUserById — nothing is held while the dialog is merely visible.
   */
  const blockUserById = useCallback(
    (targetUserId: string, targetIsRoomOwner: boolean) => {
      if (!targetUserId || currentUserIdRef.current === targetUserId) return;

      // Consequence copy follows the viewer's real relationship to the room,
      // resolved by the caller from authoritative room data.
      const body = isOwner
        ? 'They will no longer be able to access shared Dressing Rooms with you or send you Dressing Room messages. Existing messages may be retained for safety and recordkeeping.'
        : targetIsRoomOwner
          ? 'You will leave this shared Dressing Room and will no longer receive or send Dressing Room messages with this user. Existing messages may be retained for safety and recordkeeping.'
          : 'You will leave this shared Dressing Room. Existing messages may be retained for safety and recordkeeping.';

      Alert.alert('Block this user?', body, [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Block user',
          style: 'destructive',
          onPress: () => {
            void blockFlightRef.current.run(async () => {
              if (mountedRef.current) setBlockingUserId(targetUserId);
              try {
                await blockDressingRoomUser(targetUserId);
                Alert.alert('User blocked.');
                // The backend applied every access consequence in the same
                // transaction; re-resolve rather than assume what changed.
                await revalidateAccess();
                void load();
              } catch (err: any) {
                Alert.alert(
                  typeof err?.message === 'string'
                    ? err.message
                    : DRESSING_ROOM_INTERACTION_UNAVAILABLE_ERROR,
                );
              } finally {
                if (mountedRef.current) setBlockingUserId(null);
              }
            });
          },
        },
      ]);
    },
    [isOwner, load, revalidateAccess],
  );

  const handleBlock = useCallback(
    (message: RoomMessage) => {
      if (!message.senderId || message.isMine) return;
      blockUserById(message.senderId, message.senderId === effectiveOwnerId);
    },
    [blockUserById, effectiveOwnerId],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      const nextUserId = session?.user?.id ?? null;
      bumpCollabActorGeneration(nextUserId);
      // Track the actor so a self-block/self-report can never be offered to
      // whoever signs in next on this device.
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
  const canSend =
    !sending && !accessRevoked && canMessage && draftLength > 0 && !draftTooLong;

  /**
   * Senders the viewer has Report & Hidden who still have visible history in
   * this room. Surfaced so an account-level Block stays reachable after the
   * device-local hide has filtered their messages away.
   */
  const hiddenSenderIds = useMemo(() => {
    if (!hiddenUserIds || hiddenUserIds.size === 0) return [] as string[];
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const message of messages) {
      const senderId = message.senderId;
      if (!senderId || message.isMine) continue;
      if (!hiddenUserIds.has(senderId) || seen.has(senderId)) continue;
      seen.add(senderId);
      ids.push(senderId);
    }
    return ids;
  }, [hiddenUserIds, messages]);

  /**
   * Roster targets, minus anyone already offered a Block on a hidden-sender
   * row, so the same account is never listed twice.
   */
  const blockableCounterparties = useMemo(
    () => counterparties.filter((entry) => !hiddenSenderIds.includes(entry.userId)),
    [counterparties, hiddenSenderIds],
  );

  const handleSend = async () => {
    if (!canSend || sendInFlightRef.current) return;
    sendInFlightRef.current = true;
    setSending(true);
    setSendError(null);
    const sendGeneration = getCollabActorGeneration();
    const parentMessageId =
      threadsEnabled() && replyTo && !replyTo.parentMessageId ? replyTo.id : null;
    const logicalKey = `${normalizedDraft}\u0000${parentMessageId ?? ''}`;
    const pending = pendingSendRef.current;
    const clientMessageId =
      pending?.logicalKey === logicalKey
        ? pending.clientMessageId
        : createCollabRequestId();
    pendingSendRef.current = { logicalKey, clientMessageId };
    try {
      // Re-resolve immediately before the write and honour the fresh answer:
      // a block applied since the last load must deny this send with accurate
      // copy rather than a generic "please try again".
      const fresh = await revalidateAccess();
      if (!fresh.ok || !fresh.canMessage) {
        if (fresh.ok) setSendError(ROOM_MESSAGES_MESSAGING_UNAVAILABLE);
        return;
      }
      const sent = await sendRoomMessage(roomId, draft, {
        parentMessageId,
        clientMessageId,
      });
      if (!isCurrentCollabGeneration(sendGeneration) || accessRevoked) {
        return;
      }
      setMessages((current) => mergeRoomMessages(current, [sent]));
      newestCursorRef.current = {
        createdAt: sent.createdAt,
        id: sent.id,
        direction: 'newer',
      };
      if (pendingSendRef.current?.clientMessageId === clientMessageId) {
        pendingSendRef.current = null;
      }
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
              {collabMessagesEnabled() && olderCursor ? (
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
                  blocking={blockingUserId === message.senderId}
                  reportingUser={reportingUserId === message.senderId}
                />
              ))}
              {hiddenSenderIds.map((senderId) => (
                <HiddenSenderRow
                  key={`hidden-${senderId}`}
                  senderId={senderId}
                  blocking={blockingUserId === senderId}
                  onBlock={(target) => blockUserById(target, target === effectiveOwnerId)}
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
              <View style={styles.safetyActions}>
                {/* DEF-B29-IOS-02D: reporting a participant must not require
                    hunting for one of their messages. Same handler as the
                    message-row entry point — never a second implementation. */}
                <TouchableOpacity
                  style={[
                    styles.pillButton,
                    reportingUserId === counterparty.userId ? styles.pillButtonDisabled : null,
                  ]}
                  onPress={() => reportUserById(counterparty.userId)}
                  disabled={reportingUserId === counterparty.userId}
                  accessibilityRole="button"
                  accessibilityLabel="Report user"
                  accessibilityHint="Send this account to K Scan AI for review"
                  accessibilityState={{
                    disabled: reportingUserId === counterparty.userId,
                    busy: reportingUserId === counterparty.userId,
                  }}
                  testID={`room-safety-report-user-${counterparty.userId}`}
                >
                  <Text style={styles.pillButtonText}>
                    {reportingUserId === counterparty.userId ? 'Reporting…' : 'Report'}
                  </Text>
                </TouchableOpacity>
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
        <TextInput
          value={draft}
          onChangeText={setDraft}
          placeholder={COMPOSER_PLACEHOLDER}
          placeholderTextColor={LUXURY.colors.stone}
          multiline
          textAlignVertical="top"
          maxLength={ROOM_MESSAGE_MAX_LENGTH}
          editable={!sending && !accessRevoked && canMessage}
          style={styles.composerInput}
          testID="room-messages-input"
          accessibilityLabel="Message composer"
          accessibilityHint="Type a message about this room"
          accessibilityState={{ disabled: accessRevoked || !canMessage }}
        />
        {!accessRevoked && !canMessage ? (
          <Text style={styles.statusText} testID="room-messages-messaging-unavailable">
            {ROOM_MESSAGES_MESSAGING_UNAVAILABLE}
          </Text>
        ) : null}
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
  /**
   * Sized container for the inline message actions (Reply / Report / Report
   * user / Block). Their labels, roles and disabled state were already correct,
   * but none declared a target, so it was whatever the small caption text
   * happened to measure — well under the platform minimum on a control that
   * performs a safety action.
   *
   * A sized container, not hitSlop: these sit in a tight horizontal row, where
   * overlapping hit areas would make the wrong action fire.
   */
  inlineAction: {
    minHeight: 48,
    justifyContent: 'center',
    paddingHorizontal: SPACING.xs,
  },
  inlineActionDisabled: {
    opacity: 0.45,
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
  safetyActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
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
