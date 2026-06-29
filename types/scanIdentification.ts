/**
 * Scan Identification contract (KS-REL-008C).
 *
 * Shared request/response shape for the app-side fashion identification API
 * (Supabase Edge Function `scan-identify`). This contract is intentionally
 * image-agnostic at the attribute level so TextScan can later return the same
 * `FashionAttributes` shape from a text query instead of an image.
 *
 * Product matching is deferred: `recommendedProducts` is always `[]` in this
 * slice. No retailer data, prices, or match scores are produced here.
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
  clientTimestamp: string;
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
};

export type ScanIdentifyResponse = {
  scanId?: string;
  status: FashionIdentificationStatus;
  attributes?: FashionAttributes;
  /** Rich identification fields (Day-1 prompt upgrade). Optional for backward compat. */
  identification?: DetailedIdentification;
  /** Always [] in this slice — product matching is deferred. */
  recommendedProducts: [];
  userMessage?: string;
};
