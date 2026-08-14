/**
 * Deterministic Elise speech moments.
 *
 * Centralized for the same reason `ELISE_IMAGE_LOOP_COPY` and `constants/elise.ts`
 * exist: the words a stylist says are product copy, and copy that lives inline in
 * six components drifts into six slightly different products.
 *
 * These six lines are fixed Build 29 product constants. They are deliberately NOT
 * generated: a state transition selects an approved line, and that line is spoken
 * through the existing governed stylist-speech path. No model is asked what Elise
 * should say, which is what lets runtime QA prove `STATE -> EXPECTED LINE` exactly
 * and keeps Elise from becoming talkative.
 *
 * This module is pure. It owns the moment vocabulary and the copy, and nothing
 * else — no persistence, no playback, no lifecycle. Callers own the "did this
 * transition genuinely happen" question, because only they can answer it.
 */

/**
 * The transitions Elise speaks to. Each is a *confirmed* state change, never an
 * intent: `image_understood` is not "a picture was picked", `closet_saved` is not
 * "save was tapped", and `dressing_room_ready` is not "navigation started".
 */
export type EliseSpeechMoment =
  | 'entry'
  | 'image_understood'
  | 'closet_saved'
  | 'style_item'
  | 'dressing_room_ready'
  | 'change_something';

/**
 * The approved Build 29 lines, verbatim.
 *
 * Typographic apostrophes match the existing stylist copy (`buildStylistGreeting`
 * emits `I’m`), so these render consistently with every other Elise string. The
 * wording itself is unchanged from the approved product copy.
 *
 * Tone rule these encode: Elise is confident, warm, concise and collaborative.
 * She says "I can see what you're working with", never "I have analyzed your
 * image"; "Here's a starting point", never "your request has been completed".
 */
export const ELISE_SPEECH_MOMENT_COPY: Readonly<Record<EliseSpeechMoment, string>> =
  Object.freeze({
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

const MOMENTS: readonly EliseSpeechMoment[] = Object.freeze([
  'entry',
  'image_understood',
  'closet_saved',
  'style_item',
  'dressing_room_ready',
  'change_something',
]);

/** Every approved moment, in transition order. */
export function listEliseSpeechMoments(): readonly EliseSpeechMoment[] {
  return MOMENTS;
}

export function isEliseSpeechMoment(value: unknown): value is EliseSpeechMoment {
  return typeof value === 'string' && (MOMENTS as readonly string[]).includes(value);
}

/**
 * Resolve a moment to its approved line.
 *
 * Returns null for anything that is not an approved moment. Returning null rather
 * than a fallback string is the point: an unrecognized state must produce silence,
 * never invented speech. Elise saying something plausible-but-unapproved is a
 * worse failure than Elise saying nothing.
 */
export function resolveEliseSpeechMomentCopy(moment: unknown): string | null {
  if (!isEliseSpeechMoment(moment)) return null;
  return ELISE_SPEECH_MOMENT_COPY[moment];
}
