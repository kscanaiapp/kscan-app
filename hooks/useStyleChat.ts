import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { EdgeStyleChatProvider } from '../services/style-chat/providers/edgeStyleChatProvider';
import {
  getStyleChatSession,
  listStyleChatMessages,
  saveStyleChatMessage,
  readStyleChatDailyUsage,
} from '../services/style-chat/styleChatRepository';
import { getFriendlyStyleChatError } from '../services/style-chat/styleChatErrors';
import type { StyleChatMessage, StyleChatSession, StyleChatUiBlock } from '../services/style-chat/types';
import type { WeatherLocationInput } from '../constants/weatherStyling';
import type { StyleDnaContext } from '../services/style-dna/styleDnaContext';
import type { StyleChatHandoffContext } from '../services/style-chat/styleChatHandoffContext';
import { STYLE_CHAT_COPY, STYLE_CHAT_DAILY_MESSAGE_LIMIT } from '../constants/styleChat';
import {
  buildAttachmentUiBlock,
  type DraftAttachment,
  type StyleChatAttachment,
} from '../types/styleChatAttachments';
import { createStyleChatRetryState } from '../services/style-chat/styleChatRetryState';
import { classifyStyleChatOperationalFailure } from '../services/style-chat/styleChatOutcome';
import { useAuthSession } from '../contexts/AuthSessionContext';
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
  "Elise couldn't verify that Closet item. Remove it and try again.";
export const STYLECHAT_VISUAL_COLLECTION_UNSUPPORTED_COPY =
  "Multi-reference styling isn't available yet. Your references and draft are still here.";
export const STYLECHAT_VISUAL_COLLECTION_REJECTED_COPY =
  "Elise couldn't safely read those references. Your references and draft are still here.";

export type SendAttachmentsInput = {
  /** Immutable snapshot captured at send time (ready resolved refs only). */
  references: StyleChatAttachment[];
  drafts: DraftAttachment[];
  contextHint?: string | null;
  /** Called only after a successful attachment-aware send. */
  onSent?: () => void;
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
}

export function useStyleChat(sessionId: string, opts?: UseStyleChatOptions): UseStyleChatReturn {
  const [session, setSession] = useState<StyleChatSession | null>(null);
  const [messages, setMessages] = useState<StyleChatMessage[]>([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const isSendingRef = useRef(false);
  const sendScopeVersionRef = useRef(0);
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
  const [error, setError] = useState<string | null>(null);
  const [messagesUsed, setMessagesUsed] = useState(0);
  const [messagesLimit, setMessagesLimit] = useState(STYLE_CHAT_DAILY_MESSAGE_LIMIT);

  // Identity and greeting state for the automatic session entry greeting.
  const { user } = useAuthSession();
  const { identity, isLoading: identityLoading } = useStylistIdentity();
  const actorId = user?.id ?? null;
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

    async function insertGreeting() {
      try {
        if (messages.length === 0 && !isSessionGreeted(actorId!, sessionId)) {
          const result = await ensureSessionGreeting(actorId!, sessionId, greetingText);
          // Retain one speech attempt across cancel/remount only when voice was
          // already eligible at insert. Voice-off welcomes must not speak later
          // merely because the preference was enabled afterward.
          if (result.inserted && result.message && canSpeakNewMessages) {
            noteInsertedGreetingForSpeech(actorId!, sessionId, result.message.id);
          }
          if (cancelled) return;

          markSessionGreeted(actorId!, sessionId);

          if (result.message) {
            setMessages((prev) =>
              prev.some((m) => m.id === result.message!.id)
                ? prev
                : [...prev, result.message!],
            );
          }
        } else if (!isSessionGreeted(actorId!, sessionId)) {
          markSessionGreeted(actorId!, sessionId);
        }

        if (cancelled) return;
        if (!canSpeakNewMessages) return;

        const speechMessageId = claimGreetingSpeechAttempt(actorId!, sessionId);
        if (!speechMessageId) return;

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
      const isCurrentSend = () => sendScopeVersionRef.current === sendScopeVersion;

      // For the very first message in a new session, make sure the assistant
      // greeting is persisted before the user message when the transaction
      // settles within the bounded wait. A slow greeting can never deadlock or
      // discard the user's message.
      if (messages.length === 0) {
        try {
          const greetingResult = await waitForSessionGreeting(
            ensureSessionGreeting(actorId, sessionId, greetingText),
          );
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
      const hasAttachments = !!sendAttachments && sendAttachments.references.length > 0;
      const activeContextSnapshot = activeContextRef.current ?? null;
      const hasVisualCollection = Boolean(
        activeContextSnapshot?.visualCollection?.evidence?.length,
      );
      const requiresContextAcknowledgement = hasAttachments || hasVisualCollection;
      const attachmentUiBlocks: StyleChatUiBlock[] = hasAttachments
        ? [buildAttachmentUiBlock(sendAttachments.drafts) as unknown as StyleChatUiBlock]
        : [];

      const skipUserPersistence = options?.skipUserPersistence === true;
      // Attachment sends defer persistence until backend v2 acknowledgement,
      // but still render an optimistic bubble.
      const deferUserPersistence = skipUserPersistence || requiresContextAcknowledgement;
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
        const result = await provider.generateReply({
          sessionId,
          message: trimmed,
          weatherLocation,
          styleDnaContext,
          activeContext: activeContextSnapshot,
          sourceMessageId: persistedUserMessageId,
          ...(hasAttachments
            ? {
                attachments: sendAttachments!.references,
                contextHint: sendAttachments!.contextHint ?? null,
              }
            : {}),
        });
        if (!isCurrentSend()) return;

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
          if (hasAttachments) sendAttachments?.onSent?.();
        }

        // optimistic assistant bubble, then persist.
        const assistantContent = result.message.content.trim() || STYLE_CHAT_COPY.errorGeneric;

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
