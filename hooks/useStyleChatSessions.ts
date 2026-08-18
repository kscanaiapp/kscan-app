import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { StyleChatSession, StyleChatMode } from '../services/style-chat/types';
import {
  createStyleChatSession,
  deleteStyleChatSession,
  getLatestStyleChatSession,
  listStyleChatSessions,
} from '../services/style-chat/styleChatRepository';
import { getFriendlyStyleChatError } from '../services/style-chat/styleChatErrors';

// Mirrors useDressingRooms from hooks/useStyleObjects.ts
export function useStyleChatSessions() {
  const [sessions, setSessions] = useState<StyleChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await listStyleChatSessions());
    } catch (err: unknown) {
      setError(getFriendlyStyleChatError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useFocusEffect(
    useCallback(() => {
      void reload();
    }, [reload]),
  );

  const createSession = useCallback(
    async (options?: { title?: string; mode?: StyleChatMode }): Promise<StyleChatSession> => {
      const session = await createStyleChatSession(options ?? {});
      setSessions(prev => [session, ...prev]);
      return session;
    },
    [],
  );

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    await deleteStyleChatSession(sessionId);
    setSessions(prev => prev.filter(s => s.id !== sessionId));
  }, []);

  // Read through to the server rather than `sessions[0]`: the list is populated
  // by a focus effect, so a tap that lands before it resolves would read an
  // empty list and create a duplicate of the conversation being resumed.
  const getLatestSessionId = useCallback(async (): Promise<string | null> => {
    const latest = await getLatestStyleChatSession();
    return latest?.id ?? null;
  }, []);

  return { sessions, loading, error, reload, createSession, deleteSession, getLatestSessionId };
}
