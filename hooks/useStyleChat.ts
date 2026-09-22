import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { EdgeStyleChatProvider } from '../services/style-chat/providers/edgeStyleChatProvider';
import { ELISE_CONCIERGE_V1 } from '../constants/featureFlags';
import { buildConciergeResult } from '../services/concierge/conciergeModel';
import {
  getStyleChatSession,
  listStyleChatMessages,
  saveStyleChatMessage,
  readStyleChatDailyUsage,
} from '../services/style-chat/styleChatRepository';
import { getFriendlyStyleChatError } from '../services/style-chat/styleChatErrors';
import type { StyleChatMessage, StyleChatSession, StyleChatUiBlock } from '../services/style-chat/types';
import type { WeatherLocationInput } from '../constants/weatherStyling';
import { saveTodayWeather } from '../services/weather/todayWeatherStore';
import type { StyleDnaContext } from '../services/style-dna/styleDnaContext';
import type { StyleChatHandoffContext } from '../services/style-chat/styleChatHandoffContext';
import type { GenderStylingContext } from '../constants/genderStylingContext';
import { STYLE_CHAT_COPY, STYLE_CHAT_DAILY_MESSAGE_LIMIT } from '../constants/styleChat';
import {
  buildAttachmentUiBlock,
  type DraftAttachment,
  type StyleChatAttachment,
} from '../types/styleChatAttachments';
import { createStyleChatRetryState } from '../services/style-chat/styleChatRetryState';
import { classifyStyleChatOperationalFailure } from '../services/style-chat/styleChatOutcome';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { captureActorScope, isActorScopeCurrent } from '../services/actorScope';
import {
  buildShoppingIntentBlock,
  parseShoppingIntentWire,
  runCommerceActivation,
} from '../services/style-chat/commerceActivation';
import {
  ELISE_CONVERSATION_QUALITY_V2_ENABLED,
  ELISE_LOCAL_CLARIFICATION_PROVIDER,
  analyzeEliseTurn,
  buildEliseConversationNotices,
  decideEliseCommerceActivation,
  validateEliseReply,
  type EliseCommerceDecision,
  type EliseReplyViolation,
  type EliseTurnAnalysis,
} from '../services/style-chat/eliseConversationFrame';
import {
  constraintBucket,
  frameMsBucket,
  recordEliseConversationTurn,
} from '../services/style-chat/eliseConversationTelemetry';
import { fetchDeferredCommerce } from '../services/commerceHydration';
import { listOwnedClosetItems } from '../services/ownedClosetItems';
import { useStylistIdentity } from './useStylistIdentity';
import { useScreenReaderEnabled, useScreenReaderReady } from './useScreenReaderEnabled';
import { getStylistVoiceProfile } from '../constants/stylistIdentity';
import { speakAvatarMessage, stopAvatarSpeechPlayback } from '../services/avatarSpeech';
import { useVoiceResponsesPreference } from './useVoiceResponsesPreference';
import {
  claimGreetingSpeechAttempt,
  ensureSessionGreeting,
  getGreetingTextForUser,
  getPendingGreetingSpeechMessageId,
  isSessionGreeted,
  markSessionGreeted,
  noteInsertedGreetingForSpeech,
  waitForSessionGreeting,
} from '../services/style-chat/styleChatGreeting';

export const STYLECHAT_ATTACHMENTS_UNSUPPORTED_COPY =
  "Closet-aware messaging isn't available yet. Your attachments are still here.";
export const STYLECHAT_ATTACHMENTS_REJECTED_COPY =
  'Elise could not access the selected image or item. You can retry, remove it, or continue without attachments.';
export const STYLECHAT_ATTACHMENT_EMPTY_RESPONSE_COPY =
  'I couldn’t generate advice for that attachment. Please try again.';
export const STYLECHAT_VISUAL_COLLECTION_UNSUPPORTED_COPY =
  "Multi-reference styling isn't available yet. Your references and draft are still here.";
export const STYLECHAT_VISUAL_COLLECTION_REJECTED_COPY =
  "Elise couldn't safely read those references. Your references and draft are still here.";

export type SendAttachmentsInput = {
  /** Immutable snapshot captured at send time (ready resolved refs only). */
  references: StyleChatAttachment[];
  drafts: DraftAttachment[];
  contextHint?: string | null;
  /**
   * Canonical Elise fashion identity for this send (Phase 2B.3).
   *
   * Part of the immutable send snapshot for the same reason the references are:
   * it must describe the attachments as they were when the user pressed send, not
   * as they are when the response lands.
   */
  fashionContext?: unknown;
  onSending?: () => void;
  /** Called only after a successful attachment-aware send. */
  onSent?: () => void;
  onSendFailed?: () => void;
};

// v0.4: swap to EdgeStyleChatProvider without touching this hook's external API.
// MockStyleChatProvider remains available in edgeStyleChatProvider's fallback chain.
const provider = new EdgeStyleChatProvider();

// Local rollback switch for the visible "Why this works" explanation slice (Option A).
// Set to false to stop rendering/persisting explanation blocks with no backend change.
const ENABLE_STYLECHAT_EXPLANATIONS = true;

function getSafeCount(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
}

/**
 * Conversation Quality V2 telemetry: enums and buckets only. The analysis is
 * passed in whole and reduced HERE to codes, so no call site can hand the sink
 * a message, a product name or a Closet item.
 */
