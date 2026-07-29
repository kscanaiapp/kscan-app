// Private Dressing Room outfit compositions (Build 3: Dressing Rooms V1, Phase 2).
//
// DOMAIN SPLIT. Phase 1 gave the private workspace a SESSION — the styling task:
// which garment the user is building around, and for what occasion. This file
// adds the second half: the OUTFIT ALTERNATIVES generated from that task.
//
//     session      = what the user asked for
//     composition  = what we worked out from it
//
// They are stored separately because they have different lifetimes and different
// failure modes. A session survives a corrupt composition; a composition is
// worthless without the session that produced it. Merging them would mean a
// damaged outfit list could cost the user their anchor and occasion too.
//
// REFERENCES, NEVER COPIES. A composed look stores `closetItemId` and a slot,
// and nothing else. Title, brand, colour, material, size and image all stay in
// the Build 2 Closet and resolve live through
// services/closetItemProjection.ts. The Closet answers "what do I own"; the
// Dressing Room answers "how do these go together" — and a composition that
// duplicated garment metadata would be a second, silently stale answer to the
// first question the moment the user edits or deletes an item.
//
// NOT IN THIS DOMAIN, by construction: Saved Looks, commerce, retailers,
// affiliate links, swap history, comparison state, Elise conversation. Phase 3
// owns swaps and comparison; later phases own Saved Looks and commerce. None of
// them may be represented here, even as a null placeholder.

export const PRIVATE_COMPOSITION_SCHEMA_VERSION = 1 as const;

/** The highest schema version this build can interpret. Above it: refuse. */
export const PRIVATE_COMPOSITION_MAX_SUPPORTED_SCHEMA_VERSION = 1;

/**
 * The composer's behavioural version.
 *
 * Distinct from `schemaVersion`: the schema describes what is on disk, this
 * describes the ALGORITHM that produced it. Changing scoring without changing
 * the stored shape still has to invalidate old compositions, and this is what
 * makes that expressible — it participates in the input fingerprint below.
 */
export const PRIVATE_COMPOSER_VERSION = 1 as const;

// ── Slots ────────────────────────────────────────────────────────────────────

/**
 * The garment roles a look can fill.
 *
 * Deliberately smaller than the free-tier bucket set
 * (services/free-tier/outfitGenerator.ts also has `bag` and `other`): a bag is
 * not a garment role this workspace composes around in Phase 2, and `other` is
 * an admission that classification failed rather than a slot an outfit can
 * occupy. Items that classify to neither are excluded from composition instead
 * of being placed somewhere plausible-looking.
 */
export const PRIVATE_SLOTS = [
  'top',
  'bottom',
  'dress',
  'outerwear',
  'footwear',
  'accessory',
] as const;

export type PrivateDressingRoomSlot = (typeof PRIVATE_SLOTS)[number];

/**
 * Slots a structurally complete look must fill.
 *
 * Two shapes are complete, and they are alternatives rather than a hierarchy:
 * separates (top + bottom + footwear) or a one-piece (dress + footwear).
 * Outerwear and accessory are genuinely optional — a look without a coat is not
 * an incomplete look, and treating it as one would report a missing slot that
 * the user has no reason to fill.
 */
export const PRIVATE_CORE_SLOT_SETS: readonly (readonly PrivateDressingRoomSlot[])[] =
  Object.freeze([
    Object.freeze(['top', 'bottom', 'footwear'] as PrivateDressingRoomSlot[]),
    Object.freeze(['dress', 'footwear'] as PrivateDressingRoomSlot[]),
  ]);

export const PRIVATE_OPTIONAL_SLOTS: readonly PrivateDressingRoomSlot[] = Object.freeze([
  'outerwear',
  'accessory',
]);

/** Display order for a look's contents. Layer outward, then feet, then extras. */
export const PRIVATE_SLOT_DISPLAY_ORDER: readonly PrivateDressingRoomSlot[] = Object.freeze([
  'outerwear',
  'top',
  'dress',
  'bottom',
  'footwear',
  'accessory',
]);

/** User-facing slot names. Announced BEFORE the garment name, for screen readers. */
export const PRIVATE_SLOT_LABELS: Readonly<Record<PrivateDressingRoomSlot, string>> = Object.freeze({
  top: 'Top',
  bottom: 'Bottom',
  dress: 'Dress',
  outerwear: 'Outerwear',
  footwear: 'Shoes',
  accessory: 'Accessory',
});

export function isPrivateSlot(value: unknown): value is PrivateDressingRoomSlot {
  return typeof value === 'string' && (PRIVATE_SLOTS as readonly string[]).includes(value);
}

// ── Occasion formality groups ────────────────────────────────────────────────

/**
 * Soft formality groups. A RANKING HINT, never a rule.
 *
 * Phase 2 deliberately imposes no dress codes: "work requires closed-toe shoes"
 * and "dinner requires a dress" are opinions this product has not earned and
 * that no repository rule supports. An occasion nudges ordering; it never makes
 * a structurally valid outfit ineligible.
 */
export const PRIVATE_OCCASION_GROUPS = [
  'casual',
  'smart_casual',
  'work',
  'evening',
  'travel',
  'neutral',
] as const;

