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

export type ScanIdentifyResponse = {
  scanId?: string;
  status: FashionIdentificationStatus;
  attributes?: FashionAttributes;
  /** Always [] in this slice — product matching is deferred. */
  recommendedProducts: [];
  userMessage?: string;
};
