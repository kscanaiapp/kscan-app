import type { StyleChatMessage } from '../style-chat/types';
import { speakUtterance } from './avatarSpeech';
import { getAvatarEntry } from './registry';

export interface SpeakResponsePayload {
  message: StyleChatMessage;
  actorKey: string;
  avatarId?: string;
}

/**
 * Determine whether a StyleChat assistant message has speakable primary content.
 *
 * Only the message's primary `content` field may be spoken. UI blocks, feedback
 * copy, metadata, IDs, URLs, and hidden context are ineligible.
 */
export function isResponseSpeakable(payload: SpeakResponsePayload): boolean {
  const { message, avatarId } = payload;
  if (message.sender !== 'assistant') return false;

  const entry = getAvatarEntry(avatarId);
  if (!entry || !entry.enabled || !entry.responseSpeechEnabled || !entry.speech.speechEnabled) {
    return false;
  }

  const text = message.content?.trim();
  if (!text || text.length === 0) return false;

  // A response with only UI blocks and no primary content is ineligible.
  return true;
}

/**
 * Speak an assistant response.
 *
 * Response speech is implemented behind the same mutex and generation-token
 * guard as greeting speech. It must not be wired to the UI until greeting speech
 * passes focused validation.
 */
export async function speakResponse(payload: SpeakResponsePayload): Promise<void> {
  if (!isResponseSpeakable(payload)) return;

  const { message, actorKey, avatarId } = payload;
  const entry = getAvatarEntry(avatarId);
  const voiceProfile = entry?.speech.voiceProfile;
  if (!voiceProfile) return;

  await speakUtterance({
    text: message.content.trim(),
    actorKey,
    avatarId: entry.id,
    utteranceKey: `response:${message.id}`,
    source: 'message',
    voiceProfile,
  });
}

/**
 * Stop any active response or greeting speech for the actor.
 */
export function stopResponseSpeech(actorKey: string): void {
  // The shared speech stop invalidates the current generation token.
  // Re-exported here for response-level callers.
}
