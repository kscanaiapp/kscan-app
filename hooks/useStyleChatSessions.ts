import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import type { StyleChatSession, StyleChatMode } from '../services/style-chat/types';
import {
  createStyleChatSession,
  deleteStyleChatSession,
  getLatestNonEmptySessionId,
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
  //
  // Prefer the latest session that actually has a message over the latest
  // owned row: a user who repeatedly hit the old always-create entry point
  // may own several newer empty stubs sitting in front of their real
  // conversation, and resuming "latest row" would resurface one of those
  // instead. Only when no owned session has ever received a message — new
  // account, or every session is genuinely empty — does resume fall back to
  // the latest owned row, which is the prior (Phase 1) behavior.
  const getLatestSessionId = useCallback(async (): Promise<string | null> => {
    const nonEmptySessionId = await getLatestNonEmptySessionId();
    if (nonEmptySessionId) return nonEmptySessionId;
    const latest = await getLatestStyleChatSession();
    return latest?.id ?? null;
  }, []);

  return { sessions, loading, error, reload, createSession, deleteSession, getLatestSessionId };
}
