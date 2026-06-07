import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { StyleChatSession, StyleChatMode } from '../services/style-chat/types';
import {
  createStyleChatSession,
  listStyleChatSessions,
} from '../services/style-chat/styleChatRepository';

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
      setError((err as Error)?.message || 'Unable to load StyleChat sessions.');
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

  return { sessions, loading, error, reload, createSession };
}
