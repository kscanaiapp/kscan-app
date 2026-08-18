// ── Fix #6 — server-side stylist naming identity ───────────────────────────────
// Pure helpers, no Deno/network imports, so they are unit-testable from node too.
//
// THE SINGLE NAME RESOLVER for this backend. It mirrors
// constants/stylistIdentity.ts's client-side resolveStylistDisplayName exactly
// (same precedence, same canonical map, same safe default) so the model's own
// self-identification can never diverge from what the user sees in the app.
// There is deliberately no second, independently-invented resolver here.
//
// This module never receives client-supplied free text for the name: the
// caller queries `user_stylist_preferences` directly with the JWT-derived
// actor id (see index.ts) and passes the resulting row through
// resolveStylistDisplayName. That avoids a prompt-injection path that a
// client-supplied "displayName" request field would otherwise open.

export const CANONICAL_PORTRAIT_NAMES: Readonly<Record<string, string>> = Object.freeze({
  stylist_portrait_01: 'Elise',
  stylist_portrait_02: 'Henry',
  stylist_portrait_03: 'Janet',
  stylist_portrait_04: 'Marie',
  stylist_portrait_05: 'Sarah',
  stylist_portrait_06: 'Vivian',
  stylist_portrait_07: 'Isabella',
  stylist_portrait_08: 'Michael',
  stylist_portrait_09: 'David',
  stylist_portrait_10: 'Kim',
});

/** Safe default used for abstract presets, unknown avatar ids, and no-row actors. */
export const SAFE_DEFAULT_STYLIST_NAME = 'Elise';

const NAME_MIN_LENGTH = 2;
const NAME_MAX_LENGTH = 24;
const CONTROL_CHAR_RE = /[\x00-\x1F\x7F]/g;

/** Same bounds constants/stylistIdentity.ts enforces client-side at save time. */
function sanitizeStoredName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL_CHAR_RE, '').trim();
  if (cleaned.length < NAME_MIN_LENGTH || cleaned.length > NAME_MAX_LENGTH) return null;
  return cleaned;
}

export function resolveCanonicalStylistName(avatarId: unknown): string {
  if (typeof avatarId !== 'string' || !avatarId) return SAFE_DEFAULT_STYLIST_NAME;
  return CANONICAL_PORTRAIT_NAMES[avatarId] ?? SAFE_DEFAULT_STYLIST_NAME;
}

/**
 * customName (from the stored, possibly-null user_stylist_preferences row) wins
 * whenever present and valid; otherwise falls back to the canonical name for the
 * given avatarId; otherwise the safe default. Never infers a name from anything
 * else (gender styling context, portrait, future voice, etc.).
 */
export function resolveStylistDisplayName(customName: unknown, avatarId: unknown): string {
  return sanitizeStoredName(customName) ?? resolveCanonicalStylistName(avatarId);
}

/**
 * Compact, bracketed, self-contained persona instruction — same shape as the
 * Style DNA / gender-styling-context blocks. No user-supplied free text is
 * interpolated here beyond the already-sanitized (length-bounded,
 * control-character-stripped) resolved name.
 */
export function buildStylistPersonaBlock(resolvedName: string): string {
  return [
    '[Stylist Persona]',
    `Your name is ${resolvedName}. If asked your name, or when introducing yourself, use exactly this name.`,
    '[/Stylist Persona]',
  ].join('\n');
}
