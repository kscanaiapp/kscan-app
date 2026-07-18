/**
 * Scan Identification contract (KS-REL-008C).
 *
 * Shared request/response shape for the app-side fashion identification API
 * (Supabase Edge Function `scan-identify`). This contract is intentionally
 * image-agnostic at the attribute level so TextScan can later return the same
 * `FashionAttributes` shape from a text query instead of an image.
 *
 * `recommendedProducts` carries live commerce results. `similarityMatches`
 * carries deterministic catalog matches from the backend. Arrays are empty
 * when the backend has no usable matches.
 */

export type FashionIdentificationStatus =
  | 'completed'
  | 'non_fashion'
  | 'failed';

/**
 * Fashion-only attributes. Must NOT contain image-specific fields so the shape
 * stays reusable for future TextScan (text → same attributes).
 *
 * Identity, biometric, and demographic traits are never part of this contract.
 */
export type FashionAttributes = {
  category?: string;
  itemType?: string;
  silhouette?: string;
  colorPalette?: string[];
  materialEstimate?: string;
  pattern?: string;
  texture?: string;
  styleTags?: string[];
  occasion?: string;
  confidenceScore?: number;
};

export type ScanIdentifyRequest = {
  mode?: 'image' | 'text';
  imageBase64?: string;
  textQuery?: string;
  source: string;
  localPrivacyFiltered?: boolean;
  multiItemDetection?: boolean;
  requestMode?: 'multi_item_detection' | 'selected_item';
  scanSessionId?: string;
  imageDigestPrefix?: string;
  selectedCandidate?: SelectedGarmentTarget;
  clientTimestamp: string;
};

export type GarmentBounds = {
  /** Normalized 0..1 coordinates relative to the parent scan image. */
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SelectedGarmentTarget = {
  candidateId: string;
  category: string;
  subtype?: string;
  bounds?: GarmentBounds;
};

/**
 * Rich fashion identification output from the backend prompt upgrade.
 * Added as an optional backward-compatible field on ScanIdentifyResponse.
 */
export type DetailedIdentification = {
  visual_observation?: string;
  item_type?: string;
  subtype?: string;
  primary_color?: string;
  secondary_colors?: string[];
  pattern?: string;
  material_estimate?: string;
  silhouette?: string;
  fit?: string;
  length?: string;
  sleeve_length?: string;
  neckline_or_lapel?: string;
  closure?: string;
  distinctive_features?: string[];
  style_tags?: string[];
  occasion_tags?: string[];
  visible_brand_text?: string | null;
  logo_detected?: boolean;
  brand_guess?: string | null;
  confidence_score?: number;
  search_queries?: string[];
  non_fashion?: boolean;
  styling_suggestions?: string[];
  scan_quality_note?: string | null;
};

export type DisplayResult = {
  headline?: string;
  details?: string;
  styling?: string[];
  confidenceLabel?: string;
};

export type DetectedGarmentCandidate = {
  candidateId: string;
  order: number;
  label: string;
  category: string;
  subtype: string;
  bounds?: GarmentBounds;
  confidenceScore?: number;
  attributes?: FashionAttributes;
  identification?: DetailedIdentification;
};

export type ScanIdentifyResponse = {
  scanId?: string;
  scanSessionId?: string;
  imageDigestPrefix?: string;
  status: FashionIdentificationStatus;
  attributes?: FashionAttributes;
  /** Rich identification fields (Day-1 prompt upgrade). Optional for backward compat. */
  identification?: DetailedIdentification;
  /** Live commerce product matches (provider results). */
  recommendedProducts: RankedScanProduct[];
  /** Catalog similarity matches scored deterministically from product_catalog. */
  similarityMatches?: RankedScanProduct[];
  detectedGarments?: DetectedGarmentCandidate[];
  userMessage?: string;
  /** Display result for seller/demo views; not integrated into ProductShelf. */
  displayResult?: DisplayResult;
};

export type MatchConfidenceTier =
  | 'exact_candidate'
  | 'closest_match'
  | 'similar_style'
  | 'discovery_fallback';

export type NormalizedIdentification = Partial<DetailedIdentification> & {
  canonicalCategory: string;
  canonicalColor: string;
  canonicalMaterial: string;
  canonicalSilhouette: string;
  normalizedFeatures: string[];
  normalizedStyleTags: string[];
  normalizedSearchQueries: string[];
};

export type RankedScanProduct = Record<string, unknown> & {
  id?: string;
  name?: string;
  title?: string;
  displayName?: string;
  matchScore?: number;
  similarityPercentage?: number;
  confidenceTier?: MatchConfidenceTier;
  matchReasons?: Record<string, number | boolean | string>;
};
