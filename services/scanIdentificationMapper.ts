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
 * In Phase 3A, `products` is the backend `similarityMatches` catalog shelf and
 * `purchaseOptions` is live `recommendedProducts`. Older responses without
 * `similarityMatches` still fall back to `recommendedProducts` as the shelf.
 */

import type { ScanIdentifyResponse, FashionAttributes, DetailedIdentification, RankedScanProduct, DisplayResult } from '../types/scanIdentification';
import type { ScanResultObject } from '../types/scanResultObject';
import { createScanResultObject } from './scanResultObject';
import { buildScanTitle, deriveBrandConfidence, type BrandConfidence } from './scanTitleBuilder';
import {
  buildIdentificationSnapshot,
  buildIdentificationSnapshotV2,
  type PersistedIdentificationSnapshotV1,
  type PersistedIdentificationSnapshotV2,
} from './identificationSnapshot';
import { buildScannerV2Display, type ScannerV2Display } from './scannerV2Display';
import type { FashionIdentificationResultV2 } from '../types/fashionIdentificationV2';
import { SCAN_IDENTITY_DEBUG } from '../constants/build';

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
  /** Optional enriched identity fields used by the title builder. */
  brand?: string | null;
  brandConfidence?: BrandConfidence;
  fit?: string;
  material?: string;
  styleDescriptors?: string[];
  primaryItem?: string;
  displayCategory?: string;
};