function recordConversationTurn(
  turn: EliseTurnAnalysis,
  frameMs: number,
  outcome: 'model_reply' | 'local_clarification',
  commerce: EliseCommerceDecision | null,
  violations: readonly EliseReplyViolation[] | null,
): void {
  const conflict = violations?.some((v) => v.kind === 'negation') ?? false;
  const repeat = violations?.some((v) => v.kind === 'rejected_repeat') ?? false;
  const frame = turn.frame;
  recordEliseConversationTurn({
    relation: turn.relation,
    taskKind: frame.taskKind,
    taskReset: turn.taskReset,
    ownedOnly: frame.ownedOnly,
    outcome,
    reference: turn.reference.status,
    commerce: !commerce
      ? 'none'
      : commerce.action === 'allow'
        ? 'allow'
        : commerce.code === 'shopping_held_owned_only' ? 'hold_owned_only' : 'hold_not_requested',
    validation: violations === null
      ? 'skipped'
      : conflict && repeat ? 'both' : conflict ? 'constraint_conflict' : repeat ? 'rejected_repeat' : 'clean',
    constraintBucket: constraintBucket(
      frame.negations.length + frame.rejections.length + frame.colors.length +
        (frame.budget ? 1 : 0) + (frame.occasion ? 1 : 0) + (frame.ownedOnly ? 1 : 0),
    ),
    frameMsBucket: frameMsBucket(frameMs),
  });
}

export interface UseStyleChatReturn {
  session: StyleChatSession | null;
  messages: StyleChatMessage[];
  loadingSession: boolean;
  loadingMessages: boolean;
  isSending: boolean;
  error: string | null;
  messagesUsed: number;
  messagesLimit: number;
  canSend: boolean;
  sendMessage: (
    text: string,
    options?: {
      skipUserPersistence?: boolean;
      existingUserMessageId?: string | null;
      attachments?: SendAttachmentsInput | null;
      onUserMessagePersisted?: () => void;
    },
  ) => Promise<boolean>;
  retryLastMessage: () => void;
  clearError: () => void;
}

export interface UseStyleChatOptions {
  // Awaited before each send; returns a rounded weather location or null to skip.
  getWeatherLocation?: () => Promise<WeatherLocationInput | null>;
  // Awaited before each send; returns a data-only Style DNA context or null to skip.
  getStyleDnaContext?: () => Promise<StyleDnaContext | null>;
  // Active scan/upload/TextScan context visible in the StyleChat UI. Passed to the
  // backend on every message so replies are grounded to the reference item.
  activeContext?: StyleChatHandoffContext | null;
  // Fix #5 — explicit, self-disclosed baseline styling context. A stable stored
  // value (not re-resolved per send like weather/Style DNA); null when the user
  // has not answered or chose "prefer not to say" is still sent explicitly so
  // the backend can distinguish "answered neutral" from "never asked."
  genderStylingContext?: GenderStylingContext | null;
}

