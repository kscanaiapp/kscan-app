/**
 * E-4 optional client types for structured advice metadata.
 * Text remains authoritative for installed clients.
 */

export const ELISE_ADVICE_CONTRACT_VERSION = 'elise_advice_v1';

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
  };
  recommendations?: Array<{
    candidateId: string;
    sourceType: string;
    actorRelationship: string;
    recommendationRole: string;
    score: number;
    reasonCodes: string[];
  }>;
  wardrobeGap?: {
    gapCodes: string[];
    categories: string[];
    partialInventory: boolean;
    notes: string[];
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
  contractVersion?: string;
}