export type PrivateOccasionGroup = (typeof PRIVATE_OCCASION_GROUPS)[number];

// ── Look labels ──────────────────────────────────────────────────────────────

/**
 * Bounded label codes. Presentation derives the user-facing string, so the
 * stored record carries no copy that would have to be migrated to reword it.
 */
export const PRIVATE_LOOK_LABEL_CODES = [
  'NO_PURCHASE_NEEDED',
  'PARTIAL_LOOK',
  'MORE_CASUAL',
  'MORE_POLISHED',
  'EVENING_OPTION',
  'NEUTRAL_OPTION',
] as const;

export type PrivateDressingRoomLookLabelCode = (typeof PRIVATE_LOOK_LABEL_CODES)[number];

export function isPrivateLookLabelCode(
  value: unknown,
): value is PrivateDressingRoomLookLabelCode {
  return (
    typeof value === 'string' && (PRIVATE_LOOK_LABEL_CODES as readonly string[]).includes(value)
  );
}

// ── Records ──────────────────────────────────────────────────────────────────

/** One garment in one look. A reference and a role — nothing else. */
export type PrivateDressingRoomOutfitItem = {
  slot: PrivateDressingRoomSlot;
  closetItemId: string;
};

export type PrivateLookCompleteness = 'complete' | 'partial';

export type PrivateDressingRoomLookOption = {
  lookId: string;
  sessionId: string;
  items: PrivateDressingRoomOutfitItem[];
  completeness: PrivateLookCompleteness;
  /** Truthful, and only ever populated on a partial look. */
  missingSlots: PrivateDressingRoomSlot[];
  labelCodes: PrivateDressingRoomLookLabelCode[];
  /** 0-based presentation order. Unique within a set. */
  rank: number;
};

export type PrivateDressingRoomCompositionSet = {
  compositionId: string;
  actorId: string | null;
  sessionId: string;
  /**
   * Binds this composition to the exact session context that produced it. When
   * it stops matching, the composition is stale and must not be displayed —
   * which is what makes anchor/occasion changes safe WITHOUT a cross-file
   * transaction. See buildCompositionFingerprint.
   */
  inputFingerprint: string;
  composerVersion: typeof PRIVATE_COMPOSER_VERSION;
  activeLookId: string | null;
  looks: PrivateDressingRoomLookOption[];
  createdAt: string;
  updatedAt: string;
  schemaVersion: typeof PRIVATE_COMPOSITION_SCHEMA_VERSION;
};

/** The complete persisted key set. Reconstruction is allowlisted against this. */
export const PRIVATE_COMPOSITION_FIELDS = Object.freeze([
  'compositionId',
  'actorId',
  'sessionId',
  'inputFingerprint',
  'composerVersion',
  'activeLookId',
  'looks',
  'createdAt',
  'updatedAt',
  'schemaVersion',
]);

export const PRIVATE_LOOK_FIELDS = Object.freeze([
  'lookId',
  'sessionId',
  'items',
  'completeness',
  'missingSlots',
  'labelCodes',
  'rank',
]);

export const PRIVATE_OUTFIT_ITEM_FIELDS = Object.freeze(['slot', 'closetItemId']);

/** Bounds. Ids match the Closet projection's 200-char ceiling. */
export const PRIVATE_COMPOSITION_BOUNDS = Object.freeze({
  compositionId: 200,
  sessionId: 200,
  lookId: 200,
  actorId: 200,
  closetItemId: 200,
  /**
   * Generous, because the fingerprint is a CANONICAL STRING rather than a hash.
   * The repository's only sync hash (services/free-tier/itemNormalization.ts
   * #stableHash) is a module-private 32-bit djb2, and a 32-bit digest of
   * security-relevant context — the actor id participates — can collide. A
   * canonical string cannot, needs no dependency, and is readable in a bug
   * report. Nothing is stored here that the record does not already hold.
   */
  inputFingerprint: 1200,
  /** A look may not exceed one garment per slot. */
  itemsPerLook: PRIVATE_SLOTS.length,
  maxLooks: 3,
  minLooks: 1,
});

// ── Failure codes ────────────────────────────────────────────────────────────

/** Why a stored composition could not be produced. Typed, never an exception. */
export type PrivateCompositionErrorCode =
  | 'composition_store_unreadable'
  | 'composition_store_future_schema'
  | 'composition_store_corrupt'
  | 'composition_persist_failed'
  | 'composition_stale'
  | 'missing_actor_context'
  | 'stale_actor_context';

/** Why the composer produced no looks. Serializable; never a raw error. */
export const PRIVATE_COMPOSER_CODES = [
  'SUCCESS',
  'SUCCESS_PARTIAL',
  'CLOSET_EMPTY',
  'CLOSET_LOAD_FAILED',
  'SESSION_CONTEXT_REQUIRED',
  'ANCHOR_MISSING',
  'UNSUPPORTED_ANCHOR',
  'INSUFFICIENT_ITEMS',
  'ACTOR_CHANGED',
  'INVALID_INPUT',
] as const;

export type PrivateComposerCode = (typeof PRIVATE_COMPOSER_CODES)[number];
