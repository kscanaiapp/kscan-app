// Message-state predicates shared by the Elise send path and the transcript.
//
// The optimistic-id convention ("optimistic-user-…", "optimistic-assistant-…")
// is minted in hooks/useStyleChat.ts and read in the bubble. Keeping the
// predicates here means there is ONE definition of "the server has not
// acknowledged this yet" rather than a copy in each place that cares — and it
// makes the rule assertable without mounting a renderer.

import type { StyleChatMessage } from './types';

export const OPTIMISTIC_ID_PREFIX = 'optimistic-';

/** True for an id minted by the server, false for an in-flight local one. */
export function isStablePersistedId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !id.startsWith(OPTIMISTIC_ID_PREFIX);
}

/**
 * A user bubble that is on screen but not yet acknowledged by the server.
 *
 * Load-bearing rather than cosmetic: an optimistic bubble is visually identical
 * to an accepted one, so without this the user cannot tell a delivered message
 * from one still in flight. A failed send removes the bubble entirely and
 * restores the text to the composer, so this state is always transient.
 */
export function isPendingUserMessage(message: Pick<StyleChatMessage, 'id' | 'sender'>): boolean {
  return message.sender === 'user' && !isStablePersistedId(message.id);
}
