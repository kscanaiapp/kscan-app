/**
 * Maps a normalized {@link ScanIdentifyResponse} into the legacy analysis state
 * shape already consumed by the Scan UI (`app.js` / `AnalysisCard` via
 * `hooks/useKScan`). This keeps the new backend path drop-in compatible with the
 * existing result UI — no UI rewrite required.
 *
 * Output shapes (match `services/api.js` `analyzeImage`):
 *   completed    → { type: 'fashion', result, metadata, products }
 *   non_fashion  → { type: 'non-fashion', message }
 *   failed       → throws a user-safe error (caught by useKScan → error state)
 *
 * `products` is the backend `recommendedProducts` (catalog-ranked candidates)
 * passed straight through, falling back to [] when absent. ProductShelf reads
 * each candidate's image/url/retailer/price fields directly.
 */

import type { ScanIdentifyResponse, FashionAttributes, DetailedIdentification, RankedScanProduct, DisplayResult } from '../types/scanIdentification';
import type { ScanResultObject } from '../types/scanResultObject';
import { createScanResultObject } from './scanResultObject';

export type MappedScanMetadata = {
  category: string;
  color: string;
  silhouette: string;
  itemType?: string;
  materialEstimate?: string;
  pattern?: string;
  texture?: string;
  occasion?: string;
  styleTags?: string[];
  confidenceScore?: number;
  scanQualityNote?: string | null;
  stylingSuggestions?: string[];
};

export type MappedFashionAnalysis = {
  type: 'fashion';
  result: string;
  metadata: MappedScanMetadata;
  /** Catalog similarity matches (legacy ProductShelf / V2 Similar Finds). */
  products: RankedScanProduct[];
  /** Live commerce purchase options when the backend separates them. */
  purchaseOptions?: RankedScanProduct[];
  displayResult?: DisplayResult;
  /**
   * Optional structured Scan Result Object (Part 2 activation). Additive and
   * non-breaking: existing consumers ignore it. Generated from the same
   * identification/attributes/products the mapper already produced — it does NOT
   * change result/metadata/products/displayResult, ranking, or confidence
   * scoring. Degrades safely (omitted) if generation ever fails.
   */
  scanResultObject?: ScanResultObject;
};

export type MappedNonFashionAnalysis = {
  type: 'non-fashion';
  message: string;
};

export type MappedScanAnalysis = MappedFashionAnalysis | MappedNonFashionAnalysis;

const DEFAULT_FASHION_SUMMARY = 'Identified a fashion item from your scan.';
const DEFAULT_NON_FASHION_MESSAGE =
  'This does not appear to be a fashion item. Try scanning clothing, shoes, bags, or accessories.';
// Neutral fallback only. The adapter (normalizeScanIdentifyResponse) already
// resolves the correct cause-specific/neutral message before mapping, so this
// defensive default must not blame lighting or photo quality.
const DEFAULT_FAILED_MESSAGE = "We couldn't complete this scan. Please try again.";

/** Error carrying a user-facing message, matching the contract used by useKScan. */
export function createScanError(userMessage: string): Error & { userMessage: string } {
  const err = new Error('SCAN_IDENTIFY_FAILED') as Error & { userMessage: string };
  err.userMessage = userMessage;
  return err;
}

function buildMetadata(
  attributes: FashionAttributes | undefined,
  identification?: DetailedIdentification,
): MappedScanMetadata {
  const a = attributes ?? {};
  const id = identification ?? {};

  // Prefer identification fields over legacy attributes (Day-1 prompt upgrade).
  let color = '';
  if (id.primary_color) {
    const colors = [id.primary_color];
    if (Array.isArray(id.secondary_colors) && id.secondary_colors.length) {
      colors.push(...id.secondary_colors);
    }
    color = colors.join(', ');
  } else if (Array.isArray(a.colorPalette) && a.colorPalette.length) {
    color = a.colorPalette.join(', ');
  }

  const meta: MappedScanMetadata = {
    category: id.item_type ?? a.category ?? '',
    color,
    silhouette: id.silhouette ?? a.silhouette ?? '',
  };
  if (a.itemType || id.subtype || id.item_type) meta.itemType = id.subtype ?? id.item_type ?? a.itemType;
  if (a.materialEstimate || id.material_estimate) meta.materialEstimate = id.material_estimate ?? a.materialEstimate;
  if (a.pattern || id.pattern) meta.pattern = id.pattern ?? a.pattern;
  if (a.texture) meta.texture = a.texture;
  if (a.occasion || (Array.isArray(id.occasion_tags) && id.occasion_tags.length)) {
    meta.occasion = (id.occasion_tags?.length ? id.occasion_tags[0] : undefined) ?? a.occasion;
  }
  const styleTags = Array.isArray(a.styleTags) && a.styleTags.length ? a.styleTags : undefined;
  const idStyleTags = Array.isArray(id.style_tags) && id.style_tags.length ? id.style_tags : undefined;
  if (styleTags || idStyleTags) meta.styleTags = idStyleTags ?? styleTags;
  const conf = id.confidence_score ?? a.confidenceScore;
  if (typeof conf === 'number') meta.confidenceScore = conf;
  if (typeof id.scan_quality_note === 'string') meta.scanQualityNote = id.scan_quality_note;
  if (Array.isArray(id.styling_suggestions) && id.styling_suggestions.length) {
    meta.stylingSuggestions = id.styling_suggestions;
  }
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
    // Prefer the rich visual_observation for the displayed result string.
    const result =
      resp.identification?.visual_observation?.trim() ??
      resp.userMessage?.trim() ??
      DEFAULT_FASHION_SUMMARY;

    // Phase 3A split: similarityMatches power the catalog shelf; recommendedProducts
    // are live commerce purchase options. For backward compat with an older backend
    // that only returns recommendedProducts, treat that field as the catalog shelf.
    const hasSimilarityField = Array.isArray(resp.similarityMatches);
    const products = hasSimilarityField ? resp.similarityMatches : (resp.recommendedProducts ?? []);
    const purchaseOptions = hasSimilarityField ? resp.recommendedProducts : undefined;
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[scanIdentificationMapper] mapped products=' + products.length + ' purchaseOptions=' + (purchaseOptions?.length ?? 0));
    }
    const analysis: MappedFashionAnalysis = {
      type: 'fashion',
      result,
      metadata: buildMetadata(resp.attributes, resp.identification),
      products,
      purchaseOptions,
      displayResult: resp.displayResult,
    };

    // Additive Part 2 enrichment. Wrapped so a failure here can never break the
    // existing analysis contract — on any error we simply omit the field.
    try {
      analysis.scanResultObject = createScanResultObject({
        scanId: resp.scanId,
        identification: resp.identification,
        attributes: resp.attributes,
        displayResult: resp.displayResult,
        recommendedProducts: products,
      });
    } catch {
      // Degrade safely: keep the existing analysis exactly as-is.
    }

    return analysis;
  }

  // failed (or unknown) → safe error state.
  throw createScanError(resp.userMessage?.trim() || DEFAULT_FAILED_MESSAGE);
}
