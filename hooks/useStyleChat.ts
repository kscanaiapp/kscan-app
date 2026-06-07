import { useState, useCallback, useEffect } from 'react';
import { MockStyleChatProvider } from '../services/style-chat/MockStyleChatProvider';
import { buildStyleChatContext } from '../services/style-chat/buildStyleChatContext';
import {
  getStyleChatSession,
  listStyleChatMessages,
  saveStyleChatMessage,
  readStyleChatUsage,
  incrementStyleChatUsage,
} from '../services/style-chat/styleChatRepository';
import type { StyleChatMessage, StyleChatSession } from '../services/style-chat/types';
import { STYLE_CHAT_COPY, STYLE_CHAT_MONTHLY_MESSAGE_LIMIT } from '../constants/styleChat';

// Swap MockStyleChatProvider for a real provider without touching this hook.
const provider = new MockStyleChatProvider();

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
  const [messagesLimit] = useState(STYLE_CHAT_MONTHLY_MESSAGE_LIMIT);

  // Load session and messages on mount
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

    async function loadUsage() {
      try {
        const usage = await readStyleChatUsage();
        if (!cancelled) setMessagesUsed(usage.messagesUsed);
      } catch {
        // Non-fatal: fall back to 0; usage limit still enforced server-side via RPC
      }
    }

    void loadSession();
    void loadMessages();
    void loadUsage();

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
        setError(STYLE_CHAT_COPY.errorUsageLimit);
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
        // 2. Persist user message; replace optimistic entry with real row
        const savedUser = await saveStyleChatMessage({
          sessionId,
          sender: 'user',
          content: trimmed,
        });
        setMessages(prev =>
          prev.map(m => (m.id === optimisticUser.id ? savedUser : m)),
        );

        // 3. Generate mock reply
        const result = await provider.generateReply({
          sessionId,
          message: trimmed,
          context: buildStyleChatContext(),
        });

        // 4. Optimistic assistant bubble
        const optimisticAssistant: StyleChatMessage = {
          ...result.message,
          id: `optimistic-assistant-${Date.now()}`,
          sessionId,
        };
        setMessages(prev => [...prev, optimisticAssistant]);

        // 5. Persist assistant message; replace optimistic entry
        const savedAssistant = await saveStyleChatMessage({
          sessionId,
          sender: 'assistant',
          content: result.message.content,
          uiBlocks: result.message.uiBlocks,
          provider: result.message.provider,
          model: result.message.model,
        });
        setMessages(prev =>
          prev.map(m => (m.id === optimisticAssistant.id ? savedAssistant : m)),
        );

        // 6. Atomic server-side usage increment via RPC
        try {
          const usage = await incrementStyleChatUsage();
          setMessagesUsed(usage.messagesUsed);
        } catch {
          // Non-fatal: best-effort local increment as fallback
          setMessagesUsed(prev => prev + 1);
        }
      } catch (err: unknown) {
        // Remove optimistic entries on failure so retry is clean
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
    // Find the last user message that is NOT already persisted (optimistic cleanup),
    // or just re-send the last visible user message
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
