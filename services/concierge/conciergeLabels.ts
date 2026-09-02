/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C4 shared relationship copy.
 *
 * One mapping, both platforms (section 38). The words a customer reads about
 * what they own are exactly the kind of thing that drifts when each platform
 * writes its own strings, and a drift here is not cosmetic: it is a different
 * ownership claim on iOS than on Android.
 *
 * SECTION 42 -- QUIET BY DEFAULT
 * ------------------------------
 * The section heading ("From your Closet") is the ownership signal when every
 * item is owned, so an owned card in that context needs no badge of its own.
 * Per-card labels exist for MIXED evidence, where the heading cannot speak for
 * all of them. `conciergeCardLabel` returns null for the quiet case, and a
 * renderer showing a chip for every item is a bug, not a style choice.
 */

import type { ConciergePresentation, ConciergeRelationship } from './conciergeModel';

/** Section heading above the item cards. Null means no heading is warranted. */
export function conciergeSectionTitle(presentation: ConciergePresentation): string | null {
  switch (presentation) {
    case 'closet':
      return 'From your Closet';
    case 'mixed':
      // Deliberately NOT "From your Closet": not everything below is owned, and
      // a heading that says otherwise is a false claim the per-card labels
      // would then have to argue with.
      return 'Pieces for this look';
    case 'none':
    default:
      return null;
  }
}

/**
 * Per-card relationship label, or null when the section heading already says
 * it. Never invents a stronger relationship than the server asserted.
 */
export function conciergeCardLabel(
  relationship: ConciergeRelationship,
  presentation: ConciergePresentation,
): string | null {
  // Quiet case: an all-owned section is already headed "From your Closet".
  if (presentation === 'closet' && relationship === 'owned') return null;

  switch (relationship) {
    case 'owned':
      return 'In your Closet';
    case 'saved':
      // Saved is a bookmark, not a possession. The wording has to make that
      // readable at a glance, because "Saved" alone gets heard as "mine".
      return 'Saved';
    case 'scanned':
      return 'Scanned';
    case 'shared':
      return 'Shared with you';
    case 'discovered':
      return 'Shopping option';
    case 'unverified':
    case 'unknown':
    default:
      // Ownership is genuinely unknown. Say nothing about it rather than
      // guessing in either direction.
      return null;
  }
}

/**
 * The card's headline, including the fallback used when the evidence carried
 * neither a title nor a category.
 *
 * AUDIT-CON-004. The fallback must not itself be an ownership claim. A card
 * built from a SHARED or DISCOVERED candidate that happens to lack both fields
 * previously read "Closet item" -- the words the section heading uses for the
 * user's own clothes -- directly under a "Shared with you" or "Shopping option"
 * chip. That is a false ownership statement produced by a placeholder, and it
 * sits on the one surface the whole feature is trying to make trustworthy.
 *
 * Only an OWNED card may fall back to Closet wording; everything else gets a
 * neutral noun that asserts nothing about who owns it. This lives beside the
 * other relationship copy so both platforms cannot word it differently.
 */
export function conciergeCardTitle(card: {
  title: string | null;
  category: string | null;
  relationship: ConciergeRelationship;
}): string {
  if (card.title) return card.title;
  if (card.category) return card.category;
  return card.relationship === 'owned' ? 'Closet item' : 'Item';
}

/**
 * The spoken provenance of one card, for assistive technology.
 *
 * SECTION 50, AND THE REASON IT IS SEPARATE FROM `conciergeCardLabel`.
 *
 * The visible chip is quiet by design: under an all-owned "From your Closet"
 * heading it is suppressed, because the heading already says it once and
 * repeating it on every row is noise. A screen reader does not read the page
 * that way. It reads the card, and a card with a suppressed chip carried NO
 * provenance at all -- so the one signal this whole feature exists to make
 * unmistakable was the signal a non-sighted customer did not get.
 *
 * This always states the relationship in words, from the SERVER's provenance
 * and never from prose, so the spoken card and the drawn card make the same
 * claim regardless of which one the heading happens to be carrying.
 */
export function conciergeCardAccessibilityLabel(
  card: {
    title: string | null;
    category: string | null;
    brand: string | null;
    relationship: ConciergeRelationship;
  },
  presentation: ConciergePresentation,
): string {
  const name = conciergeCardTitle(card);
  const parts = [name];
  if (card.brand) parts.push(card.brand);

  // Spoken provenance. `conciergeCardLabel` is reused wherever it has an
  // answer, so the two can never word the same relationship differently; the
  // only case it declines is the quiet one, which is spelled out here.
  const spoken =
    conciergeCardLabel(card.relationship, presentation) ??
    (card.relationship === 'owned' ? 'In your Closet' : null);
  if (spoken) parts.push(spoken);

  return parts.join(', ');
}

/**
 * Human copy for a scoped wardrobe gap.
 *
 * `evidenceIsExhaustive` decides between a statement and a hedge (section 27).
 * With bounded evidence the copy can only describe what was reviewed; it must
 * never become "you do not own a jacket".
 */
export function conciergeGapCopy(input: {
  gapCodes: string[];
  evidenceIsExhaustive: boolean;
}): string | null {
  if (!input.gapCodes.length) return null;

  const nouns = input.gapCodes
    .map((code) => GAP_NOUNS[code])
    .filter((noun): noun is string => Boolean(noun));
  if (!nouns.length) return null;

  const list = nouns.length === 1
    ? nouns[0]
    : `${nouns.slice(0, -1).join(', ')} or ${nouns[nouns.length - 1]}`;

  return input.evidenceIsExhaustive
    ? `Your Closet doesn't have ${list} yet.`
    : `From the pieces I reviewed, I didn't find ${list}.`;
}

/** Stable server gap codes -> everyday nouns. Unknown codes render nothing. */
const GAP_NOUNS: Record<string, string> = {
  missing_shoe: 'shoes',
  missing_layer: 'a layer',
  missing_bottom: 'bottoms',
  missing_base: 'a top',
  missing_accessory: 'an accessory',
  missing_neutral: 'a neutral piece',
};

/**
 * Copy for an ambiguous focus (section 21).
 *
 * Honest by construction: it states that several items matched and that no
 * single one was chosen. It must never name one of them.
 */
export function conciergeAmbiguityCopy(sharedCategory: string | null): string {
  return sharedCategory
    ? `You have a few ${sharedCategory} pieces that match — here are ideas for that group.`
    : 'A few pieces in your Closet match that — here are ideas for the group.';
}
