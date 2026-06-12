import { useState, useCallback, useEffect } from 'react';
import { EdgeStyleChatProvider } from '../services/style-chat/providers/edgeStyleChatProvider';
import {
  getStyleChatSession,
  listStyleChatMessages,
  saveStyleChatMessage,
  readStyleChatDailyUsage,
} from '../services/style-chat/styleChatRepository';
import type { StyleChatMessage, StyleChatSession } from '../services/style-chat/types';
import { STYLE_CHAT_COPY, STYLE_CHAT_DAILY_MESSAGE_LIMIT } from '../constants/styleChat';

// v0.4: swap to EdgeStyleChatProvider without touching this hook's external API.
// MockStyleChatProvider remains available in edgeStyleChatProvider's fallback chain.
const provider = new EdgeStyleChatProvider();

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
  sendMessage: (text: string) => Promise<void>;
  retryLastMessage: () => void;
  clearError: () => void;
}

export function useStyleChat(sessionId: string): UseStyleChatReturn {
  const [session, setSession] = useState<StyleChatSession | null>(null);
  const [messages, setMessages] = useState<StyleChatMessage[]>([]);
  const [loadingSession, setLoadingSession] = useState(true);
  const [loadingMessages, setLoadingMessages] = useState(true);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [messagesUsed, setMessagesUsed] = useState(0);
  const [messagesLimit] = useState(STYLE_CHAT_DAILY_MESSAGE_LIMIT);

  // Load session, messages, and today's daily usage on mount.
  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      setLoadingSession(true);
      try {
        const s = await getStyleChatSession(sessionId);
        if (!cancelled) setSession(s);
      } catch (err: unknown) {
        if (!cancelled) setError((err as Error)?.message || 'Unable to load session.');
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
        if (!cancelled) setError((err as Error)?.message || 'Unable to load messages.');
      } finally {
        if (!cancelled) setLoadingMessages(false);
      }
    }

    async function loadDailyUsage() {
      try {
        const usage = await readStyleChatDailyUsage();
        if (!cancelled) setMessagesUsed(usage.messagesUsed);
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

  const canSend = messagesUsed < messagesLimit && !isSending;

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (messagesUsed >= messagesLimit) {
        setError(STYLE_CHAT_COPY.systemLimitNotice);
        return;
      }

      // 1. Optimistic user bubble
      const optimisticUser: StyleChatMessage = {
        id: `optimistic-user-${Date.now()}`,
        sessionId,
        sender: 'user',
        content: trimmed,
        referencedScanIds: [],
        referencedSavedItemIds: [],
        referencedDressingRoomIds: [],
        referencedCatalogItems: [],
        uiBlocks: [],
        provider: 'client',
        tokenEstimate: 0,
        createdAt: new Date().toISOString(),
      };

      setMessages(prev => [...prev, optimisticUser]);
      setIsSending(true);
      setError(null);

      try {
        // 2. Persist user message; replace optimistic entry with real row.
        const savedUser = await saveStyleChatMessage({
          sessionId,
          sender: 'user',
          content: trimmed,
        });
        setMessages(prev =>
          prev.map(m => (m.id === optimisticUser.id ? savedUser : m)),
        );

        // 3. Call the secure Edge Function proxy. Server enforces quota, assembles
        //    context, calls Gemini, and returns a typed result.
        const result = await provider.generateReply({ sessionId, message: trimmed });

        if (result.status === 'burst_limit') {
          // Burst limit: transient per-minute cap. Do not persist, do not update daily usage.
          setError(STYLE_CHAT_COPY.burstLimitNotice);
          return;
        }

        if (result.status === 'limit_reached') {
          // Show a system notice in the UI. Do not persist as an assistant message.
          setError(STYLE_CHAT_COPY.systemLimitNotice);
          setMessagesUsed(result.usage.messagesUsed);
          return;
        }

        if (result.status === 'error') {
          // Persist a safe fallback assistant row so the conversation remains coherent
          // on reload, then surface the content to the user.
          const fallbackMsg = await saveStyleChatMessage({
            sessionId,
            sender: 'assistant',
            content: result.message.content,
            provider: result.message.model || 'fallback',
            model: result.message.model || undefined,
          });
          setMessages(prev => [...prev, fallbackMsg]);
          // Update usage if the server returned a count.
          if (result.usage.messagesUsed > 0) setMessagesUsed(result.usage.messagesUsed);
          return;
        }

        // 4. success — optimistic assistant bubble, then persist.
        const optimisticAssistant: StyleChatMessage = {
          id: `optimistic-assistant-${Date.now()}`,
          sessionId,
          sender: result.message.sender,
          content: result.message.content,
          referencedScanIds: [],
          referencedSavedItemIds: [],
          referencedDressingRoomIds: [],
          referencedCatalogItems: [],
          uiBlocks: [],
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
          content: result.message.content,
          provider: 'gemini',
          model: result.message.model || undefined,
        });
        setMessages(prev =>
          prev.map(m => (m.id === optimisticAssistant.id ? savedAssistant : m)),
        );

        // 6. Update displayed daily usage from server response.
        setMessagesUsed(result.usage.messagesUsed);

      } catch (err: unknown) {
        // Remove optimistic entries on failure so retry is clean.
        setMessages(prev =>
          prev.filter(m => !m.id.startsWith('optimistic-')),
        );
        setError((err as Error)?.message || STYLE_CHAT_COPY.errorGeneric);
      } finally {
        setIsSending(false);
      }
    },
    [sessionId, messagesUsed, messagesLimit],
  );

  const retryLastMessage = useCallback(() => {
    const lastUser = [...messages].reverse().find(m => m.sender === 'user');
    if (lastUser) {
      setMessages(prev => prev.filter(m => m.id !== lastUser.id));
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
