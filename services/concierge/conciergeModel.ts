/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C4 shared presentation model.
 *
 * SHARED BY BOTH PLATFORMS ON PURPOSE (section 38). iOS and Android render the
 * same Concierge because they project the same server payload through this one
 * module. Anything platform-specific lives above it, never inside it.
 *
 * THE ONE RULE THIS FILE ENFORCES (sections 32/41)
 * -----------------------------------------------
 * Wardrobe objects are built from VALIDATED STRUCTURED DATA, never from prose.
 * Nothing here reads `message`, and there is no path by which a sentence can
 * become a card. If the structured data cannot support a card, no card appears
 * -- the answer degrades to text, which is always a correct outcome.
 *
 * INVALID IDENTITIES ARE DROPPED, NEVER PATCHED (section 36)
 * ---------------------------------------------------------
 * A recommendation whose display facts are missing, malformed or unusable is
 * removed from the model. It is never backfilled from a neighbouring item, and
 * never replaced by a "close enough" one. A look that loses items keeps the
 * ones that survived; a look that loses all of them disappears.
 */

import type {
  EliseAdviceMetadataClient,
  EliseAdviceDisplayFactsClient,
  EliseWardrobeContextModeClient,
} from '../../types/eliseAdvice';

/**
 * How the actor is related to an item. Mirrors the server vocabulary exactly:
 * widening it here would let the UI describe a relationship the server never
 * asserted.
 */
export type ConciergeRelationship =
  | 'owned'
  | 'saved'
  | 'scanned'
  | 'shared'
  | 'discovered'
  | 'unverified'
  | 'unknown';

/** One renderable wardrobe item. Every field traces to server display facts. */
export interface ConciergeCard {
  candidateId: string;
  relationship: ConciergeRelationship;
  title: string | null;
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  /** Canonical Closet row id, for LOCAL image resolution. Null -> text card. */
  clientId: string | null;
  /** True for the item the answer is built AROUND, not one of the pairings. */
  isFocus: boolean;
}

export interface ConciergeLookGroup {
  lookId: string;
  label: string;
  cards: ConciergeCard[];
  /** Stable gap codes, already scoped by the server. May be empty. */
  missingPieceCodes: string[];
}

/**
 * What the Concierge surface should show for one assistant message.
 *
 * `presentation` is the single value a renderer branches on, so that the
 * "should anything appear at all?" decision is made once, here, rather than
 * being re-derived (and drifting) in each platform's view code.
 */
export type ConciergePresentation =
  /** Nothing to show. Base Elise prose stands alone. */
  | 'none'
  /** Owned Closet evidence only -- a "From your Closet" section is honest. */
  | 'closet'
  /** Owned plus other relationships -- cards must carry individual labels. */
  | 'mixed';

export interface ConciergeResult {
  presentation: ConciergePresentation;
  /** The item the answer is built around, when one resolved. */
  focusCard: ConciergeCard | null;
  /** Flat item list. Populated even when `looks` is empty (section 44). */
  cards: ConciergeCard[];
  /** Grouped looks. Empty is normal and must NOT be faked client-side. */
  looks: ConciergeLookGroup[];
  /**
   * Section 21. True when the server matched several owned items and declined
   * to choose. The UI must not imply a specific item resolved.
   */
  focusAmbiguous: boolean;
  /** Shared category of the ambiguous group, when they agreed on one. */
  focusAmbiguousCategory: string | null;
  /**
   * Section 27. False means gap language must stay scoped. Carried through so
   * a renderer cannot accidentally present a bounded finding as a certainty.
   */
  gapEvidenceIsExhaustive: boolean;
  /** Scoped gap codes. Empty when there is nothing worth surfacing. */
  gapCodes: string[];
}

export const EMPTY_CONCIERGE_RESULT: ConciergeResult = {
  presentation: 'none',
  focusCard: null,
  cards: [],
  looks: [],
  focusAmbiguous: false,
  focusAmbiguousCategory: null,
  gapEvidenceIsExhaustive: false,
  gapCodes: [],
};

