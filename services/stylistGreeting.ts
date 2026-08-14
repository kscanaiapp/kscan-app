/**
 * Pure greeting builder for the customer-facing stylist identity.
 *
 * The selected stylist name comes from the established identity system.
 * The user's first name must come from a trustworthy source; it is never
 * derived from an email address or guessed.
 */

export interface StylistGreetingInput {
  userFirstName: string | null;
  stylistName: string;
}

export interface StylistGreetingResult {
  text: string;
  userFirstName: string | null;
  stylistName: string;
  genericFallback: boolean;
}

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g;

function normalizeName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(CONTROL_CHAR_RE, '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Build a stylist greeting.
 *
 * With a trustworthy first name:
 *   "Hi, Kathleen. I’m Elise. How can I help style you today?"
 *
 * Without one:
 *   "Hey, I’m Elise. Show me what you’re working with, and we’ll figure it out together."
 *
 * The personalized form stays authoritative: using the user's name is the whole
 * point of having it, and Build 29 did not trade that away. The no-name form is
 * the approved Build 29 entry line, which earns its place precisely where there
 * is no name to lean on — it opens with what Elise wants the user to *do*
 * rather than asking an open question the user has no context to answer.
 *
 * Exactly one of these is ever spoken. There is no second entry greeting.
 */
export function buildStylistGreeting(input: StylistGreetingInput): StylistGreetingResult {
  const stylistName = normalizeName(input.stylistName) ?? 'Elise';
  const firstName = normalizeName(input.userFirstName);

  if (firstName) {
    return {
      text: `Hi, ${firstName}. I’m ${stylistName}. How can I help style you today?`,
      userFirstName: firstName,
      stylistName,
      genericFallback: false,
    };
  }

  return {
    text: `Hey, I’m ${stylistName}. Show me what you’re working with, and we’ll figure it out together.`,
    userFirstName: null,
    stylistName,
    genericFallback: true,
  };
}
