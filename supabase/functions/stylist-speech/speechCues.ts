import { StylistSpeechError } from './types.ts';

/**
 * Allowlisted deterministic speech cues.
 *
 * Build 29 gives Elise six fixed things to say at confirmed state transitions.
 * Four of them happen inside StyleChat, where a persisted assistant message
 * exists and the message path already works. Two of them — the Dressing Room
 * becoming ready, and the user asking to change something — happen on a surface
 * that has no StyleChat session and no message to speak from. Cue mode exists for
 * those, and the same mode serves the other four so all six behave identically.
 *
 * ─── WHY THE SERVER OWNS THE WORDS ──────────────────────────────────────────
 *
 * The request carries a cue KEY, never cue text. This is the whole security
 * design: in message mode the client sends `messageId` and the function reads the
 * text out of a row the caller provably owns, so a client can never put arbitrary
 * text into text-to-speech. Accepting a `text` field in cue mode would hand that
 * exact capability back — an authenticated user could bill the ElevenLabs account
 * for anything they liked, and Elise would say it. So the copy lives here, the
 * request names one of six keys, and an unrecognized key is rejected rather than
 * spoken.
 *
 * The lines are restated here rather than imported from the client module for the
 * same reason `MAX_SPEECH_CHARACTERS` is restated: the Edge Function deploys
 * separately from the app, so a shared import would be a lie about coupling.
 * `__tests__/eliseSpeechCueParity.test.js` fails if the two ever drift apart.
 */
export type SpeechCue =
  | 'entry'
  | 'image_understood'
  | 'closet_saved'
  | 'style_item'
  | 'dressing_room_ready'
  | 'change_something';

const CUE_TEXT: Readonly<Record<SpeechCue, string>> = Object.freeze({
  entry:
    'Hey, I’m Elise. Show me what you’re working with, and we’ll figure it out together.',
  image_understood:
    'Got it. I can see what you’re working with. Ask me anything about this piece.',
  closet_saved: 'Saved. Now we can build around it whenever you want.',
  style_item: 'Let’s build a look around it.',
  dressing_room_ready:
    'Here’s a starting point. We can change anything you don’t love.',
  change_something: 'Absolutely. Tell me what you want to change.',
});

const CUES: readonly SpeechCue[] = Object.freeze([
  'entry',
  'image_understood',
  'closet_saved',
  'style_item',
  'dressing_room_ready',
  'change_something',
]);

export const SPEECH_CUES = CUES;

export function isSpeechCue(value: unknown): value is SpeechCue {
  return typeof value === 'string' && (CUES as readonly string[]).includes(value);
}

/** The approved text for a cue, or null when the value is not an approved cue. */
export function speechCueText(value: unknown): string | null {
  return isSpeechCue(value) ? CUE_TEXT[value] : null;
}

/**
 * Resolve a cue to its approved text, or throw the sanitized public error.
 *
 * An unknown cue is `INVALID_REQUEST` rather than a silent fallback: a client
 * asking for a cue this build does not recognize is a contract mismatch, and
 * answering it with some other line would make Elise say the wrong thing at a
 * moment the user is watching.
 */
export function requireSpeechCueText(value: unknown): string {
  const text = speechCueText(value);
  if (!text) {
    throw new StylistSpeechError(400, 'INVALID_REQUEST', 'The speech request contains invalid references.');
  }
  return text;
}
