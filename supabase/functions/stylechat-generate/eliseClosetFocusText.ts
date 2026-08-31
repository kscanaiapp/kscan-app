/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C2 sections 20/21.
 *
 * Text -> owned-Closet focus matching: "my brown loafers", "my black blazer".
 *
 * WHAT THIS IS NOT
 * ----------------
 * This is not a second focus resolver. `resolveEliseFocusedItem` remains the
 * single entry point; this module is the bounded matcher it consults when the
 * envelope carried no focused evidence. Envelope focus always wins, because a
 * thing the user physically pointed at outranks a thing they described.
 *
 * OWNERSHIP RULE
 * --------------
 * Matching runs ONLY over candidates the retrieval layer already authorized as
 * `owned` for this actor. A phrase can therefore never widen access: the worst
 * a hostile phrase can do is fail to match. Client-supplied ids are not an
 * input here at all.
 *
 * AMBIGUITY RULE (section 21)
 * ---------------------------
 * "my black jacket" against three black jackets must not silently resolve to
 * one of them. When the top matches are credibly tied the matcher reports the
 * tie instead of a winner, and the pipeline reasons at category level. Silent
 * selection is the one outcome this module exists to prevent.
 */

import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';

/** Bounds -- a phrase can never make this loop unbounded. */
const MAX_PHRASE_CHARS = 120;
const MAX_TIE_CANDIDATES = 4;
/**
 * A match must clear this to count at all. One garment-noun hit alone is enough
 * (2 points); a bare colour word is not.
 */
const MIN_SCORE = 2;
/**
 * Two matches are "credibly tied" when the runner-up is within this fraction of
 * the leader. Deliberately generous: a near-miss must produce the honest
 * "which one did you mean?" path, not a coin flip presented as certainty.
 */
const TIE_RATIO = 0.75;

/**
 * Possessive lead-ins that mark a phrase as being ABOUT the user's own things.
 * Without one of these, "a black jacket" is a styling abstraction, not a
 * reference to an owned item, and this matcher stays out of the way.
 */
const POSSESSIVE = /\b(my|mine|our|i\s+own|i\s+have|that\s+i\s+own)\b/i;

/** Colour words the Closet actually stores, plus the everyday synonyms. */
const COLOR_TOKENS = [
  'black', 'white', 'cream', 'ivory', 'beige', 'tan', 'camel', 'brown', 'chocolate',
  'grey', 'gray', 'charcoal', 'silver', 'navy', 'blue', 'denim', 'teal', 'turquoise',
  'green', 'olive', 'khaki', 'sage', 'red', 'burgundy', 'maroon', 'wine', 'orange',
  'rust', 'yellow', 'mustard', 'gold', 'pink', 'blush', 'rose', 'purple', 'lilac',
  'lavender', 'plum',
];

/**
 * Garment nouns we expect to find in a Closet row's category, subtype or title.
 * Phrase tokens are singularized before comparison, so "loafers" and "loafer"
 * behave identically.
 */
const GARMENT_TOKENS = [
  'loafer', 'sneaker', 'trainer', 'boot', 'heel', 'pump', 'sandal', 'oxford', 'brogue',
  'derby', 'mule', 'flat', 'shoe',
  'blazer', 'jacket', 'coat', 'trench', 'parka', 'anorak', 'windbreaker', 'bomber',
  'cardigan', 'sweater', 'jumper', 'hoodie', 'sweatshirt', 'pullover', 'vest',
  'shirt', 'blouse', 'tee', 'tshirt', 't-shirt', 'top', 'tank', 'polo', 'turtleneck',
  'trouser', 'pant', 'jean', 'chino', 'short', 'skirt', 'legging',
  'dress', 'gown', 'jumpsuit', 'romper',
  'bag', 'purse', 'tote', 'clutch', 'backpack', 'belt', 'scarf', 'hat', 'cap',
  'beanie', 'glove', 'watch', 'necklace', 'bracelet', 'earring', 'sunglass',
];

