import { useState, useCallback, useRef } from 'react';
import { MockStyleChatProvider } from '../services/style-chat/MockStyleChatProvider';
import { buildStyleChatContext } from '../services/style-chat/buildStyleChatContext';
import type { StyleChatMessage, StyleChatSession, StyleChatMode } from '../services/style-chat/types';
import { useStyleChatUsage } from './useStyleChatUsage';
import { STYLE_CHAT_COPY } from '../constants/styleChat';

// Swap MockStyleChatProvider for a real provider without touching this hook.
const provider = new MockStyleChatProvider();

function makeLocalSession(mode: StyleChatMode = 'general'): StyleChatSession {
  return {
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title: 'New Styling Session',
    mode,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export function useStyleChat(initialSession?: StyleChatSession) {
  const [session, setSession] = useState<StyleChatSession | null>(
    initialSession ?? null,
  );
  const [messages, setMessages] = useState<StyleChatMessage[]>([]);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const usage = useStyleChatUsage();

  // Held across renders so we don't stale-close over session state.
  const sessionRef = useRef(session);
  sessionRef.current = session;

  const createSession = useCallback((mode: StyleChatMode = 'general') => {
    const s = makeLocalSession(mode);
    setSession(s);
    setMessages([]);
    setError(null);
    return s;
  }, []);

  const sendMessage = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) return;

      if (!usage.canSend) {
        setError(STYLE_CHAT_COPY.errorUsageLimit);
        return;
      }

      let activeSession = sessionRef.current;
      if (!activeSession) {
        activeSession = makeLocalSession();
        setSession(activeSession);
        sessionRef.current = activeSession;
      }

      const userMsg: StyleChatMessage = {
        id: `user-${Date.now()}`,
        sessionId: activeSession.id,
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

      setMessages(prev => [...prev, userMsg]);
      setIsSending(true);
      setError(null);

      try {
        const result = await provider.generateReply({
          sessionId: activeSession.id,
          message: trimmed,
          context: buildStyleChatContext(),
        });

        const assistantMsg: StyleChatMessage = {
          ...result.message,
          sessionId: activeSession.id,
        };

        setMessages(prev => [...prev, assistantMsg]);
        usage.incrementUsage();
      } catch {
        setError(STYLE_CHAT_COPY.errorGeneric);
      } finally {
        setIsSending(false);
      }
    },
    [usage],
  );

  const retryLastMessage = useCallback(() => {
    const lastUser = [...messages].reverse().find(m => m.sender === 'user');
    if (lastUser) {
      setMessages(prev => prev.filter(m => m.id !== lastUser.id));
      sendMessage(lastUser.content);
    }
  }, [messages, sendMessage]);

  const clearError = useCallback(() => setError(null), []);

  return {
    session,
    messages,
    isSending,
    error,
    usage,
    createSession,
    sendMessage,
    retryLastMessage,
    clearError,
  };
}