/**
 * Derive the Closet owner id from the authenticated Style DNA user key.
 *
 * SHARED, NOT PLATFORM, AND SECURITY-RELEVANT. `userKey` is the
 * `user:{supabaseUserId}` form the session screen already derives from the
 * authenticated session -- the same key the Style DNA feedback surface gates
 * on. This is the only accepted input: taking an owner id from anywhere less
 * authenticated (a route param, a cached profile, a message field) would let a
 * signed-out or wrongly-scoped render reach a Closet.
 *
 * Returns null for every shape it does not recognise, and null means no image
 * resolution is attempted at all -- cards fall back to text. Failing closed is
 * the only safe direction: a wrong owner id resolves ANOTHER ACCOUNT'S photos.
 *
 * It lives here rather than in the chat bubble so both platforms derive the
 * owner identically and the rule is testable without mounting a view.
 */
export function conciergeOwnerIdFromUserKey(
  userKey: string | null | undefined,
): string | null {
  if (typeof userKey !== 'string') return null;
  const PREFIX = 'user:';
  if (!userKey.startsWith(PREFIX)) return null;
  const ownerId = userKey.slice(PREFIX.length).trim();
  // An empty or whitespace-only remainder is not an identity. Returning it
  // would produce an owner-scoped Closet read keyed on "".
  return ownerId ? ownerId : null;
}

const RELATIONSHIPS: ConciergeRelationship[] = [
  'owned',
  'saved',
  'scanned',
  'shared',
  'discovered',
  'unverified',
  'unknown',
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asDisplayString(value: unknown, maxChars = 120): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  return cleaned.slice(0, maxChars);
}

/**
 * Map a server relationship string onto the closed client vocabulary.
 *
 * An unrecognised value becomes 'unknown', NOT 'owned'. Defaulting the other
 * way would turn a backend that grew a new relationship into a source of false
 * ownership claims on every older client.
 */
export function toConciergeRelationship(value: unknown): ConciergeRelationship {
  if (typeof value !== 'string') return 'unknown';
  const found = RELATIONSHIPS.find((relationship) => relationship === value);
  return found ?? 'unknown';
}

/**
 * Build one card from server display facts.
 *
 * Returns null -- meaning "drop this item" -- when the facts cannot support a
 * card at all. A card with no identifying text and no image handle is a grey
 * rectangle that claims to be one of the user's clothes, which is worse than
 * showing nothing.
 */
function toCard(input: {
  candidateId: unknown;
  relationship: unknown;
  facts: unknown;
  isFocus: boolean;
}): ConciergeCard | null {
  const candidateId = asDisplayString(input.candidateId, 80);
  if (!candidateId) return null;
  if (!isRecord(input.facts)) return null;

  const facts = input.facts as unknown as EliseAdviceDisplayFactsClient;
  const title = asDisplayString(facts.title);
  const category = asDisplayString(facts.category, 80);
  const clientId = asDisplayString(facts.clientId, 80);

  // Nothing to render and nothing to resolve an image from.
  if (!title && !category && !clientId) return null;

  return {
    candidateId,
    relationship: toConciergeRelationship(input.relationship),
    title,
    category,
    subtype: asDisplayString(facts.subtype, 80),
    brand: asDisplayString(facts.brand, 80),
    primaryColor: asDisplayString(facts.primaryColor, 40),
    clientId,
    isFocus: input.isFocus,
  };
}

/**
 * Project validated advice metadata into the renderable Concierge model.
 *
 * `metadata` is whatever the provider passed through -- possibly a v1 payload,
 * possibly from a backend older than this client. Every field is treated as
 * untrusted SHAPE (not untrusted AUTHORITY: the values are server-authored),
 * so a malformed payload yields an empty result rather than a crash.
 */
