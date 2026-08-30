/**
 * E-4 optional client types for structured advice metadata.
 * Text remains authoritative for installed clients.
 */

export const ELISE_ADVICE_CONTRACT_VERSION = 'elise_advice_v1';

/**
 * Build 34 / K+ Wardrobe Concierge V1. ADDITIVE successor to v1.
 *
 * A client must handle BOTH: v1 payloads keep arriving from any backend that
 * predates Concierge or has the capability off, and every v2-only field is
 * therefore optional here. Absence of `wardrobeContextMode` reads as 'none' --
 * never as "unknown, so assume Closet", which would put Closet chrome on an
 * answer that never touched the Closet.
 */
export const ELISE_ADVICE_CONTRACT_VERSION_V2 = 'elise_advice_v2';

/**
 * The facts a client needs to DISPLAY one validated wardrobe item. Server
 * authored, from actor-authorized evidence. Any field may be null: a missing
 * value renders as absent, never as a guess.
 */
export interface EliseAdviceDisplayFactsClient {
  title: string | null;
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  /** Canonical Closet row id. The handle for LOCAL image resolution. */
  clientId: string | null;
}

/**
 * Did authoritative wardrobe evidence take part in THIS turn?
 *
 * Not the same question as "is K+ active". A K+ user asking about the weather
 * gets 'none', and the Concierge surface must stay hidden for it.
 */
export type EliseWardrobeContextModeClient = 'none' | 'closet' | 'mixed';

export type EliseAdviceIntentClient =
  | 'style_current_item'
  | 'build_outfit'
  | 'compare_items'
  | 'find_owned_alternative'
  | 'find_saved_alternative'
  | 'wardrobe_gap'
  | 'purchase_advice'
  | 'occasion_fit'
  | 'color_pairing'
  | 'layering_advice'
  | 'shoe_pairing'
  | 'accessory_pairing'
  | 'seasonal_advice'
  | 'multi_look_generation'
  | 'general_style_advice';

export interface EliseAdviceMetadataClient {
  adviceIntent?: EliseAdviceIntentClient | string;
  focusedItem?: {
    evidenceId: string | null;
    actorRelationship: string;
    /** v2 only. Present when an item actually resolved. */
    displayFacts?: EliseAdviceDisplayFactsClient;
  };
  recommendations?: Array<{
    candidateId: string;
    sourceType: string;
    actorRelationship: string;
    recommendationRole: string;
    score: number;
    reasonCodes: string[];
    /** v2 only. */
    displayFacts?: EliseAdviceDisplayFactsClient;
  }>;
  wardrobeGap?: {
    gapCodes: string[];
    categories: string[];
    partialInventory: boolean;
    notes: string[];
    /** v2 only. False means the UI must not phrase a gap as a certainty. */
    evidenceIsExhaustive?: boolean;
    confirmedAbsentCategories?: string[];
  } | null;
  purchaseAdvice?: {
    verdict: 'buy' | 'skip' | 'consider' | 'replace';
    confidence: number;
    reasons: string[];
  } | null;
  looks?: Array<{
    lookId: string;
    label: string;
    candidateIds: string[];
    missingPieceCodes: string[];
  }> | null;
  /** v2 only. Absent reads as 'none'. */
  wardrobeContextMode?: EliseWardrobeContextModeClient;
  /**
   * v2 only. Present when the focus phrase matched several owned items and the
   * server deliberately declined to pick one -- the UI must not imply that a
   * specific item resolved.
   */
  focusAmbiguity?: {
    ambiguous: true;
    candidateIds: string[];
    sharedCategory: string | null;
  } | null;
  contractVersion?: string;
}
