/**
 * Build 5.1 — generated (personalized) greeting for Today with Elise V1.
 *
 * WHAT THIS ADDS TO THE EXISTING DAYPART OPENER
 *
 * copyTemplates.ts's `resolveTodayDeterministicCopy` already computes a
 * daypart-based opener ("Good morning.") for every card state, active or not
 * — that part shipped with Build 5 and is unconditional. What was deferred was
 * PERSONALIZATION: substituting the user's first name into that same opener
 * when EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1 is on. This module
 * is exactly that substitution, and nothing else — no new daypart logic, no
 * new UI element, no second flag.
 *
 * WHY A NAME, NEVER MORE
 *
 * `resolveUserFirstName` is the same first-name resolver StyleChat's greeting
 * already uses (services/userFirstName.ts): user_metadata only, control
 * characters stripped, first whitespace-delimited token, never the email
 * local part. This module trusts that resolver rather than re-deriving a name
 * from anything else, so the two greetings in the app can never disagree
 * about what a "safe" first name is.
 *
 * WHY THIS IS PURE
 *
 * No randomness, no I/O, no cache of its own. Given the same
 * (daypart, firstName, active) triple it always returns the same string, so
 * the memoization at the call site (one computation per Today generation) is
 * what prevents re-render churn — this function has no state to leak between
 * renders, accounts, or days in the first place.
 */

import type { TodayDaypart } from './copyTemplates';

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g;

/**
 * Same normalization discipline as userFirstName.ts, PLUS a defensive
 * first-token split. The documented contract is that callers already pass
 * resolveUserFirstName(user).firstName (itself already one token), but this
 * function does not trust that contract silently — a caller that passed a
 * full name by mistake must still only ever surface one word here.
 */
function normalizeGreetingName(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(CONTROL_CHAR_RE, '').trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(/\s+/)[0];
}

/** Generic daypart openers — byte-identical to copyTemplates.ts's DAYPART_OPENERS. */
export const GENERIC_DAYPART_OPENERS: Readonly<Record<TodayDaypart, string>> = Object.freeze({
  morning: 'Good morning.',
  afternoon: 'Good afternoon.',
  evening: 'Good evening.',
});

const PERSONAL_DAYPART_PREFIXES: Readonly<Record<TodayDaypart, string>> = Object.freeze({
  morning: 'Good morning',
  afternoon: 'Good afternoon',
  evening: 'Good evening',
});

export interface GeneratedGreetingInput {
  daypart: TodayDaypart;
  /** Pass the result of resolveUserFirstName(user).firstName directly. */
  firstName: string | null | undefined;
  /**
   * The ALREADY-NESTED derived capability
   * (TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE from constants/featureFlags.ts),
   * never the raw leaf flag. That constant is
   * `TODAY_WITH_ELISE_ACTIVE && TODAY_WITH_ELISE_GENERATED_GREETING_V1`, so the
   * "must not activate independently of the Today parent" requirement is
   * already enforced before this function is ever called — it is not
   * re-checked here, to avoid a second place that could drift from the first.
   */
  active: boolean;
}

export interface GeneratedGreetingResult {
  /** The exact string to render as the card headline. */
  text: string;
  /** True only when a trustworthy name was actually substituted in. */
  personalized: boolean;
}

/**
 * Resolve the Today headline opener.
 *
 * Fails soft to the existing generic opener — the same text Build 5 has
 * always shown — whenever the capability is off, the daypart is unrecognised,
 * or no trustworthy first name is available. There is no exception path: a
 * malformed `firstName` normalizes to null rather than throwing, and an
 * unrecognised `daypart` falls back to the afternoon opener, matching
 * copyTemplates.ts's own `?? DAYPART_OPENERS.afternoon` fallback exactly.
 */
export function resolveGeneratedGreetingOpener(
  input: GeneratedGreetingInput,
): GeneratedGreetingResult {
  const generic = GENERIC_DAYPART_OPENERS[input.daypart] ?? GENERIC_DAYPART_OPENERS.afternoon;

  if (!input.active) {
    return { text: generic, personalized: false };
  }

  const name = normalizeGreetingName(input.firstName);
  if (!name) {
    return { text: generic, personalized: false };
  }

  const prefix = PERSONAL_DAYPART_PREFIXES[input.daypart] ?? PERSONAL_DAYPART_PREFIXES.afternoon;
  return { text: `${prefix}, ${name}.`, personalized: true };
}
