// Fix #5 — explicit, self-disclosed baseline styling context for first-use
// Elise personalization.
//
// This is explicit user-provided context, never a demographic inference: it
// exists only because the user chose one of exactly three options on a
// dismissible card. Nothing here reads or writes photo, name, voice, Closet,
// avatar, or scan history data.

export type GenderStylingContext = 'man' | 'woman' | 'prefer_not_to_say';

export const GENDER_STYLING_CONTEXT_VALUES: readonly GenderStylingContext[] = Object.freeze([
  'man',
  'woman',
  'prefer_not_to_say',
]);

export function isValidGenderStylingContext(
  value: unknown,
): value is GenderStylingContext {
  return (
    typeof value === 'string' &&
    (GENDER_STYLING_CONTEXT_VALUES as readonly string[]).includes(value)
  );
}

/**
 * Normalize a raw persisted value. `null` means "not answered yet" and is a
 * valid, distinct state from any of the three answers — callers must not
 * collapse it to a default option.
 */
export function normalizeGenderStylingContext(
  raw: unknown,
): GenderStylingContext | null {
  return isValidGenderStylingContext(raw) ? raw : null;
}
