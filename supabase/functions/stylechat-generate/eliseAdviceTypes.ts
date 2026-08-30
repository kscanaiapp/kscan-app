/**
 * E-4 Closet-Aware Styling Intelligence — shared types.
 * Deterministic contracts only; no client ownership claims.
 */

export const ELISE_ADVICE_CONTRACT_VERSION = 'elise_advice_v1';

/**
 * Build 34 / K+ Wardrobe Concierge V1 (C1).
 *
 * ADDITIVE successor to v1, not a replacement. v2 carries everything v1 did,
 * byte-identically, plus the display facts and the wardrobe-context signal the
 * customer-visible Concierge surface needs. A v1 client that receives a v2
 * payload keeps working: every v2-only field is optional to it, and the prose
 * remains authoritative for anyone who ignores the metadata entirely.
 *
 * The version is emitted as v2 ONLY when the Concierge capability is on for the
 * request. Flag off → the payload is byte-identical to the pre-Concierge one,
 * including its `elise_advice_v1` stamp.
 */
export const ELISE_ADVICE_CONTRACT_VERSION_V2 = 'elise_advice_v2';

export type EliseAdviceContractVersion =
  | typeof ELISE_ADVICE_CONTRACT_VERSION
  | typeof ELISE_ADVICE_CONTRACT_VERSION_V2;

export const ELISE_ADVICE_LIMITS = {
  /** Max rows fetched per source before ranking. */
  initialCandidatesPerSource: 40,
  /** Max candidates after merge before scoring prune. */
  rankedCandidates: 24,
  /** Final grounded shortlist entering the prompt. */
  groundedShortlist: 10,
  /** Max looks for multi-look generation. */
  multiLookCount: 3,
  /** Max reason/warning codes per score. */
  maxReasonCodes: 8,
  /**
   * Max DISTINCT category rows returned by the deterministic Closet census.
   * The census counts rows in the database and returns only (category, count)
   * pairs, so this bounds the census RESULT, never the Closet it describes --
   * that is the whole point of it (section 27: a bounded sample must never be
   * spoken about as if it were the whole Closet).
   */
  censusCategories: 40,
} as const;

export type EliseAdviceIntent =
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

export type EliseWardrobeSourceType =
  | 'closet'
  | 'saved_scan'
  | 'recent_scan'
  | 'owned_room'
  | 'shared_room'
  | 'saved_product'
  | 'commerce_product'
  | 'inspiration'
  | 'focused_scan';

export type EliseActorRelationship =
  | 'owned'
  | 'saved'
  | 'scanned'
  | 'shared'
  | 'discovered'
  | 'unverified'
  | 'unknown';

export type EliseRecommendationRole =
  | 'primary'
  | 'alternative'
  | 'layer'
  | 'shoe'
  | 'accessory'
  | 'substitute'
  | 'gap';

export interface EliseWardrobeCandidate {
  candidateId: string;
  sourceType: EliseWardrobeSourceType;
  actorRelationship: EliseActorRelationship;
  title: string | null;
  category: string | null;
  subcategory: string | null;
  colors: string[];
  colorFamilies: string[];
  materials: string[];
  textures: string[];
  patterns: string[];
  silhouette: string | null;
  fit: string | null;
  proportionRole: string | null;
  layeringRole: string | null;
  formality: string | null;
  seasons: string[];
  occasions: string[];
  styleAttributes: string[];
  brand: string | null;
  confidence: number | null;
  canonicalResourceIds: {
    itemId?: string;
    scanId?: string;
    roomId?: string;
    productId?: string;
    inspirationId?: string;
  };
}

export interface EliseCompatibilityScore {
  total: number;
  dimensions: {
    categoryRole: number;
    colorHarmony: number;
    silhouetteBalance: number;
    materialTexture: number;
    formality: number;
    season: number;
    occasion: number;
    signatureStyle: number;
    ownershipPriority: number;
    redundancyPenalty: number;
  };
  reasons: string[];
  warnings: string[];
}

export interface EliseScoredCandidate {
  candidate: EliseWardrobeCandidate;
  score: EliseCompatibilityScore;
  recommendationRole: EliseRecommendationRole;
}

export interface EliseFocusedItem {
  evidenceId: string | null;
  actorRelationship: EliseActorRelationship;
  candidate: EliseWardrobeCandidate | null;
  resolution:
    | 'explicit_selected'
    | 'focused_evidence'
    | 'current_scan'
    | 'referenced_saved'
    | 'recent_evidence'
    /** C2 section 20: a text phrase matched exactly one owned Closet item. */
    | 'closet_text_match'
    /**
     * C2 section 21: a text phrase matched several credible owned items and the
     * resolver deliberately declined to pick one. `candidate` is null in this
     * state -- there is no resolved item -- and `ambiguousCandidates` carries
     * the tie so the answer can reason at category level honestly.
     */
    | 'closet_text_ambiguous'
    | 'none';
  /** Populated only for `closet_text_ambiguous`. Bounded. */
  ambiguousCandidates?: EliseWardrobeCandidate[];
  /** Shared category of the tie, when the tied items agree on one. */
  ambiguousSharedCategory?: string | null;
}

export interface EliseWardrobeGap {
  gapCodes: string[];
  categories: string[];
  partialInventory: boolean;
  notes: string[];
  /**
   * C2 section 27. True only when a gap claim rests on an EXHAUSTIVE census of
   * the authoritative Closet. False means the evidence was bounded, and the
   * prompt/UI must scope the language rather than assert "you don't own X".
   */
  evidenceIsExhaustive?: boolean;
  /**
   * Categories the census PROVED are absent from the whole Closet. Only ever
   * populated when `evidenceIsExhaustive` is true.
   */
  confirmedAbsentCategories?: string[];
}

