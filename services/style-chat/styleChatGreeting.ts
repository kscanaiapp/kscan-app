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
/** Process-scoped message IDs eligible for one welcome-speech attempt after insert. */
const pendingGreetingSpeech = new Map<string, string>();
/** Claimed message ID per actor/session; records the exact one-shot ownership. */
const greetingSpeechStarted = new Map<string, string>();

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
 * - Same-process calls are deduplicated; the database unique index arbitrates
 *   other devices. A conflict loser reuses the winner without speech eligibility.
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

      try {
        const saved = await saveStyleChatMessage({
          sessionId,
          sender: 'assistant',
          content: greetingText,
          uiBlocks: [GREETING_UI_BLOCK],
          provider: 'greeting',
          tokenEstimate: 0,
        }, actorId);
        return { message: saved, inserted: true };
      } catch (error) {
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== '23505') throw error;
        // Another device may have won after our empty read. Keep the explicit
        // actor/session read boundary and never arm new-greeting speech here.
        const persisted = await listStyleChatMessages(sessionId, actorId);
        const winner = persisted.find((message) => message.sessionId === sessionId && isGreetingMessage(message));
        if (!winner) throw error;
        return { message: winner, inserted: false };
      }
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
 * Remember that this process freshly inserted a greeting so speech can still
 * start after a remount/cancel, once voice eligibility is known.
 */
export function noteInsertedGreetingForSpeech(
  actorId: string,
  sessionId: string,
  messageId: string,
): void {
  if (!actorId || !sessionId || !messageId) return;
  const scopeKey = greetingScopeKey(actorId, sessionId);
  if (greetingSpeechStarted.has(scopeKey)) return;
  pendingGreetingSpeech.set(scopeKey, messageId);
}

/** Pending welcome-speech message ID for this actor/session, if any. */
export function getPendingGreetingSpeechMessageId(
  actorId: string,
  sessionId: string,
): string | null {
  if (!actorId || !sessionId) return null;
  const scopeKey = greetingScopeKey(actorId, sessionId);
  if (greetingSpeechStarted.has(scopeKey)) return null;
  return pendingGreetingSpeech.get(scopeKey) ?? null;
}

/**
 * Claim the single in-process welcome-speech attempt. Returns the message ID
 * when speech should start, or null when already claimed/absent.
 */
export function claimGreetingSpeechAttempt(
  actorId: string,
  sessionId: string,
): string | null {
  const messageId = getPendingGreetingSpeechMessageId(actorId, sessionId);
  if (!messageId) return null;
  const scopeKey = greetingScopeKey(actorId, sessionId);
  greetingSpeechStarted.set(scopeKey, messageId);
  pendingGreetingSpeech.delete(scopeKey);
  return messageId;
}

/**
 * Release only the matching actor/session/message claim on a retriable provider
 * failure. Intentionally DO NOT re-arm pendingGreetingSpeech: doing so would
 * automatically replay an old welcome when a session remounts. The persisted
 * greeting remains user-retryable via its existing per-message voice control.
 */
export function releaseGreetingSpeechAttempt(
  actorId: string,
  sessionId: string,
  messageId: string,
): boolean {
  if (!actorId || !sessionId || !messageId) return false;
  const scopeKey = greetingScopeKey(actorId, sessionId);
  if (greetingSpeechStarted.get(scopeKey) !== messageId) return false;
  greetingSpeechStarted.delete(scopeKey);
  return true;
}

/** Clear actor-scoped greeting work and playback dedupe at an auth boundary. */
export function resetStyleChatGreetingState(): void {
  pendingInserts.clear();
  greetedSessions.clear();
  pendingGreetingSpeech.clear();
  greetingSpeechStarted.clear();
}

export const resetGreetingDedupeForTests = resetStyleChatGreetingState;
