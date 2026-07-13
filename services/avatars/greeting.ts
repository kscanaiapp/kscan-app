export type GreetingNameSource = 'user_metadata' | 'none';

export interface ResolvedGreeting {
  text: string;
  userFirstName: string | null;
  nameSource: GreetingNameSource;
  genericFallback: boolean;
  stylistName: string;
}

export interface ResolveGreetingOptions {
  /** A stable actor identifier used for the once-per-process greeting guard. */
  actorKey: string;
  /** Display name of the stylist avatar. */
  stylistName?: string;
  /** Trustworthy first name from a verified profile source. */
  userFirstName?: string | null;
}

/**
 * Resolve a stylist greeting according to the product contract.
 *
 * - With a trusted first name: "Hi, Kathleen. I am Elise. How can I help style you today?"
 * - Without a trusted first name: "Hi, I’m Elise. How can I style you today?"
 *
 * The user's name must NOT come from the email address or be guessed.
 */
export function resolveGreeting(options: ResolveGreetingOptions): ResolvedGreeting {
  const { userFirstName, stylistName = 'Elise' } = options;
  const hasName = typeof userFirstName === 'string' && userFirstName.trim().length > 0;
  const firstName = hasName ? userFirstName.trim() : null;

  if (firstName) {
    return {
      text: `Hi, ${firstName}. I am ${stylistName}. How can I help style you today?`,
      userFirstName: firstName,
      nameSource: 'user_metadata',
      genericFallback: false,
      stylistName,
    };
  }

  return {
    text: `Hi, I’m ${stylistName}. How can I style you today?`,
    userFirstName: null,
    nameSource: 'none',
    genericFallback: true,
    stylistName,
  };
}