export function useStyleChat(sessionId: string, opts?: UseStyleChatOptions): UseStyleChatReturn {
  const [session, setSession] = useState<StyleChatSession | null>(null);
  const [messages, setMessages] = useState<StyleChatMessage[]>([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const isSendingRef = useRef(false);
  const sendScopeVersionRef = useRef(0);
  const activeAttachmentSendFailureRef = useRef<(() => void) | null>(null);
  const retryStateRef = useRef<ReturnType<typeof createStyleChatRetryState<SendAttachmentsInput>> | null>(null);
  if (!retryStateRef.current) {
    retryStateRef.current = createStyleChatRetryState<SendAttachmentsInput>();
  }
  // Held in a ref so passing an inline getter does not churn sendMessage/retry identity.
  const getWeatherLocationRef = useRef(opts?.getWeatherLocation);
  getWeatherLocationRef.current = opts?.getWeatherLocation;
  const getStyleDnaContextRef = useRef(opts?.getStyleDnaContext);
  getStyleDnaContextRef.current = opts?.getStyleDnaContext;
  const activeContextRef = useRef(opts?.activeContext);
  activeContextRef.current = opts?.activeContext;
  const genderStylingContextRef = useRef(opts?.genderStylingContext);
  genderStylingContextRef.current = opts?.genderStylingContext;
  const [error, setError] = useState<string | null>(null);
  const [messagesUsed, setMessagesUsed] = useState(0);
  const [messagesLimit, setMessagesLimit] = useState(STYLE_CHAT_DAILY_MESSAGE_LIMIT);

  // Identity and greeting state for the automatic session entry greeting.
  const { user } = useAuthSession();
  const { identity, isLoading: identityLoading } = useStylistIdentity();
  const actorId = user?.id ?? null;
  // Mirrored into a ref for the same reason as the getters above: the send path
  // reads the owner of the weather reading without taking `actorId` as a
  // dependency and churning sendMessage/retry identity on every auth refresh.
  const actorIdRef = useRef(actorId);
  actorIdRef.current = actorId;
  const screenReaderEnabled = useScreenReaderEnabled();
  const screenReaderReady = useScreenReaderReady();
  const voicePreference = useVoiceResponsesPreference();
  // Wait for identity hydrate/failure so a provisional silent default cannot
  // permanently seed and mute a welcome that belongs to a portrait avatar.
  const identityReady = !identityLoading;
  const greetingText = useMemo(
    () => getGreetingTextForUser(user, identity),
    [user, identity],
  );
  const voiceProfile = useMemo(
    () => getStylistVoiceProfile(identity.avatarId),
    [identity.avatarId],
  );
  const canSpeakNewMessages =
    voicePreference.enabled &&
    !voicePreference.loading &&
    screenReaderReady &&
    !screenReaderEnabled &&
    voiceProfile !== 'silent';

  useEffect(() => {
    activeAttachmentSendFailureRef.current?.();
    activeAttachmentSendFailureRef.current = null;
    const scopeVersion = sendScopeVersionRef.current + 1;
    sendScopeVersionRef.current = scopeVersion;
    isSendingRef.current = false;
    setIsSending(false);
    setError(null);
    retryStateRef.current?.clear();
    return () => {
      if (sendScopeVersionRef.current === scopeVersion) {
        sendScopeVersionRef.current += 1;
      }
      const failActiveAttachmentSend = activeAttachmentSendFailureRef.current;
      activeAttachmentSendFailureRef.current = null;
      failActiveAttachmentSend?.();
    };
  }, [actorId, sessionId]);

  // Load session, messages, and today's daily usage on mount.
  useEffect(() => {
    let cancelled = false;

    setSession(null);
    setMessages([]);

    if (!actorId || !sessionId) {
      setLoadingSession(false);
      setLoadingMessages(false);
      return () => {
        cancelled = true;
      };
    }

    async function loadSession() {
      setLoadingSession(true);
      try {
        const s = await getStyleChatSession(sessionId, actorId);
        if (!cancelled) setSession(s);
      } catch (err: unknown) {
        if (!cancelled) setError(getFriendlyStyleChatError(err));
      } finally {
        if (!cancelled) setLoadingSession(false);
      }
    }

    async function loadMessages() {
      setLoadingMessages(true);
      try {
        const msgs = await listStyleChatMessages(sessionId, actorId);
        if (!cancelled) setMessages(msgs);
      } catch (err: unknown) {
        if (!cancelled) setError(getFriendlyStyleChatError(err));
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    }

    async function loadDailyUsage() {
      try {
        const usage = await readStyleChatDailyUsage();
        if (!cancelled) {
          setMessagesUsed(getSafeCount(usage.messagesUsed, 0));
          setMessagesLimit(getSafeCount(usage.messagesLimit, STYLE_CHAT_DAILY_MESSAGE_LIMIT));
        }
      } catch {
        // Non-fatal: daily usage display falls back to 0; server enforces the cap.
      }
    }

    void loadSession();
    void loadMessages();
    void loadDailyUsage();

    return () => {
      cancelled = true;
    };
  }, [actorId, sessionId]);

  // Insert a single persisted greeting into brand-new sessions and speak it once
  // when an approved voice is configured. Durable dedupe is provided by the
  // greeting uiBlocks marker; in-flight insert dedupe is provided by the service.
  // Fresh-insert speech eligibility is retained across remount/cancel so a
  // temporary fail-closed screen-reader probe cannot permanently mute welcome audio.
  useEffect(() => {
    if (
      !actorId ||
      !sessionId ||
      session?.id !== sessionId ||
      loadingSession ||
      loadingMessages ||
      !identityReady ||
      voicePreference.loading ||
      !screenReaderReady
    ) return;

    const pendingSpeechMessageId = getPendingGreetingSpeechMessageId(actorId, sessionId);
    if (messages.length > 0 && !pendingSpeechMessageId) return;
    if (isSessionGreeted(actorId, sessionId) && !pendingSpeechMessageId) return;

    let cancelled = false;
    // INT-KPLUS-002 — capture the actor GENERATION before any async work.
    // `cancelled` only covers this effect re-running; it cannot reject a late
    // greeting whose actor changed underneath it, and `actorId` alone cannot
    // distinguish the first A of an A -> B -> A switch from the current one.
    // Every mutation below is gated on this scope still being live.
    const scope = captureActorScope();
    const stale = () => cancelled || !isActorScopeCurrent(scope);

    async function insertGreeting() {
      try {
        if (messages.length === 0 && !isSessionGreeted(actorId!, sessionId)) {
          const result = await ensureSessionGreeting(actorId!, sessionId, greetingText);
          // Actor-bound: this re-arms welcome speech in a store that the actor
          // transition just cleared. It MUST be gated -- previously it ran
          // before the staleness check and resurrected the previous actor's
          // pending greeting speech.
          if (stale()) return;
          // Retain one speech attempt across cancel/remount only when voice was
          // already eligible at insert. Voice-off welcomes must not speak later
          // merely because the preference was enabled afterward.
          if (result.inserted && result.message && canSpeakNewMessages) {
            noteInsertedGreetingForSpeech(actorId!, sessionId, result.message.id);
          }

          markSessionGreeted(actorId!, sessionId);

          if (result.message) {
            setMessages((prev) =>
              prev.some((m) => m.id === result.message!.id)
                ? prev
                : [...prev, result.message!],
            );
          }
        } else if (!isSessionGreeted(actorId!, sessionId)) {
          if (stale()) return;
          markSessionGreeted(actorId!, sessionId);
        }

        if (stale()) return;
        if (!canSpeakNewMessages) return;

        const speechMessageId = claimGreetingSpeechAttempt(actorId!, sessionId);
        if (!speechMessageId) return;
        // Re-check immediately before speaking: claiming is itself a mutation
        // and playback is actor-visible.
        if (stale()) return;

        void speakAvatarMessage({
          actorId: actorId!,
          sessionId,
          messageId: speechMessageId,
          stylistId: identity.avatarId,
          avatarId: identity.avatarId,
          source: 'greeting',
        });
      } catch {
        // Greeting persistence is best-effort here. A user send retries the same
        // transaction and must remain usable even while the network is down.
      }
    }

    void insertGreeting();

    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    session?.id,
    actorId,
    loadingSession,
    loadingMessages,
    identityReady,
    messages.length,
    greetingText,
    canSpeakNewMessages,
    identity.avatarId,
    voicePreference.loading,
    screenReaderReady,
  ]);

  // Stop any active avatar speech when leaving this session or switching actors.
  useEffect(() => {
    if (!actorId || !sessionId) return;
    const speechScope = {
      actorId,
      sessionId,
      avatarId: identity.avatarId,
    };
    return () => {
      void stopAvatarSpeechPlayback(speechScope);
    };
  }, [sessionId, actorId, identity.avatarId]);

  // Turning voice responses off is an immediate interruption and never causes
  // an old message to replay if the preference is enabled again later.
  useEffect(() => {
    if (!actorId || voicePreference.loading || voicePreference.enabled) return;
    void stopAvatarSpeechPlayback({ actorId, sessionId, avatarId: identity.avatarId });
  }, [actorId, sessionId, identity.avatarId, voicePreference.enabled, voicePreference.loading]);

  const canSend = Boolean(actorId && sessionId && session?.id === sessionId) &&
    messagesUsed < messagesLimit &&
    !isSending;

  const sendMessage = useCallback(
    async (
      text: string,
      options?: {
        skipUserPersistence?: boolean;
        existingUserMessageId?: string | null;
        /** v2 (Closet Intelligence): ready resolved attachments for this send. */
        attachments?: SendAttachmentsInput | null;
        onUserMessagePersisted?: () => void;
      },
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return false;
      if (!actorId || !sessionId || session?.id !== sessionId) {
        setError(STYLE_CHAT_COPY.errorGeneric);
        return false;
      }
      if (isSendingRef.current) return false;
      if (messagesUsed >= messagesLimit) {
        setError(STYLE_CHAT_COPY.systemLimitNotice);
        return false;
      }
      isSendingRef.current = true;
      setIsSending(true);
      void stopAvatarSpeechPlayback({ actorId, sessionId, avatarId: identity.avatarId });
      retryStateRef.current?.clear();
      const sendScopeVersion = sendScopeVersionRef.current;
      // INT-KPLUS-002 — the send scope version resets on [actorId, sessionId],
      // but the actor epoch is what rejects work started during an EARLIER
      // generation of the same actor. Require both.
      const sendActorScope = captureActorScope();
      const isCurrentSend = () =>
        sendScopeVersionRef.current === sendScopeVersion && isActorScopeCurrent(sendActorScope);

      // For the very first message in a new session, make sure the assistant
      // greeting is persisted before the user message when the transaction
      // settles within the bounded wait. A slow greeting can never deadlock or
      // discard the user's message.
      if (messages.length === 0) {
        try {
          const greetingResult = await waitForSessionGreeting(
            ensureSessionGreeting(actorId, sessionId, greetingText),
          );
          // Gate BEFORE mutating: this used to mark the session greeted and
          // push the greeting into `messages` even when the actor had already
          // changed, because the only guard sat after the whole block.
          if (!isCurrentSend()) return;
          if (greetingResult) {
            markSessionGreeted(actorId, sessionId);
          }
          if (greetingResult?.message) {
            setMessages((prev) =>
              prev.some((m) => m.id === greetingResult.message!.id)
                ? prev
                : [...prev, greetingResult.message!],
            );
          }
        } catch {
          // Non-fatal: proceed without the greeting if persistence is unavailable.
        }
      }
      if (!isCurrentSend()) return;

      // Attachment-bearing sends defer user-message persistence until the
      // backend acknowledges the v2 contract: an unsupported/rejected outcome
      // must leave the composer draft (text + attachments) fully intact and
      // must never present an attachment-blind reply as attachment-aware.
      const sendAttachments = options?.attachments ?? null;
      const hasAttachments =
        !!sendAttachments &&
        (sendAttachments.references.length > 0 || sendAttachments.fashionContext != null);
      const activeContextSnapshot = activeContextRef.current ?? null;
      const hasVisualCollection = Boolean(
        activeContextSnapshot?.visualCollection?.evidence?.length,
      );
      const requiresContextAcknowledgement = hasAttachments || hasVisualCollection;
      const attachmentUiBlocks: StyleChatUiBlock[] =
        hasAttachments && sendAttachments.drafts.some((draft) => Boolean(draft.resolved))
        ? [buildAttachmentUiBlock(sendAttachments.drafts) as unknown as StyleChatUiBlock]
        : [];
      let attachmentSendSucceeded = false;

      const skipUserPersistence = options?.skipUserPersistence === true;
      // Attachment sends defer persistence until backend v2 acknowledgement,
      // but still render an optimistic bubble.
      const deferUserPersistence = skipUserPersistence || requiresContextAcknowledgement;

      // ── Conversation Quality V2: the task frame ─────────────────────────
      //
      // Derived from the history this hook ALREADY holds, plus this message.
      // Pure and local: no request field, no extra read, no model call, and
      // nothing persisted beyond the notices it may add to this reply. A
      // retry's own earlier row is excluded so the turn is not counted twice.
      const frameStartedAt = Date.now();
      const conversationTurn: EliseTurnAnalysis | null = ELISE_CONVERSATION_QUALITY_V2_ENABLED
        ? analyzeEliseTurn({
            messages: options?.existingUserMessageId
              ? messages.filter((m) => m.id !== options.existingUserMessageId)
              : messages,
            message: trimmed,
          })
        : null;
      const frameMs = Date.now() - frameStartedAt;
      // A reference that is ambiguous in what was SHOWN is answered without a
      // model call ("Do you mean the denim jacket or the leather jacket?").
      // Never when something else in view could be what "that" means: an
      // attachment, a visual collection, or an active scan/upload context.
      const localClarification =
        conversationTurn?.localClarification &&
        !skipUserPersistence &&
        !requiresContextAcknowledgement &&
        !activeContextSnapshot
          ? conversationTurn.localClarification
          : null;
      let persistedUserMessageId = options?.existingUserMessageId ?? null;

      // 1. Optimistic user bubble
      const optimisticUser: StyleChatMessage | null = skipUserPersistence
        ? null
        : {
            id: `optimistic-user-${Date.now()}`,
            sessionId,
            sender: 'user',
            content: trimmed,
            referencedScanIds: [],
            referencedSavedItemIds: [],
            referencedDressingRoomIds: [],
            referencedCatalogItems: [],
            uiBlocks: attachmentUiBlocks,
            provider: 'client',
            tokenEstimate: 0,
            createdAt: new Date().toISOString(),
          };

      if (optimisticUser) {
        setMessages(prev => [...prev, optimisticUser]);
      }
      setError(null);

      try {
        // 2. Persist user message; replace optimistic entry with real row.
        //    (Attachment sends persist AFTER the backend acknowledges v2.)
        if (!deferUserPersistence) {
          const savedUser = await saveStyleChatMessage({
            sessionId,
            sender: 'user',
            content: trimmed,
          }, actorId);
          if (!isCurrentSend()) return;
          persistedUserMessageId = savedUser.id;
          setMessages(prev =>
            prev.map(m => (m.id === optimisticUser?.id ? savedUser : m)),
          );
          options?.onUserMessagePersisted?.();
        }

        // 2b. Conversation Quality V2 — a clarification the client can answer
        //     from what it showed. Zero model calls and zero quota: the
        //     question is about which of two shown things was meant, which is
        //     a fact, not a styling judgement. Persisted like the greeting (a
        //     client-authored assistant row), so the next turn's server-side
        //     history carries the question the customer is answering.
        if (localClarification && conversationTurn) {
          const optimisticClarification: StyleChatMessage = {
            id: `optimistic-assistant-${Date.now()}`,
            sessionId,
            sender: 'assistant',
            content: localClarification,
            referencedScanIds: [],
            referencedSavedItemIds: [],
            referencedDressingRoomIds: [],
            referencedCatalogItems: [],
            uiBlocks: [],
            provider: ELISE_LOCAL_CLARIFICATION_PROVIDER,
            tokenEstimate: 0,
            createdAt: new Date().toISOString(),
          };
          setMessages(prev => [...prev, optimisticClarification]);
          const savedClarification = await saveStyleChatMessage({
            sessionId,
            sender: 'assistant',
            content: localClarification,
            uiBlocks: [],
            provider: ELISE_LOCAL_CLARIFICATION_PROVIDER,
            tokenEstimate: 0,
          }, actorId);
          if (!isCurrentSend()) return;
          setMessages(prev =>
            prev.map(m => (m.id === optimisticClarification.id ? savedClarification : m)),
          );
          if (canSpeakNewMessages) {
            void speakAvatarMessage({
              actorId,
              sessionId,
              messageId: savedClarification.id,
              stylistId: identity.avatarId,
              avatarId: identity.avatarId,
              source: 'message',
            });
          }
          recordConversationTurn(conversationTurn, frameMs, 'local_clarification', null, null);
          return true;
        }

        // 3. Call the secure Edge Function proxy. Server enforces quota, assembles
        //    context, calls Gemini, and returns a typed result.
        // Weather is optional and best-effort: a failure/timeout resolves to null and
        // the message sends normally without weather context.
        const resolveWeather = getWeatherLocationRef.current;
        const weatherLocation = resolveWeather
          ? await resolveWeather().catch(() => null)
          : null;
        // Style DNA context is independent of weather and best-effort: any failure
        // resolves to null and the message sends normally. Read fresh each send so a
        // reset (which clears local feedback) immediately yields a neutral request.
        const resolveStyleDna = getStyleDnaContextRef.current;
        const styleDnaContext = resolveStyleDna
          ? await resolveStyleDna().catch(() => null)
          : null;
        if (!isCurrentSend()) return;
        // Active scan/upload/TextScan context is held in a ref so it is included on
        // every send while the context card is visible, without recreating sendMessage.
        if (hasAttachments) {
          activeAttachmentSendFailureRef.current = sendAttachments?.onSendFailed ?? null;
          sendAttachments?.onSending?.();
        }
        const result = await provider.generateReply({
          sessionId,
          message: trimmed,
          weatherLocation,
          styleDnaContext,
          activeContext: activeContextSnapshot,
          genderStylingContext: genderStylingContextRef.current ?? null,
          sourceMessageId: persistedUserMessageId,
          ...(hasAttachments
            ? {
                attachments: sendAttachments!.references,
                contextHint: sendAttachments!.contextHint ?? null,
              }
            : {}),
          // Phase 2B.3: additive and independent of `attachments`. Sent whenever
          // the snapshot carries a canonical identity, including for a reused
          // Scanner/Recent Scan identity that has no new attachment reference.
          ...(sendAttachments?.fashionContext
            ? { fashionContextV2: sendAttachments.fashionContext }
            : {}),
        });
        if (!isCurrentSend()) return;

        // Share this turn's weather with Today with Elise. Recorded BEFORE the
        // status branches below because a reply that hit the daily limit or an
        // operational failure still resolved real weather server-side, and Home
        // has no other way to obtain it — Today cannot call this function itself.
        // Best-effort and never awaited into the send path's critical timing.
        if (actorIdRef.current) {
          void saveTodayWeather(actorIdRef.current, (result as { weatherContext?: unknown }).weatherContext);
        }

        // v2 capability outcomes: preserve the composer draft (text stays in
        // the composer because nothing was persisted) and never show an
        // attachment-blind reply as attachment-aware.
        if (result.status === 'attachments_unsupported' || result.status === 'attachments_rejected') {
          setMessages(prev =>
            prev.filter(m => m.id !== optimisticUser?.id && !m.id.startsWith('optimistic-assistant-')),
          );
          retryStateRef.current?.remember({
            content: trimmed,
            userMessageId: null,
            attachments: sendAttachments,
          });
          setError(
            result.status === 'attachments_rejected'
              ? STYLECHAT_ATTACHMENTS_REJECTED_COPY
              : STYLECHAT_ATTACHMENTS_UNSUPPORTED_COPY,
          );
          return false;
        }
        if (
          result.status === 'visual_collection_unsupported' ||
          result.status === 'visual_collection_rejected'
        ) {
          setMessages(prev =>
            prev.filter(m => m.id !== optimisticUser?.id && !m.id.startsWith('optimistic-assistant-')),
          );
          retryStateRef.current?.remember({
            content: trimmed,
            userMessageId: null,
            attachments: sendAttachments,
          });
          setError(
            result.status === 'visual_collection_rejected'
              ? STYLECHAT_VISUAL_COLLECTION_REJECTED_COPY
              : STYLECHAT_VISUAL_COLLECTION_UNSUPPORTED_COPY,
          );
          return false;
        }

        if (result.status === 'burst_limit') {
          // Burst limit: transient per-minute cap. Do not persist, do not update daily usage.
          if (requiresContextAcknowledgement) {
            setMessages(prev => prev.filter(m => m.id !== optimisticUser?.id));
          }
          setError(STYLE_CHAT_COPY.burstLimitNotice);
          return false;
        }

        if (result.status === 'limit_reached') {
          // Show a system notice in the UI. Do not persist as an assistant message.
          if (requiresContextAcknowledgement) {
            setMessages(prev => prev.filter(m => m.id !== optimisticUser?.id));
          }
          setError(STYLE_CHAT_COPY.systemLimitNotice);
          setMessagesUsed(getSafeCount(result.usage.messagesUsed, messagesUsed));
          setMessagesLimit(getSafeCount(result.usage.messagesLimit, messagesLimit));
          return false;
        }

        const operationalFailure = classifyStyleChatOperationalFailure(result);
        if (operationalFailure) {
          // An operational failure is not an assistant answer. Keep the one
          // persisted text-only user row, preserve the exact send for one-shot
          // retry, and render the existing actionable error banner instead of
          // writing synthetic assistant content or exposing feedback controls.
          if (requiresContextAcknowledgement) {
            setMessages(prev => prev.filter(m => m.id !== optimisticUser?.id));
          }
          retryStateRef.current?.remember({
            content: trimmed,
            userMessageId: persistedUserMessageId,
            attachments: hasAttachments ? sendAttachments : null,
          });
          setError(operationalFailure.message);
          // Update usage if the server returned a count.
          if (result.usage.messagesUsed > 0) {
            setMessagesUsed(getSafeCount(result.usage.messagesUsed, messagesUsed));
            setMessagesLimit(getSafeCount(result.usage.messagesLimit, messagesLimit));
          }
          return false;
        }

        // 4. success — persist the deferred attachment-bearing user message
        //    now that the backend acknowledged the v2 contract. Bounded
        //    attachment summaries persist in the existing ui_blocks column
        //    (stable references + display fields only; never image bytes).
        const trimmedAssistant = result.message.content.trim();
        const hasActions = Array.isArray(result.actions) && result.actions.length > 0;

        // Empty user-facing text + empty actions must not produce a blank bubble.
        // Keep attachments for retry rather than clearing via onSent.
        if (hasAttachments && !trimmedAssistant && !hasActions) {
          setMessages(prev =>
            prev.filter(m => m.id !== optimisticUser?.id && !m.id.startsWith('optimistic-assistant-')),
          );
          retryStateRef.current?.remember({
            content: trimmed,
            userMessageId: null,
            attachments: sendAttachments,
          });
          setError(STYLECHAT_ATTACHMENT_EMPTY_RESPONSE_COPY);
          return false;
        }

        if (requiresContextAcknowledgement) {
          const savedUser = await saveStyleChatMessage({
            sessionId,
            sender: 'user',
            content: trimmed,
            ...(attachmentUiBlocks.length > 0 ? { uiBlocks: attachmentUiBlocks } : {}),
          }, actorId);
          if (!isCurrentSend()) return;
          persistedUserMessageId = savedUser.id;
          setMessages(prev =>
            prev.map(m => (m.id === optimisticUser?.id ? savedUser : m)),
          );
          if (hasAttachments) {
        }
        }

        // optimistic assistant bubble, then persist.
        const assistantContent =
          trimmedAssistant ||
          (hasAttachments && !hasActions
            ? STYLECHAT_ATTACHMENT_EMPTY_RESPONSE_COPY
            : STYLE_CHAT_COPY.errorGeneric);

        // Optional "Why this works" explanation for concrete recommendations. Stored in
        // the existing ui_blocks jsonb column so it persists across reload with no schema
        // change; absent explanations render as a normal message bubble.
        const explanationBlocks: StyleChatUiBlock[] =
          ENABLE_STYLECHAT_EXPLANATIONS && result.message.whyThisWorks
            ? [{ type: 'why_this_works', title: 'Why this works', body: result.message.whyThisWorks }]
            : [];

        // v2 validated structured actions persist alongside the assistant
        // message (app-controlled rendering; never raw JSON in the bubble).
        if (Array.isArray(result.actions) && result.actions.length > 0) {
          explanationBlocks.push({
            type: 'stylechat_actions',
            actions: result.actions,
          } as unknown as StyleChatUiBlock);
        }

        // Build 34 / K+ Wardrobe Concierge V1 (C4, sections 18/41).
        //
        // Travels on the EXISTING ui_blocks jsonb column, exactly as
        // `why_this_works` and `stylechat_actions` already do -- no new table,
        // no new message store, no schema change, which is what section 18
        // requires. It also makes the evidence survive a reload for free.
        //
        // Projected to the renderable model HERE rather than in the view, so
        // the "does anything render at all?" decision is made once, from
        // validated structured data, and the same result feeds both platforms.
        // A payload that projects to 'none' contributes no block, so an answer
        // with no wardrobe evidence keeps a completely unchanged bubble.
        if (ELISE_CONCIERGE_V1) {
          const conciergeResult = buildConciergeResult(result.adviceMetadata ?? null);
          if (conciergeResult.presentation !== 'none') {
            explanationBlocks.push({
              type: 'concierge_evidence',
              result: conciergeResult,
            } as unknown as StyleChatUiBlock);
          }

          // Build 36 / Wardrobe Concierge V2 -- carry the ACTIVE STYLING
          // DECISION forward.
          //
          // Persisted the same way the evidence block above already is: no new
          // table, no new column, no extra request. The server reads it back
          // out of this message's `ui_blocks` on the next turn, which is what
          // makes "swap the shoes" and "keep the trousers" operate on the
          // outfit actually on the table instead of on whatever the model can
          // reconstruct from prose.
          //
          // Stored VERBATIM and never rendered (see StyleChatBubble). The
          // server re-validates every field on the way back in and can only
          // ever use it to remove candidates, so a corrupted or edited block
          // costs a suggestion and can never invent an owned item.
          const outfitState = (result.adviceMetadata as
            | { outfitState?: unknown }
            | null
            | undefined)?.outfitState;
          if (outfitState && typeof outfitState === 'object') {
            explanationBlocks.push({
              type: 'concierge_outfit_state',
              state: outfitState,
            } as unknown as StyleChatUiBlock);
          }
        }

        // Conversation Quality V2 — contradiction check. The reply is checked
        // against the constraints still live for this task ("no heels" four
        // turns ago has left the model's six-message window; it has not left
        // the frame). No regeneration and no second model pass: a violation
        // is SAID, in one line under the reply, so it is never presented as a
        // compliant recommendation. Only real model text is checked.
        const replyViolations: EliseReplyViolation[] | null =
          conversationTurn && trimmedAssistant
            ? validateEliseReply(conversationTurn.frame, trimmedAssistant)
            : null;
        if (replyViolations?.length) {
          explanationBlocks.push(
            ...(buildEliseConversationNotices({ violations: replyViolations }) as unknown as StyleChatUiBlock[]),
          );
        }

        // ── Build 36 activation ───────────────────────────────────────────
        //
        // ORDER IS THE LATENCY DECISION. The optimistic assistant below is
        // pushed with Elise's prose BEFORE Commerce runs, so first text is not
        // gated on a provider round trip. The shelf attaches to the same
        // message when verified results arrive.
        const shoppingWire = parseShoppingIntentWire(
          (result as { shoppingIntent?: unknown }).shoppingIntent,
        );
        // Signature Style rides the same response. The server derived it from
        // the authoritative profile it had already loaded for this request,
        // under the existing K+ entitlement -- nothing is inferred here, and
        // nothing is stored.
        const signatureStyleTokens = (result as { signatureStyleTokens?: unknown })
          .signatureStyleTokens;

        const optimisticAssistant: StyleChatMessage = {
          id: `optimistic-assistant-${Date.now()}`,
          sessionId,
          sender: result.message.sender,
          content: assistantContent,
          referencedScanIds: [],
          referencedSavedItemIds: [],
          referencedDressingRoomIds: [],
          referencedCatalogItems: [],
          uiBlocks: explanationBlocks,
          provider: 'gemini',
          model: result.message.model || undefined,
          tokenEstimate: result.message.tokenEstimate,
          createdAt: new Date().toISOString(),
        };
        setMessages(prev => [...prev, optimisticAssistant]);

        // Conversation Quality V2 — the model PROPOSED shopping; the
        // customer's own words must corroborate it, the same doctrine the
        // server applies to every shopping field. A garment word alone is not
        // a shopping request, and an owned-only task never shops on its own.
        // A held proposal keeps its intent block (so "yes, show me" can resume
        // it) and says, in one line, that nothing was pulled up. Zero provider
        // calls either way.
        const commerceDecision: EliseCommerceDecision | null =
          shoppingWire && conversationTurn ? decideEliseCommerceActivation(conversationTurn) : null;
        if (shoppingWire && commerceDecision?.action === 'hold') {
          explanationBlocks.push(
            buildShoppingIntentBlock(shoppingWire, null),
            ...(buildEliseConversationNotices({ commerceHold: commerceDecision }) as unknown as StyleChatUiBlock[]),
          );
          setMessages(prev =>
            prev.map(m =>
              m.id === optimisticAssistant.id ? { ...m, uiBlocks: [...explanationBlocks] } : m,
            ),
          );
        } else if (shoppingWire) {
          // Commerce runs AFTER first paint and only when this turn actually
          // asked for it. Every failure mode returns a block, never a throw, so
          // a provider outage degrades the shelf and never the conversation.
          // Commerce V2: the verified products this session has actually
          // shown, read off the persisted `commerce_products` blocks already
          // in the loaded message list.
          //
          // NO EXTRA READ, AND NO NEW SCOPE. That list came from
          // `listStyleChatMessages`, which is bound to this session and this
          // user under RLS, so "whose shelf is this?" is inherited from the
          // query that loaded it rather than re-derived here. It is the
          // evidence a reference must match: an ordinal alone cannot produce a
          // card, because the identity it names has to belong to a product
          // that really came back from the Commerce path.
          const priorShelfProducts: Array<Record<string, unknown>> = [];
          // `messages` is already a dependency of this callback, so this is
          // the loaded history as of this send — no new ref, no extra state.
          for (const message of messages) {
            for (const uiBlock of message.uiBlocks ?? []) {
              const typed = uiBlock as unknown as { type?: unknown; products?: unknown };
              if (typed?.type !== 'commerce_products' || !Array.isArray(typed.products)) continue;
              for (const product of typed.products) {
                if (product && typeof product === 'object') {
                  priorShelfProducts.push(product as Record<string, unknown>);
                }
              }
            }
          }

          const activation = await runCommerceActivation({
            wire: shoppingWire,
            actorId,
            priorShelfProducts,
            deps: {
              fetchCommerce: (evidence) => fetchDeferredCommerce(evidence),
              // PREFERENCE, NOT INSTRUCTION. Signature Style carries the
              // smallest weight in the contextual model and the lowest
              // provenance rank, so it breaks ties among otherwise suitable
              // options and can never outrank what the customer just asked
              // for. A turn without it ranks exactly as it did before.
              ...(Array.isArray(signatureStyleTokens) && signatureStyleTokens.length
                ? {
                    loadSignatureStyleTokens: async () =>
                      signatureStyleTokens.filter(
                        (token): token is string => typeof token === 'string' && token.length > 0,
                      ),
                  }
                : {}),
              // Bounded, actor-scoped, same-category selection happens inside
              // `buildActivationEvidence`; this only supplies the raw list.
              loadClosetItems: async () => {
                // The owned-item read is already actor-scoped by RLS through
                // the authenticated client; nothing here re-derives ownership.
                const owned = await listOwnedClosetItems();
                return owned.map((item) => ({
                  title: item.title,
                  category: item.category,
                  color: item.color,
                  material: item.material,
                }));
              },
            },
          });
          if (!isCurrentSend()) return;
          if (activation.blocks.length) {
            explanationBlocks.push(...activation.blocks);
            setMessages(prev =>
              prev.map(m =>
                m.id === optimisticAssistant.id ? { ...m, uiBlocks: [...explanationBlocks] } : m,
              ),
            );
          }
        }

        // 5. Persist assistant message; replace optimistic entry.
        const savedAssistant = await saveStyleChatMessage({
          sessionId,
          sender: 'assistant',
          content: assistantContent,
          uiBlocks: explanationBlocks,
          provider: 'gemini',
          model: result.message.model || undefined,
          tokenEstimate: result.message.tokenEstimate,
          sourceMessageId: persistedUserMessageId,
        }, actorId);
        if (!isCurrentSend()) return;
        setMessages(prev =>
          prev.map(m => (m.id === optimisticAssistant.id ? savedAssistant : m)),
        );
        if (hasAttachments) {
          attachmentSendSucceeded = true;
          activeAttachmentSendFailureRef.current = null;
          sendAttachments?.onSent?.();
        }

        if (canSpeakNewMessages) {
          void speakAvatarMessage({
            actorId,
            sessionId,
            messageId: savedAssistant.id,
            stylistId: identity.avatarId,
            avatarId: identity.avatarId,
            source: 'message',
          });
        }

        // 6. Update displayed daily usage from server response.
        setMessagesUsed(getSafeCount(result.usage.messagesUsed, messagesUsed + 1));
        setMessagesLimit(getSafeCount(result.usage.messagesLimit, messagesLimit));

        if (conversationTurn) {
          recordConversationTurn(conversationTurn, frameMs, 'model_reply', commerceDecision, replyViolations);
        }

        return true;

      } catch (err: unknown) {
        if (!isCurrentSend()) return;
        // Remove optimistic entries on failure so retry is clean.
        setMessages(prev =>
          optimisticUser
            ? prev.filter(m => m.id !== optimisticUser.id && !m.id.startsWith('optimistic-assistant-'))
            : prev.filter(m => !m.id.startsWith('optimistic-assistant-')),
        );
        retryStateRef.current?.remember({
          content: trimmed,
          userMessageId: persistedUserMessageId,
          // Preserve attachments so the error-banner retry resends them.
          attachments: hasAttachments ? sendAttachments : null,
        });
        setError(getFriendlyStyleChatError(err));
        return false;
      } finally {
        if (isCurrentSend()) {
          if (hasAttachments && !attachmentSendSucceeded) {
            sendAttachments?.onSendFailed?.();
          }
          activeAttachmentSendFailureRef.current = null;
          isSendingRef.current = false;
          setIsSending(false);
        }
      }
    },
    [
      actorId,
      session?.id,
      sessionId,
      messagesUsed,
      messagesLimit,
      greetingText,
      messages,
      identity.avatarId,
      canSpeakNewMessages,
    ],
  );

  const retryLastMessage = useCallback(() => {
    const failedSend = retryStateRef.current?.consume() ?? null;
    if (failedSend) {
      void sendMessage(failedSend.content, {
        skipUserPersistence: Boolean(failedSend.userMessageId),
        existingUserMessageId: failedSend.userMessageId,
        attachments: failedSend.attachments,
      });
      return;
    }

    const lastUser = [...messages].reverse().find(m => m.sender === 'user');
    if (lastUser) {
      void sendMessage(lastUser.content);
    }
  }, [messages, sendMessage]);

  const clearError = useCallback(() => setError(null), []);

  return {
    session,
    messages,
    loadingSession,
    loadingMessages,
    isSending,
    error,
    messagesUsed,
    messagesLimit,
    canSend,
    sendMessage,
    retryLastMessage,
    clearError,
  };
}