export type ElisePurchaseAdvice = {
  verdict: 'buy' | 'skip' | 'consider' | 'replace';
  confidence: number;
  reasons: string[];
};

/**
 * C1 section 16 -- the minimum facts a client needs to DISPLAY a validated
 * wardrobe item without parsing prose.
 *
 * Every field here originates from server-authorized evidence that already
 * passed actor scoping in retrieval. The model never authors these values: the
 * pipeline copies them off the same EliseWardrobeCandidate the deterministic
 * scorer ranked. `clientId` is the canonical resource id the client resolves a
 * local image from -- it is the id the app already stores, not a new handle.
 */
export interface EliseAdviceDisplayFacts {
  title: string | null;
  category: string | null;
  subtype: string | null;
  brand: string | null;
  primaryColor: string | null;
  clientId: string | null;
}

/**
 * C1 section 17 -- did AUTHORITATIVE wardrobe evidence actually participate in
 * this turn?
 *
 * K+ being active is NOT the same question. A K+ user asking "what's the
 * weather in Paris?" must not get Closet presentation, so the client gates the
 * Concierge surface on this signal rather than on entitlement.
 *
 *   none   -- no authoritative wardrobe evidence reached the answer
 *   closet -- every represented candidate is owned Closet evidence
 *   mixed  -- owned Closet evidence plus other relationships (saved/scanned/
 *             shared/discovered), which the UI must label individually
 *
 * The boolean the client actually gates on is `mode !== 'none'`; keeping one
 * field rather than two avoids the two drifting apart.
 */
export type EliseWardrobeContextMode = 'none' | 'closet' | 'mixed';

/**
 * C2 sections 26/27 -- deterministic, EXHAUSTIVE category census of the
 * authoritative Closet.
 *
 * This exists to separate two claims the shortlist alone cannot distinguish:
 *
 *   "not in the shortlist"  !=  "not in the Closet"
 *
 * The census is computed by counting rows, not by reading them: no item text
 * reaches the prompt through it, and no sample stands in for the whole. When
 * `exhaustive` is false the pipeline must scope its language ("based on the
 * pieces I reviewed") instead of asserting absence.
 */
export interface EliseClosetCensus {
  /** True only when this census counted the WHOLE Closet, not a bounded page. */
  exhaustive: boolean;
  totalItems: number;
  /** category -> row count. Categories only; never titles, brands or colors. */
  countsByCategory: Record<string, number>;
  /** layering role -> row count, derived from category via the shared mapper. */
  countsByLayeringRole: Record<string, number>;
}

export interface EliseAdviceLook {
  lookId: string;
  label: string;
  candidateIds: string[];
  missingPieceCodes: string[];
}

export interface EliseAdviceOutput {
  text: string;
  adviceIntent: EliseAdviceIntent;
  focusedItem: {
    evidenceId: string | null;
    actorRelationship: string;
    /** v2 (Concierge) only. Absent on v1 payloads and when no item resolved. */
    displayFacts?: EliseAdviceDisplayFacts;
  };
  recommendations: Array<{
    candidateId: string;
    sourceType: string;
    actorRelationship: string;
    recommendationRole: EliseRecommendationRole;
    score: number;
    reasonCodes: string[];
    /** v2 (Concierge) only. Absent on v1 payloads. */
    displayFacts?: EliseAdviceDisplayFacts;
  }>;
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
  /**
   * v2 (Concierge) only. Absent on v1 payloads, which a client must read as
   * 'none' -- never as "unknown, so assume Closet".
   */
  wardrobeContextMode?: EliseWardrobeContextMode;
  /**
   * v2 (Concierge) only. Present when the focus phrase matched more than one
   * credible owned item and the pipeline deliberately did NOT pick one
   * (section 21). The UI uses it to avoid implying a specific item resolved.
   */
  focusAmbiguity?: {
    ambiguous: true;
    /** Candidate ids that tied. Bounded; ids only, never prose. */
    candidateIds: string[];
    /** Shared category the tie collapsed to, when the tied items agree on one. */
    sharedCategory: string | null;
  } | null;
  contractVersion: EliseAdviceContractVersion;
}

export interface EliseAdviceTelemetry {
  adviceIntent: EliseAdviceIntent;
  candidateCountsBySource: Record<string, number>;
  authorizedCount: number;
  rejectedCount: number;
  retrievalLatencyMs: number;
  scoringLatencyMs: number;
  groundedCandidateCount: number;
  ownershipSourceCounts: Record<string, number>;
  purchaseVerdict: string | null;
  wardrobeGapCategoryCode: string | null;
  multiLookCount: number;
  flagState: Record<string, boolean>;
  stableErrorClass: string | null;
  /**
   * C4 section 54 -- aggregate Concierge dimensions only. Every field here is a
   * count, an enum or a bucket; none of them can carry item text, a Closet
   * inventory, a Signature Style, a URI or a storage path.
   */
  wardrobeContextMode?: EliseWardrobeContextMode;
  focusResolutionClass?: string;
  focusAmbiguous?: boolean;
  censusExhaustive?: boolean;
  censusTotalItems?: number;
  lookRoleRepairs?: number;
  ownershipProseConflict?: boolean;
}

export interface EliseAdvicePipelineResult {
  intent: EliseAdviceIntent;
  focused: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
  wardrobeContextMode: EliseWardrobeContextMode;
  census: EliseClosetCensus | null;
  promptBlock: string;
  adviceMetadata: Omit<EliseAdviceOutput, 'text'>;
  telemetry: EliseAdviceTelemetry;
}
