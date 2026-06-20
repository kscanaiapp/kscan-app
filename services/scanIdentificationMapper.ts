/**
 * Maps a normalized {@link ScanIdentifyResponse} into the legacy analysis state
 * shape already consumed by the Scan UI (`app.js` / `AnalysisCard` via
 * `hooks/useKScan`). This keeps the new backend path drop-in compatible with the
 * existing result UI — no UI rewrite required.
 *
 * Output shapes (match `services/api.js` `analyzeImage`):
 *   completed    → { type: 'fashion', result, metadata, products: [] }
 *   non_fashion  → { type: 'non-fashion', message }
 *   failed       → throws a user-safe error (caught by useKScan → error state)
 *
 * Product matching is deferred: `products` is always []. No retailer data,
 * prices, or match scores are produced.
 */

import type { ScanIdentifyResponse, FashionAttributes } from '../types/scanIdentification';

export type MappedScanMetadata = {
  category: string;
  color: string;
  silhouette: string;
  itemType?: string;
  material?: string;
  pattern?: string;
  texture?: string;
  occasion?: string;
  styleTags?: string[];
  confidence?: number;
};

export type MappedFashionAnalysis = {
  type: 'fashion';
  result: string;
  metadata: MappedScanMetadata;
  products: [];
};

export type MappedNonFashionAnalysis = {
  type: 'non-fashion';
  message: string;
};

export type MappedScanAnalysis = MappedFashionAnalysis | MappedNonFashionAnalysis;

const DEFAULT_FASHION_SUMMARY = 'Identified a fashion item from your scan.';
const DEFAULT_NON_FASHION_MESSAGE =
  'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';
const DEFAULT_FAILED_MESSAGE =
  "We couldn't complete this scan. Please try again in better light or retake the photo.";

/** Error carrying a user-facing message, matching the contract used by useKScan. */
export function createScanError(userMessage: string): Error & { userMessage: string } {
  const err = new Error('SCAN_IDENTIFY_FAILED') as Error & { userMessage: string };
  err.userMessage = userMessage;
  return err;
}

function buildMetadata(attributes: FashionAttributes | undefined): MappedScanMetadata {
  const a = attributes ?? {};
  const meta: MappedScanMetadata = {
    category: a.category ?? '',
    color: Array.isArray(a.colorPalette) ? a.colorPalette.join(', ') : '',
    silhouette: a.silhouette ?? '',
  };
  if (a.itemType) meta.itemType = a.itemType;
  if (a.materialEstimate) meta.material = a.materialEstimate;
  if (a.pattern) meta.pattern = a.pattern;
  if (a.texture) meta.texture = a.texture;
  if (a.occasion) meta.occasion = a.occasion;
  if (Array.isArray(a.styleTags) && a.styleTags.length) meta.styleTags = a.styleTags;
  if (typeof a.confidenceScore === 'number') meta.confidence = a.confidenceScore;
  return meta;
}

/**
 * Convert a normalized scan-identify response into legacy analysis state.
 * Throws (via {@link createScanError}) on `failed` so the existing useKScan
 * catch path renders the safe error state.
 */
export function mapScanIdentifyToAnalysis(resp: ScanIdentifyResponse): MappedScanAnalysis {
  if (!resp || typeof resp !== 'object') {
    throw createScanError(DEFAULT_FAILED_MESSAGE);
  }

  if (resp.status === 'non_fashion') {
    return {
      type: 'non-fashion',
      message: resp.userMessage?.trim() || DEFAULT_NON_FASHION_MESSAGE,
    };
  }

  if (resp.status === 'completed') {
    return {
      type: 'fashion',
      result: resp.userMessage?.trim() || DEFAULT_FASHION_SUMMARY,
      metadata: buildMetadata(resp.attributes),
      products: [],
    };
  }

  // failed (or unknown) → safe error state.
  throw createScanError(resp.userMessage?.trim() || DEFAULT_FAILED_MESSAGE);
}
