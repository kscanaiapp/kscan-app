import type { User } from '@supabase/supabase-js';
import { listStyleChatMessages, saveStyleChatMessage } from './styleChatRepository';
import type { StyleChatMessage, StyleChatUiBlock } from './types';
import { buildStylistGreeting } from '../stylistGreeting';
import { resolveUserFirstName } from '../userFirstName';
import type { StylistIdentity } from '../../constants/stylistIdentity';

const GREETING_UI_BLOCK: StyleChatUiBlock = { type: 'greeting' };

export const SESSION_GREETING_SEND_WAIT_MS = 2_500;

export interface SessionGreetingResult {
  message: StyleChatMessage | null;
  inserted: boolean;
}

const pendingInserts = new Map<string, Promise<SessionGreetingResult>>();
const greetedSessions = new Set<string>();

function greetingScopeKey(actorId: string, sessionId: string): string {
  return `${actorId}:${sessionId}`;
}

export function isGreetingMessage(message: StyleChatMessage): boolean {
  return (
    message.sender === 'assistant' &&
    Array.isArray(message.uiBlocks) &&
    message.uiBlocks.some((block) => block?.type === 'greeting')
  );
}

/**
 * Build the canonical stylist greeting text from the current identity and user.
 */
export function getGreetingTextForUser(
  user: User | null | undefined,
  identity: StylistIdentity,
): string {
  const firstName = resolveUserFirstName(user).firstName;
  return buildStylistGreeting({
    userFirstName: firstName,
    stylistName: identity.displayName,
  }).text;
}

/**
 * Ensure a session has exactly one greeting message.
 *
 * - If a persisted greeting already exists, it is returned with inserted=false.
 * - If the session already has other messages but no greeting, message is null
 *   so pre-existing conversations are not modified.
 * - If the session is empty, a single assistant greeting is persisted.
 * - Concurrent calls for the same session are deduplicated to a single insert.
 */
export async function ensureSessionGreeting(
  actorId: string,
  sessionId: string,
  greetingText: string,
): Promise<SessionGreetingResult> {
  if (!actorId || !sessionId) {
    throw new Error('A valid actor and session are required for the greeting.');
  }

  const scopeKey = greetingScopeKey(actorId, sessionId);
  let pending = pendingInserts.get(scopeKey);
  if (pending) return pending;

  pending = (async () => {
    try {
      const existing = await listStyleChatMessages(sessionId, actorId);
      const found = existing.find(isGreetingMessage);
      if (found) return { message: found, inserted: false };

      // Pre-existing conversation without a greeting marker: do not seed retroactively.
      if (existing.length > 0) return { message: null, inserted: false };

      const saved = await saveStyleChatMessage({
        sessionId,
        sender: 'assistant',
        content: greetingText,
        uiBlocks: [GREETING_UI_BLOCK],
        provider: 'greeting',
        tokenEstimate: 0,
      }, actorId);
      return { message: saved, inserted: true };
    } finally {
      pendingInserts.delete(scopeKey);
    }
  })();

  pendingInserts.set(scopeKey, pending);
  return pending;
}

/**
 * Bound how long a user send waits for greeting persistence. The underlying
 * transaction remains deduplicated and may still settle, but the composer is
 * never deadlocked by a slow network request.
 */
export async function waitForSessionGreeting(
  greetingPromise: Promise<SessionGreetingResult>,
  timeoutMs = SESSION_GREETING_SEND_WAIT_MS,
): Promise<SessionGreetingResult | null> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      greetingPromise,
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), Math.max(0, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

/**
 * Mark a session as greeted for the current app process. This prevents speech
 * replay on rerender, remount, or refocus without relying on a persistent flag.
 */
export function markSessionGreeted(actorId: string, sessionId: string): void {
  greetedSessions.add(greetingScopeKey(actorId, sessionId));
}

export function isSessionGreeted(actorId: string, sessionId: string): boolean {
  return greetedSessions.has(greetingScopeKey(actorId, sessionId));
}

/**
 * Reset in-memory dedupe state. Intended for tests only.
 */
export function resetGreetingDedupeForTests(): void {
  pendingInserts.clear();
  greetedSessions.clear();
}
