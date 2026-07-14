import type { User } from '@supabase/supabase-js';
import { listStyleChatMessages, saveStyleChatMessage } from './styleChatRepository';
import type { StyleChatMessage, StyleChatUiBlock } from './types';
import { buildStylistGreeting } from '../stylistGreeting';
import { resolveUserFirstName } from '../userFirstName';
import type { StylistIdentity } from '../../constants/stylistIdentity';

const GREETING_UI_BLOCK: StyleChatUiBlock = { type: 'greeting' };

const pendingInserts = new Map<string, Promise<StyleChatMessage | null>>();
const greetedSessions = new Set<string>();

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
 * - If a persisted greeting already exists, it is returned and nothing is inserted.
 * - If the session already has other messages but no greeting, this returns null
 *   so pre-existing conversations are not modified.
 * - If the session is empty, a single assistant greeting is persisted.
 * - Concurrent calls for the same session are deduplicated to a single insert.
 */
export async function ensureSessionGreeting(
  sessionId: string,
  greetingText: string,
): Promise<StyleChatMessage | null> {
  let pending = pendingInserts.get(sessionId);
  if (pending) return pending;

  pending = (async () => {
    try {
      const existing = await listStyleChatMessages(sessionId);
      const found = existing.find(isGreetingMessage);
      if (found) return found;

      // Pre-existing conversation without a greeting marker: do not seed retroactively.
      if (existing.length > 0) return null;

      const saved = await saveStyleChatMessage({
        sessionId,
        sender: 'assistant',
        content: greetingText,
        uiBlocks: [GREETING_UI_BLOCK],
        provider: 'greeting',
        tokenEstimate: 0,
      });
      return saved;
    } finally {
      pendingInserts.delete(sessionId);
    }
  })();

  pendingInserts.set(sessionId, pending);
  return pending;
}

/**
 * Mark a session as greeted for the current app process. This prevents speech
 * replay on rerender, remount, or refocus without relying on a persistent flag.
 */
export function markSessionGreeted(sessionId: string): void {
  greetedSessions.add(sessionId);
}

export function isSessionGreeted(sessionId: string): boolean {
  return greetedSessions.has(sessionId);
}

/**
 * Reset in-memory dedupe state. Intended for tests only.
 */
export function resetGreetingDedupeForTests(): void {
  pendingInserts.clear();
  greetedSessions.clear();
}
