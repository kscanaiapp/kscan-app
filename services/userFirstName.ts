import type { User } from '@supabase/supabase-js';

export type UserNameSource = 'first_name' | 'given_name' | 'full_name' | 'name' | 'display_name' | null;

export interface ResolvedUserFirstName {
  firstName: string | null;
  source: UserNameSource;
}

const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g;

function pickFirstName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(CONTROL_CHAR_RE, '').trim();
  if (trimmed.length === 0) return null;
  return trimmed.split(/\s+/)[0];
}

/**
 * Resolve a trustworthy first name from the authenticated user object.
 *
 * Priority:
 * 1. user_metadata.first_name
 * 2. user_metadata.given_name
 * 3. first token of user_metadata.full_name
 * 4. first token of user_metadata.name
 * 5. first token of user_metadata.display_name
 *
 * The email local part is never used as a name.
 */
export function resolveUserFirstName(user: User | null | undefined): ResolvedUserFirstName {
  if (!user) return { firstName: null, source: null };

  const meta = user.user_metadata as Record<string, unknown> | undefined;
  if (!meta) return { firstName: null, source: null };

  const fromField = (field: string): string | null => pickFirstName(meta[field]);

  const firstName = fromField('first_name');
  if (firstName) return { firstName, source: 'first_name' };

  const givenName = fromField('given_name');
  if (givenName) return { firstName: givenName, source: 'given_name' };

  const fromFullName = pickFirstName(meta.full_name);
  if (fromFullName) return { firstName: fromFullName, source: 'full_name' };

  const fromName = pickFirstName(meta.name);
  if (fromName) return { firstName: fromName, source: 'name' };

  const fromDisplayName = pickFirstName(meta.display_name);
  if (fromDisplayName) return { firstName: fromDisplayName, source: 'display_name' };

  return { firstName: null, source: null };
}