export type MappedFashionAnalysis = {
  type: 'fashion';
  result: string;
  metadata: MappedScanMetadata;
  /**
   * Durable versioned identification (IMG-008).
   *
   * `metadata` above is the legacy display shape and necessarily discards
   * subtype, secondary colours, brand evidence, construction details and
   * distinctive features. This carries them through to persistence so a
   * reopened scan can be reconstructed. Built from the response, not from
   * `metadata`, because `metadata` has already lost them.
   */
  identificationSnapshot?: PersistedIdentificationSnapshotV1 | null;
  /**
   * Durable fashion-identification-v2 envelope (Phase 2B.2).
   *
   * Present only when the Scanner V2 path produced a validated result. Legacy
   * Scanner scans and every Elise/StyleChat mapping omit it entirely, which is
   * what keeps a V2 write from ever being fabricated for a legacy operation.
   */
  identificationSnapshotV2?: PersistedIdentificationSnapshotV2 | null;
  /** Catalog similarity matches (legacy ProductShelf / V2 Similar Finds). */
  products: RankedScanProduct[];
  /** Live commerce purchase options when the backend separates them. */
  purchaseOptions?: RankedScanProduct[];
  displayResult?: DisplayResult;
  /** Clean, deterministic display title for the scan result UI. */
  title?: string;
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

  const category = id.item_type ?? a.category ?? '';
  const meta: MappedScanMetadata = {
    category,
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
  // Enriched identity fields for the title builder (all optional, additive).
  meta.primaryItem = id.subtype ?? id.item_type ?? a.itemType ?? category;
  meta.displayCategory = category;
  meta.fit = id.fit ?? undefined;
  meta.material = id.material_estimate ?? a.materialEstimate ?? undefined;
  meta.styleDescriptors = idStyleTags ?? styleTags ?? undefined;
  return meta;
}

/**
 * Overlays a validated V2 identity onto the legacy display metadata.
 *
 * AUTHORITY (Phase 2B.2): when V2 validates, it is the identity. The legacy
 * fields in the same transitional response are a projection of the same
 * normalized result, so they cannot legitimately disagree — but if they ever do,
 * the V2 view wins rather than being silently overwritten by its own projection.
 *
 * Every value arrives through the null-safe display projection, so an absent
 * V2 field becomes an empty string and never the text "null". A field the V2
 * result does not carry leaves the legacy value in place instead of blanking a
 * populated field.
 */
function applyV2Identity(
  metadata: MappedScanMetadata,
  display: ScannerV2Display,
): MappedScanMetadata {
  const next: MappedScanMetadata = { ...metadata };
  if (display.category) next.category = display.category;
  if (display.colorLabel) next.color = display.colorLabel;
  if (display.silhouette.length) next.silhouette = display.silhouette.join(', ');
  if (display.subtype || display.category) {
    next.itemType = display.subtype || display.category;
  }
  if (display.material.length) next.materialEstimate = display.material.join(', ');
  if (display.pattern.length) next.pattern = display.pattern.join(', ');
  if (display.visibleAttributes.length) next.styleTags = display.visibleAttributes;
  // Absent confidence stays absent. Writing 0 would assert certainty of
  // non-match, which is the opposite of "unknown".
  if (display.confidence !== undefined) next.confidenceScore = display.confidence;
  next.primaryItem = display.subtype || display.category || next.primaryItem;
  next.displayCategory = display.category || next.displayCategory;
  if (display.material.length) next.material = display.material.join(', ');
  if (display.visibleAttributes.length) next.styleDescriptors = display.visibleAttributes;
  // A null brand is a real answer, not a missing one: it must not resurrect a
  // legacy brand guess the V2 normalization already rejected.
  next.brand = display.brand || null;
  return next;
}

export type MapScanIdentifyOptions = {
  /**
   * A V2 result that has ALREADY passed `validateScannerV2Response`.
   *
   * Scanner-only. Elise and StyleChat call this mapper with no options and get
   * byte-identical output to today.
   */
  identificationV2?: FashionIdentificationResultV2 | null;
  /** Evidence source, recorded on the V2 snapshot envelope. */
  source?: 'camera' | 'gallery';
  /** Injected so persistence timestamps stay deterministic under test. */
  now?: () => string;
};

/**
 * Convert a normalized scan-identify response into legacy analysis state.
 * Throws (via {@link createScanError}) on `failed` so the existing useKScan
 * catch path renders the safe error state.
 */
export function mapScanIdentifyToAnalysis(
  resp: ScanIdentifyResponse,
  options: MapScanIdentifyOptions = {},
): MappedScanAnalysis {
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
    const hasSimilarityField = Object.prototype.hasOwnProperty.call(resp, 'similarityMatches');
    const similarityMatches = Array.isArray(resp.similarityMatches) ? resp.similarityMatches : [];
    const recommendedProducts = Array.isArray(resp.recommendedProducts) ? resp.recommendedProducts : [];
    const products = hasSimilarityField ? similarityMatches : recommendedProducts;
    const purchaseOptions = hasSimilarityField ? recommendedProducts : undefined;
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.log('[scanIdentificationMapper] mapped products=' + products.length + ' purchaseOptions=' + (purchaseOptions?.length ?? 0));
    }
    let metadata = buildMetadata(resp.attributes, resp.identification);

    // Conservative brand attribution: do not hallucinate brands.
    const geminiBrand = resp.identification?.brand_guess ?? resp.identification?.visible_brand_text ?? null;
    const { brand, confidence: brandConfidence } = deriveBrandConfidence(
      geminiBrand,
      resp.identification?.logo_detected,
      resp.identification?.visible_brand_text,
      recommendedProducts,
    );
    metadata.brand = brand;
    metadata.brandConfidence = brandConfidence;

    // ── V2 authority (Phase 2B.2) ───────────────────────────────────────────
    // Applied AFTER the legacy metadata is fully built, so V2 overwrites the
    // legacy projection rather than the reverse.
    const v2Result = options.identificationV2 ?? null;
    const v2Display = v2Result ? buildScannerV2Display(v2Result) : null;
    if (v2Display) {
      metadata = applyV2Identity(metadata, v2Display);
      // A V2 result with no brand must not keep a confidence describing the
      // legacy brand guess it just replaced. The title builder treats an absent
      // brand as unbranded, so the confidence is dropped rather than downgraded.
      if (!v2Display.brand) metadata.brandConfidence = undefined;
    }

    const title = buildScanTitle({
      rawVisionTitle: result,
      primaryItem: metadata.primaryItem,
      displayCategory: metadata.displayCategory,
      color: metadata.color,
      brand: metadata.brand,
      brandConfidence: metadata.brandConfidence,
      fit: metadata.fit,
      material: metadata.material,
      styleDescriptors: metadata.styleDescriptors,
      recommendedProducts,
    });

    if (SCAN_IDENTITY_DEBUG) {
      console.log('[KSCAN_IDENTITY] titleBuilderLocation=scanIdentificationMapper');
      console.log('[KSCAN_IDENTITY] rawVisionTitle=' + String(result ?? ''));
      console.log('[KSCAN_IDENTITY] normalizedCategory=' + metadata.displayCategory);
      console.log('[KSCAN_IDENTITY] brandCandidate=' + (brand ?? ''));
      console.log('[KSCAN_IDENTITY] brandConfidence=' + brandConfidence);
      console.log('[KSCAN_IDENTITY] finalDisplayTitle=' + title);
    }

    const analysis: MappedFashionAnalysis = {
      type: 'fashion',
      // A V2 result line is preferred only when it actually says something. An
      // empty projection must not blank a usable legacy summary.
      result: (v2Display && v2Display.result) || result,
      title: (v2Display && v2Display.title) || title,
      metadata,
      products,
      // Commerce is UNCHANGED by Phase 2B.2. Purchase options keep coming from
      // the legacy-compatible field, with the same parser, shape, ordering,
      // dedupe and ranking. V2 identity never reinterprets a commerce match,
      // and a commerce match never implies an identity.
      purchaseOptions,
      displayResult: resp.displayResult,
    };

    // Durable identification snapshot (IMG-008). Built from the response so it
    // keeps the fields `metadata` drops. Wrapped for the same reason as below:
    // an enrichment failure must never break the existing analysis contract.
    try {
      analysis.identificationSnapshot = buildIdentificationSnapshot(resp);
    } catch {
      analysis.identificationSnapshot = null;
    }

    // Durable V2 envelope (Phase 2B.2). Written only when a validated V2 result
    // was supplied, so a legacy or Elise mapping never gains this field.
    if (v2Result) {
      try {
        const nowIso = (options.now ?? (() => new Date().toISOString()))();
        analysis.identificationSnapshotV2 = buildIdentificationSnapshotV2({
          identification: v2Result,
          purchaseOptions: purchaseOptions ?? [],
          source: options.source === 'gallery' ? 'gallery' : 'camera',
          createdAt: nowIso,
        });
      } catch {
        analysis.identificationSnapshotV2 = null;
      }
    }

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