/** Materials that commonly disambiguate otherwise-identical garments. */
const MATERIAL_TOKENS = [
  'leather', 'suede', 'denim', 'wool', 'cashmere', 'cotton', 'linen', 'silk',
  'satin', 'velvet', 'corduroy', 'tweed', 'knit', 'fleece', 'nylon', 'canvas',
];

export interface EliseClosetTextFocusPhrase {
  /** The raw phrase, bounded. Shape-only; never emitted to telemetry or logs. */
  phrase: string;
  colors: string[];
  garments: string[];
  materials: string[];
  brandWords: string[];
}

export type EliseClosetTextFocusResult =
  | { status: 'no_phrase' }
  | { status: 'no_match'; phrase: EliseClosetTextFocusPhrase }
  | {
    status: 'matched';
    phrase: EliseClosetTextFocusPhrase;
    candidate: EliseWardrobeCandidate;
    score: number;
  }
  | {
    status: 'ambiguous';
    phrase: EliseClosetTextFocusPhrase;
    candidates: EliseWardrobeCandidate[];
    sharedCategory: string | null;
  };

function normalize(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  return value
    .toLowerCase()
    // Anything that is not a letter, digit, space or hyphen becomes a space.
    // That covers control characters, punctuation and every non-Latin byte in
    // one pass, so a hostile title cannot smuggle a token past the split below.
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "loafers" -> "loafer"; leaves already-singular words alone. */
function singular(word: string): string {
  if (word.length > 3 && word.endsWith('ies')) return `${word.slice(0, -3)}y`;
  if (word.length > 3 && word.endsWith('es') && !word.endsWith('ses')) return word.slice(0, -2);
  if (word.length > 2 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function tokenize(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean).map(singular);
}

/**
 * Extract the possessive wardrobe phrase from a message, if there is one.
 *
 * Returns null when the user did not refer to something of their own, which is
 * the common case ("what goes with navy?") and must not trigger owned-item
 * matching.
 */
export function extractClosetFocusPhrase(
  message: string,
): EliseClosetTextFocusPhrase | null {
  if (typeof message !== 'string' || !message.trim()) return null;
  if (!POSSESSIVE.test(message)) return null;

  const bounded = message.slice(0, 2_000);
  // Take the window that starts at the possessive marker: "...around my brown
  // loafers for dinner" -> "my brown loafers for dinner". Everything before the
  // marker describes the request, not the item.
  const match = bounded.match(POSSESSIVE);
  const start = match?.index ?? 0;
  const window = bounded.slice(start, start + MAX_PHRASE_CHARS);
  const tokens = tokenize(window);
  if (!tokens.length) return null;

  const colors = tokens.filter((t) => COLOR_TOKENS.includes(t));
  const garments = tokens.filter((t) => GARMENT_TOKENS.includes(t));
  const materials = tokens.filter((t) => MATERIAL_TOKENS.includes(t));

  // A phrase with no garment noun is not an item reference. "my style",
  // "my budget", "my wedding" must not enter owned-item matching.
  if (!garments.length) return null;

  // Words in none of the known vocabularies are brand candidates. Bounded, and
  // only ever compared against the server-held brand field.
  const known = new Set([...COLOR_TOKENS, ...GARMENT_TOKENS, ...MATERIAL_TOKENS]);
  const stop = new Set([
    'my', 'mine', 'our', 'own', 'have', 'ive', 'got', 'that', 'the', 'a', 'an',
    'with', 'for', 'and', 'or', 'to', 'in', 'on', 'of', 'around', 'build', 'style',
    'wear', 'outfit', 'look', 'three', 'some', 'what', 'goe', 'go',
    'can', 'do', 'i', 'are', 'it', 'thi', 'these', 'those', 'me', 'up', 'new',
  ]);
  const brandWords = tokens
    .filter((t) => !known.has(t) && !stop.has(t) && t.length > 2)
    .slice(0, 3);

  return {
    phrase: window.trim().slice(0, MAX_PHRASE_CHARS),
    colors: [...new Set(colors)].slice(0, 4),
    garments: [...new Set(garments)].slice(0, 4),
    materials: [...new Set(materials)].slice(0, 4),
    brandWords,
  };
}

/**
 * Score one owned candidate against the phrase.
 *
 * Weighting reflects how strongly each signal identifies a specific garment:
 * the garment noun is the anchor (nothing matches without it), colour narrows
 * within that garment, material and brand narrow further.
 */
function scoreCandidate(
  candidate: EliseWardrobeCandidate,
  phrase: EliseClosetTextFocusPhrase,
): number {
  const haystackWords = new Set(
    [
      ...tokenize(candidate.category ?? ''),
      ...tokenize(candidate.subcategory ?? ''),
      ...tokenize(candidate.title ?? ''),
    ].filter(Boolean),
  );
  const colorWords = new Set(candidate.colors.flatMap((c) => tokenize(c)));
  const materialWords = new Set(candidate.materials.flatMap((m) => tokenize(m)));
  const brandWords = new Set(tokenize(candidate.brand ?? ''));

  let score = 0;

  // Garment noun: the anchor. No garment hit -> no match at all.
  const garmentHit = phrase.garments.some((g) => haystackWords.has(g));
  if (!garmentHit) return 0;
  score += 2;

  // A phrase naming a colour the item does not have is evidence AGAINST this
  // item, not merely absence of evidence. "my brown loafers" must not resolve
  // to black loafers when brown loafers also exist.
  if (phrase.colors.length) {
    const colorHit = phrase.colors.some(
      (c) => colorWords.has(c) || haystackWords.has(c),
    );
    if (colorHit) score += 2;
    else score -= 1;
  }

  if (phrase.materials.length) {
    const materialHit = phrase.materials.some(
      (m) => materialWords.has(m) || haystackWords.has(m),
    );
    if (materialHit) score += 1;
  }

  if (phrase.brandWords.length && brandWords.size) {
    const brandHit = phrase.brandWords.some((b) => brandWords.has(b));
    if (brandHit) score += 2;
  }

  return score;
}

/**
 * Match a possessive phrase against ALREADY-AUTHORIZED owned candidates.
 *
 * `candidates` must be the actor-scoped retrieval output. This function does no
 * authorization of its own, precisely so that it cannot become a way to get any.
 */
export function matchClosetFocusFromText(input: {
  message: string;
  candidates: EliseWardrobeCandidate[];
}): EliseClosetTextFocusResult {
  const phrase = extractClosetFocusPhrase(input.message);
  if (!phrase) return { status: 'no_phrase' };

  // Ownership language is only honest about owned rows, so only owned rows can
  // become a "my ..." focus. A saved or scanned item is not something the user
  // told us they own.
  const owned = input.candidates.filter((c) => c.actorRelationship === 'owned');
  if (!owned.length) return { status: 'no_match', phrase };

  const scored = owned
    .map((candidate) => ({ candidate, score: scoreCandidate(candidate, phrase) }))
    .filter((entry) => entry.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);

  if (!scored.length) return { status: 'no_match', phrase };

  const leader = scored[0];
  const tied = scored.filter((entry) => entry.score >= leader.score * TIE_RATIO);

  if (tied.length > 1) {
    const categories = new Set(
      tied
        .map((entry) => normalize(entry.candidate.category))
        .filter((value) => Boolean(value)),
    );
    return {
      status: 'ambiguous',
      phrase,
      candidates: tied.slice(0, MAX_TIE_CANDIDATES).map((entry) => entry.candidate),
      sharedCategory: categories.size === 1 ? [...categories][0] : null,
    };
  }

  return {
    status: 'matched',
    phrase,
    candidate: leader.candidate,
    score: leader.score,
  };
}