export function buildConciergeResult(
  metadata: EliseAdviceMetadataClient | Record<string, unknown> | null | undefined,
): ConciergeResult {
  if (!isRecord(metadata)) return EMPTY_CONCIERGE_RESULT;

  // Absent mode means v1, which had no Concierge signal at all. Reading that as
  // anything but 'none' would render Closet chrome from a payload that never
  // claimed any Closet participation.
  const rawMode = (metadata as Record<string, unknown>).wardrobeContextMode;
  const mode: EliseWardrobeContextModeClient =
    rawMode === 'closet' || rawMode === 'mixed' ? rawMode : 'none';
  if (mode === 'none') return EMPTY_CONCIERGE_RESULT;

  const rawRecommendations = (metadata as Record<string, unknown>).recommendations;
  const cards: ConciergeCard[] = Array.isArray(rawRecommendations)
    ? rawRecommendations
      .map((entry) =>
        isRecord(entry)
          ? toCard({
            candidateId: entry.candidateId,
            relationship: entry.actorRelationship,
            facts: entry.displayFacts,
            isFocus: false,
          })
          : null,
      )
      .filter((card): card is ConciergeCard => card !== null)
    : [];

  const rawFocus = (metadata as Record<string, unknown>).focusedItem;
  const focusCard = isRecord(rawFocus)
    ? toCard({
      // The focus is excluded from `recommendations` server-side, so it has no
      // candidateId of its own on the wire. Its clientId is the stable
      // identity, and prefixing keeps it from colliding with a recommendation
      // key in a list render.
      candidateId: isRecord(rawFocus.displayFacts)
        ? `focus:${String(rawFocus.displayFacts.clientId ?? 'unknown')}`
        : null,
      relationship: rawFocus.actorRelationship,
      facts: rawFocus.displayFacts,
      isFocus: true,
    })
    : null;

  const byId = new Map(cards.map((card) => [card.candidateId, card]));

  const rawLooks = (metadata as Record<string, unknown>).looks;
  const looks: ConciergeLookGroup[] = Array.isArray(rawLooks)
    ? rawLooks
      .map((entry): ConciergeLookGroup | null => {
        if (!isRecord(entry)) return null;
        const lookId = asDisplayString(entry.lookId, 40);
        if (!lookId) return null;
        const ids = Array.isArray(entry.candidateIds) ? entry.candidateIds : [];
        // An id with no surviving card is DROPPED. It is never swapped for a
        // different item to keep the look looking complete (section 36).
        const lookCards = ids
          .map((id) => (typeof id === 'string' ? byId.get(id) : undefined))
          .filter((card): card is ConciergeCard => Boolean(card));
        if (!lookCards.length) return null;
        return {
          lookId,
          label: asDisplayString(entry.label, 40) ?? lookId,
          cards: lookCards,
          missingPieceCodes: Array.isArray(entry.missingPieceCodes)
            ? entry.missingPieceCodes
              .filter((code): code is string => typeof code === 'string')
              .slice(0, 4)
            : [],
        };
      })
      .filter((look): look is ConciergeLookGroup => look !== null)
    : [];

  // Every card was dropped as unrenderable and no focus survived: there is
  // nothing honest left to show, so fall back to prose rather than an empty
  // "From your Closet" heading over nothing.
  if (!cards.length && !focusCard) return EMPTY_CONCIERGE_RESULT;

  const rawAmbiguity = (metadata as Record<string, unknown>).focusAmbiguity;
  const rawGap = (metadata as Record<string, unknown>).wardrobeGap;

  return {
    presentation: mode,
    focusCard,
    cards,
    looks,
    focusAmbiguous: isRecord(rawAmbiguity) && rawAmbiguity.ambiguous === true,
    focusAmbiguousCategory: isRecord(rawAmbiguity)
      ? asDisplayString(rawAmbiguity.sharedCategory, 60)
      : null,
    // Defaults to false: an older payload that cannot say whether its evidence
    // was exhaustive must be treated as though it was not.
    gapEvidenceIsExhaustive: isRecord(rawGap) && rawGap.evidenceIsExhaustive === true,
    gapCodes:
      isRecord(rawGap) && Array.isArray(rawGap.gapCodes)
        ? rawGap.gapCodes.filter((code): code is string => typeof code === 'string').slice(0, 6)
        : [],
  };
}
