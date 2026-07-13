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
 *   "Hi, Kathleen. I am Elise. How can I help style you today?"
 *
 * Without one:
 *   "Hi, I’m Elise. How can I style you today?"
 */
export function buildStylistGreeting(input: StylistGreetingInput): StylistGreetingResult {
  const stylistName = normalizeName(input.stylistName) ?? 'Elise';
  const firstName = normalizeName(input.userFirstName);

  if (firstName) {
    return {
      text: `Hi, ${firstName}. I am ${stylistName}. How can I help style you today?`,
      userFirstName: firstName,
      stylistName,
      genericFallback: false,
    };
  }

  return {
    text: `Hi, I’m ${stylistName}. How can I style you today?`,
    userFirstName: null,
    stylistName,
    genericFallback: true,
  };
}
