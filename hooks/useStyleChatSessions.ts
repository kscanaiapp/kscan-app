import { useCallback, useEffect, useRef, useState } from 'react';
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
import { useAuthSession } from '../contexts/AuthSessionContext';
import { captureActorScope, currentActorScopeKey, isActorScopeCurrent } from '../services/actorScope';

// Mirrors useDressingRooms from hooks/useStyleObjects.ts
export function useStyleChatSessions() {
  const { isAuthenticated } = useAuthSession();
  const scopeKey = currentActorScopeKey();
  const [snapshot, setSnapshot] = useState<{ scopeKey: string; sessions: StyleChatSession[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; generationRef.current += 1; };
  }, []);
  useEffect(() => { setError(null); setLoading(isAuthenticated); }, [scopeKey, isAuthenticated]);

  const reload = useCallback(async () => {
    if (!mountedRef.current || scopeKey !== currentActorScopeKey()) return;
    const scope = captureActorScope();
    const generation = ++generationRef.current;
    const isCurrent = () => mountedRef.current && generationRef.current === generation && isActorScopeCurrent(scope);
    if (!isAuthenticated) {
      setSnapshot(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const sessions = await listStyleChatSessions();
      if (isCurrent()) setSnapshot({ scopeKey, sessions });
    } catch (err: unknown) {
      if (isCurrent()) setError(getFriendlyStyleChatError(err));
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [isAuthenticated, scopeKey]);

  useFocusEffect(
    useCallback(() => {
      void reload();
      return () => { generationRef.current += 1; };
    }, [reload]),
  );

  const createSession = useCallback(
    async (options?: { title?: string; mode?: StyleChatMode }): Promise<StyleChatSession> => {
      if (!mountedRef.current || scopeKey !== currentActorScopeKey()) throw new Error('Account changed while starting the conversation.');
      const scope = captureActorScope();
      const session = await createStyleChatSession(options ?? {});
      if (!mountedRef.current || !isActorScopeCurrent(scope)) throw new Error('Account changed while starting the conversation.');
      setSnapshot(prev => ({ scopeKey, sessions: [session, ...(prev?.scopeKey === scopeKey ? prev.sessions : [])] }));
      return session;
    },
    [scopeKey],
  );

  const deleteSession = useCallback(async (sessionId: string): Promise<void> => {
    if (!mountedRef.current || scopeKey !== currentActorScopeKey()) return;
    const scope = captureActorScope();
    await deleteStyleChatSession(sessionId);
    if (!mountedRef.current || !isActorScopeCurrent(scope)) return;
    setSnapshot(prev => prev?.scopeKey === scopeKey ? { scopeKey, sessions: prev.sessions.filter(s => s.id !== sessionId) } : prev);
  }, [scopeKey]);

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
    const scope = captureActorScope();
    const nonEmptySessionId = await getLatestNonEmptySessionId();
    if (!isActorScopeCurrent(scope)) throw new Error('Account changed while loading the conversation.');
    if (nonEmptySessionId) return nonEmptySessionId;
    const latest = await getLatestStyleChatSession();
    if (!isActorScopeCurrent(scope)) throw new Error('Account changed while loading the conversation.');
    return latest?.id ?? null;
  }, []);

  const sessions = snapshot?.scopeKey === scopeKey ? snapshot.sessions : [];
  return { sessions, loading, error, reload, createSession, deleteSession, getLatestSessionId };
}
