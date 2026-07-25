/**
 * E-4 Closet-Aware Styling Intelligence — shared types.
 * Deterministic contracts only; no client ownership claims.
 */

export const ELISE_ADVICE_CONTRACT_VERSION = 'elise_advice_v1';

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
    | 'none';
}

export interface EliseWardrobeGap {
  gapCodes: string[];
  categories: string[];
  partialInventory: boolean;
  notes: string[];
}

export type ElisePurchaseAdvice = {
  verdict: 'buy' | 'skip' | 'consider' | 'replace';
  confidence: number;
  reasons: string[];
};

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
  };
  recommendations: Array<{
    candidateId: string;
    sourceType: string;
    actorRelationship: string;
    recommendationRole: EliseRecommendationRole;
    score: number;
    reasonCodes: string[];
  }>;
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
  contractVersion: typeof ELISE_ADVICE_CONTRACT_VERSION;
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
}

export interface EliseAdvicePipelineResult {
  intent: EliseAdviceIntent;
  focused: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  purchaseAdvice: ElisePurchaseAdvice | null;
  looks: EliseAdviceLook[] | null;
  promptBlock: string;
  adviceMetadata: Omit<EliseAdviceOutput, 'text'>;
  telemetry: EliseAdviceTelemetry;
}
