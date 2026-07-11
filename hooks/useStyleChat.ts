import { useState, useCallback, useEffect, useRef } from 'react';
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

export const STYLECHAT_ATTACHMENTS_UNSUPPORTED_COPY =
  "Closet-aware messaging isn't available yet. Your attachments are still here.";
export const STYLECHAT_ATTACHMENTS_REJECTED_COPY =
  "Elise couldn't verify that Closet item. Remove it and try again.";

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
    },
  ) => Promise<void>;
  retryLastMessage: () => void;
  clearError: () => void;
}

type FailedSendState = {
  content: string;
  userMessageId: string | null;
};

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
  const failedSendRef = useRef<FailedSendState | null>(null);
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

  useEffect(() => {
    failedSendRef.current = null;
  }, [sessionId]);

  // Load session, messages, and today's daily usage on mount.
  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      setLoadingSession(true);
      try {
        const s = await getStyleChatSession(sessionId);
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
        const msgs = await listStyleChatMessages(sessionId);
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
  }, [sessionId]);

  const canSend = Boolean(sessionId) && messagesUsed < messagesLimit && !isSending;

  const sendMessage = useCallback(
    async (
      text: string,
      options?: {
        skipUserPersistence?: boolean;
        existingUserMessageId?: string | null;
        /** v2 (Closet Intelligence): ready resolved attachments for this send. */
        attachments?: SendAttachmentsInput | null;
      },
    ) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (!sessionId) {
        setError(STYLE_CHAT_COPY.errorGeneric);
        return;
      }
      if (isSendingRef.current) return;
      if (messagesUsed >= messagesLimit) {
        setError(STYLE_CHAT_COPY.systemLimitNotice);
        return;
      }
      isSendingRef.current = true;
      failedSendRef.current = null;

      // Attachment-bearing sends defer user-message persistence until the
      // backend acknowledges the v2 contract: an unsupported/rejected outcome
      // must leave the composer draft (text + attachments) fully intact and
      // must never present an attachment-blind reply as attachment-aware.
      const sendAttachments = options?.attachments ?? null;
      const hasAttachments = !!sendAttachments && sendAttachments.references.length > 0;
      const attachmentUiBlocks: StyleChatUiBlock[] = hasAttachments
        ? [buildAttachmentUiBlock(sendAttachments.drafts) as unknown as StyleChatUiBlock]
        : [];

      const skipUserPersistence = options?.skipUserPersistence === true;
      // Attachment sends defer persistence until backend v2 acknowledgement,
      // but still render an optimistic bubble.
      const deferUserPersistence = skipUserPersistence || hasAttachments;
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
      setIsSending(true);
      setError(null);

      try {
        // 2. Persist user message; replace optimistic entry with real row.
        //    (Attachment sends persist AFTER the backend acknowledges v2.)
        if (!deferUserPersistence) {
          const savedUser = await saveStyleChatMessage({
            sessionId,
            sender: 'user',
            content: trimmed,
          });
          persistedUserMessageId = savedUser.id;
          setMessages(prev =>
            prev.map(m => (m.id === optimisticUser?.id ? savedUser : m)),
          );
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
        // Active scan/upload/TextScan context is held in a ref so it is included on
        // every send while the context card is visible, without recreating sendMessage.
        const activeContext = activeContextRef.current ?? null;
        const result = await provider.generateReply({
          sessionId,
          message: trimmed,
          weatherLocation,
          styleDnaContext,
          activeContext,
          ...(hasAttachments
            ? {
                attachments: sendAttachments!.references,
                contextHint: sendAttachments!.contextHint ?? null,
              }
            : {}),
        });

        // v2 capability outcomes: preserve the composer draft (text stays in
        // the composer because nothing was persisted) and never show an
        // attachment-blind reply as attachment-aware.
        if (result.status === 'attachments_unsupported' || result.status === 'attachments_rejected') {
          setMessages(prev =>
            prev.filter(m => m.id !== optimisticUser?.id && !m.id.startsWith('optimistic-assistant-')),
          );
          setError(
            result.status === 'attachments_rejected'
              ? STYLECHAT_ATTACHMENTS_REJECTED_COPY
              : STYLECHAT_ATTACHMENTS_UNSUPPORTED_COPY,
          );
          return;
        }

        if (result.status === 'burst_limit') {
          // Burst limit: transient per-minute cap. Do not persist, do not update daily usage.
          setError(STYLE_CHAT_COPY.burstLimitNotice);
          return;
        }

        if (result.status === 'limit_reached') {
          // Show a system notice in the UI. Do not persist as an assistant message.
          setError(STYLE_CHAT_COPY.systemLimitNotice);
          setMessagesUsed(getSafeCount(result.usage.messagesUsed, messagesUsed));
          setMessagesLimit(getSafeCount(result.usage.messagesLimit, messagesLimit));
          return;
        }

        if (result.status === 'error') {
          // Persist a safe fallback assistant row so the conversation remains coherent
          // on reload, then surface the content to the user.
          const fallbackMsg = await saveStyleChatMessage({
            sessionId,
            sender: 'assistant',
            content: result.message.content.trim() || STYLE_CHAT_COPY.errorGeneric,
            provider: result.message.model || 'fallback',
            model: result.message.model || undefined,
          });
          setMessages(prev => [...prev, fallbackMsg]);
          // Update usage if the server returned a count.
          if (result.usage.messagesUsed > 0) {
            setMessagesUsed(getSafeCount(result.usage.messagesUsed, messagesUsed));
            setMessagesLimit(getSafeCount(result.usage.messagesLimit, messagesLimit));
          }
          return;
        }

        // 4. success — persist the deferred attachment-bearing user message
        //    now that the backend acknowledged the v2 contract. Bounded
        //    attachment summaries persist in the existing ui_blocks column
        //    (stable references + display fields only; never image bytes).
        if (hasAttachments) {
          const savedUser = await saveStyleChatMessage({
            sessionId,
            sender: 'user',
            content: trimmed,
            uiBlocks: attachmentUiBlocks,
          });
          persistedUserMessageId = savedUser.id;
          setMessages(prev =>
            prev.map(m => (m.id === optimisticUser?.id ? savedUser : m)),
          );
          sendAttachments?.onSent?.();
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
        });
        setMessages(prev =>
          prev.map(m => (m.id === optimisticAssistant.id ? savedAssistant : m)),
        );

        // 6. Update displayed daily usage from server response.
        setMessagesUsed(getSafeCount(result.usage.messagesUsed, messagesUsed + 1));
        setMessagesLimit(getSafeCount(result.usage.messagesLimit, messagesLimit));

      } catch (err: unknown) {
        // Remove optimistic entries on failure so retry is clean.
        setMessages(prev =>
          optimisticUser
            ? prev.filter(m => m.id !== optimisticUser.id && !m.id.startsWith('optimistic-assistant-'))
            : prev.filter(m => !m.id.startsWith('optimistic-assistant-')),
        );
        failedSendRef.current = {
          content: trimmed,
          userMessageId: persistedUserMessageId,
        };
        setError(getFriendlyStyleChatError(err));
      } finally {
        isSendingRef.current = false;
        setIsSending(false);
      }
    },
    [sessionId, messagesUsed, messagesLimit],
  );

  const retryLastMessage = useCallback(() => {
    const failedSend = failedSendRef.current;
    if (failedSend) {
      failedSendRef.current = null;
      void sendMessage(failedSend.content, {
        skipUserPersistence: Boolean(failedSend.userMessageId),
        existingUserMessageId: failedSend.userMessageId,
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
