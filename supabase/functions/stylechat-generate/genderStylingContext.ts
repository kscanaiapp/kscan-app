// ── Fix #5 baseline styling context — server-side consumption ─────────────────
// Pure helpers, no Deno/network imports, so they are unit-testable from node too.
//
// This is EXPLICIT, SELF-DISCLOSED styling context: the user answered a
// one-time card with exactly one of three options. It is never inferred from
// photo, name, voice, Closet, avatar, or scan history, and this module must
// never grow logic that infers it either.
//
// Backward-compatibility contract:
//   - genderStylingContext is fully optional. Absent -> null -> prompt unchanged.
//   - Malformed / unrecognized input -> null (silent no-op). Never throws.
//   - Only a compact, non-attributable guidance block is ever produced.

export type GenderStylingContextValue = 'man' | 'woman' | 'prefer_not_to_say';

const ALLOWED_VALUES: readonly GenderStylingContextValue[] = ['man', 'woman', 'prefer_not_to_say'];

export function parseGenderStylingContext(raw: unknown): GenderStylingContextValue | null {
  if (typeof raw !== 'string') return null;
  return (ALLOWED_VALUES as readonly string[]).includes(raw)
    ? (raw as GenderStylingContextValue)
    : null;
}

export function buildGenderStylingContextBlock(value: GenderStylingContextValue): string {
  const guidance =
    value === 'prefer_not_to_say'
      ? [
          'The user explicitly chose "prefer not to say" for a one-time baseline styling question.',
          'Use neutral, non-assumptive styling language by default: do not assume or lean toward any gendered framing.',
        ]
      : [
          `The user explicitly selected "${value}" as a one-time, self-disclosed baseline styling preference.`,
          `Lean lightly toward ${value === 'man' ? 'menswear' : 'womenswear'} framing only when the user's own message is itself unspecific about the audience or occasion.`,
        ];

  return [
    '[Optional Baseline Styling Context]',
    ...guidance,
    "The user's explicit request in their message always takes priority over this baseline — if they ask about styling for someone else, an occasion, or state a different preference, follow that instead.",
    'Do not state this preference back to the user, do not mention gender unless the user brings it up, and do not infer anything about the user beyond this one self-disclosed value.',
    '[/Optional Baseline Styling Context]',
  ].join('\n');
}
