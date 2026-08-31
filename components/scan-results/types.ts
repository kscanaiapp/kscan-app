import { buildScanTitle } from '../../services/scanTitleBuilder';
import { SCAN_IDENTITY_DEBUG } from '../../constants/build';
import { SCAN_RESULTS_DEMO_UI_ENABLED } from '../../constants/featureFlags';
import type { OutfitConfirmationCandidate } from '../../services/outfitConfirmation/outfitDetectionBridge';
import { buildVtoGarmentFromCommerceRecord } from '../../services/vto/vtoCommerceGarment';
import type { VtoGarmentInput } from '../../types/vto';

export type ProductMatch = {
  id: string;
  title: string;
  brand?: string;
  retailer?: string;
  imageUrl?: string;
  priceLabel?: string;
  matchPercent?: number;
  productUrl?: string;
};

/**
 * DEF-WL-07 (P1). The watch-relevant identity of the commerce candidate a
 * purchase row was rendered from.
 *
 * PRESENTATION-ONLY, AND DELIBERATELY NOT THE PERSISTED SHAPE. Saved scans
 * write `normalizePurchaseOptions()` output (services/dressingRoomCommerce.ts)
 * into `saved_scans.purchase_options` -- a different type behind a strict field
 * allowlist that has never carried `watchCapability` and still does not. This
 * object is derived at render time from the live analysis record and is thrown
 * away with the view, so Base Commerce persistence is byte/contract unchanged.
 *
 * Adding `watchCapability` to the persisted normalizer instead would let a
 * reopened Recent Scan offer Watch on a listing the server would now refuse --
 * capability is a live property of a listing, not a fact to freeze into a row.
 */
export type WatchCandidate = {
  id?: string;
  title?: string;
  /** Canonical retailer product URL -- the watch's identity. */
  productUrl?: string;
  retailer?: string;
  source?: string;
  price?: string | number | null;
  currency?: string;
  imageUrl?: string;
  type?: 'retail' | 'similar';
  commerceType?: 'retail' | 'resale';
  /** Server-authored (K5-C1). Only 'refreshable_listing' may be watched. */
  watchCapability?: 'refreshable_listing' | 'unsupported';
};

export type PurchaseOption = {
  id: string;
  retailer: string;
  title?: string;
  priceLabel?: string;
  availabilityLabel?: string;
  productUrl?: string;
  /** DEF-WL-07: ephemeral watch identity. Never persisted -- see WatchCandidate. */
  watchCandidate?: WatchCandidate;
  /**
   * VTO-REACH-001: ephemeral try-on identity for THIS row, derived from the
   * same canonical record the row renders from -- so the garment a person
   * tries on is the product they are looking at, not a re-discovered one.
   *
   * Built by the single shared derivation in services/vto/vtoCommerceGarment,
   * the same one components/ProductShelf.tsx uses. Never persisted: the
   * persisted-snapshot normalizer does not carry it, exactly as it does not
   * carry watchCandidate.
   */
  vtoGarment?: VtoGarmentInput | null;
};

/**
 * DEF-WL-07: may this rendered row offer the Watch action?
 *
 * Mirrors ProductShelf's `canWatchProduct` rather than re-deciding: eligibility
 * is server-authored and this surface only reads it. A row whose candidate is
 * missing, unsupported, or has no canonical product URL to identify offers
 * nothing -- a Watch with no URL identity is not a watch on anything.
 */
export function canWatchPurchaseOption(option: PurchaseOption | null | undefined): boolean {
  const candidate = option?.watchCandidate;
  if (!candidate) return false;
  if (candidate.watchCapability !== 'refreshable_listing') return false;
  return typeof candidate.productUrl === 'string' && candidate.productUrl.trim().length > 0;
}

export type ScanResultV2 = {
  id?: string;
  imageUri?: string;
  imageUrl?: string;
  scannedImage?: string;
  capturedImage?: string;
  thumbnail?: string;
  productImage?: string;
  title?: string;
  category?: string;
  color?: string;
  silhouette?: string;
  material?: string;
  pattern?: string;
  confidence?: number;
  matchLabel?: string;
  styleTags?: string[];
  styleAnalysis?: string;
  analysisText?: string;
  similarFinds?: ProductMatch[];
  purchaseOptions?: PurchaseOption[];
};

export type LegacyAnalysisData = {
  result?: string;
  title?: string;
  metadata?: {
    category?: string;
    color?: string;
    silhouette?: string;
    material?: string;
    pattern?: string;
    confidence?: number;
    styleTags?: string[];
    brand?: string | null;
    brandConfidence?: 'high' | 'medium' | 'low';
    fit?: string;
    primaryItem?: string;
    displayCategory?: string;
    styleDescriptors?: string[];
  };
  products?: any[];
  purchaseOptions?: any[];
  confirmationCandidates?: OutfitConfirmationCandidate[];
  secondhand?: any;
  sneakerReference?: any[];
};

function formatPriceLabel(price: unknown, currency?: string | null): string | undefined {
  if (price === null || price === undefined) return undefined;
  if (typeof price === 'number' && Number.isFinite(price) && price > 0) {
    const ccy = String(currency || 'USD').toUpperCase();
    try {
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: ccy }).format(price);
    } catch {
      return `$${price.toFixed(2)}`;
    }
  }
  if (typeof price === 'string') {
    const trimmed = price.trim();
    if (!trimmed || trimmed === '0' || trimmed === '$0.00' || trimmed === '0.00') return undefined;
    return trimmed;
  }
  return undefined;
}

function valueLooksDemo(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const normalized = value.toLowerCase().trim();
  if (!normalized) return false;
  if (normalized.includes('k-scan demo')) return true;
  if (normalized.includes('k scan demo')) return true;
  if (normalized.includes('demo catalog')) return true;
  if (normalized.includes('retail preview')) return true;
  if (normalized.includes('resale preview')) return true;
  if (normalized.includes('marketplace preview')) return true;
  return false;
}

export function isDemoProductMatch(product: ProductMatch): boolean {
  if (!product) return false;
  if (typeof product.id === 'string' && product.id.toLowerCase().startsWith('demo-')) return true;
  return (
    valueLooksDemo(product.retailer) ||
    valueLooksDemo(product.brand) ||
    valueLooksDemo(product.title)
  );
}

export function isDemoPurchaseOption(option: PurchaseOption): boolean {
  if (!option) return false;
  if (typeof option.id === 'string' && option.id.toLowerCase().startsWith('demo-')) return true;
  return valueLooksDemo(option.retailer) || valueLooksDemo(option.title);
}

function availabilityLabel(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.toLowerCase().trim();
  if (v === 'in_stock' || v === 'in stock' || v === 'available') return 'In Stock';
  if (v === 'out_of_stock' || v === 'out of stock' || v === 'sold_out' || v === 'sold out' || v === 'unavailable') {
    return 'Out of Stock';
  }
  return undefined;
}

function productUrlOf(p: Record<string, unknown>): string | undefined {
  for (const key of ['productUrl', 'product_url', 'purchaseUrl', 'purchase_url', 'url', 'link']) {
    const value = p[key];
    if (typeof value === 'string' && value.trim().startsWith('http')) return value.trim();
  }
  return undefined;
}

function imageUrlOf(p: Record<string, unknown>): string | undefined {
  for (const key of ['imageUrl', 'image_url', 'thumbnail', 'thumbnailUrl', 'image_src', 'product_image_url']) {
    const value = p[key];
    if (typeof value === 'string' && value.trim().startsWith('http')) return value.trim();
  }
  return undefined;
}

function titleOf(p: Record<string, unknown>): string {
  return (
    String(p.displayName || p.title || p.name || p.product_name || '').trim() || 'Similar style'
  );
}

function watchCapabilityOf(p: Record<string, unknown>): WatchCandidate['watchCapability'] {
  const value = p.watchCapability ?? p.watch_capability;
  return value === 'refreshable_listing' || value === 'unsupported' ? value : undefined;
}

/**
 * DEF-WL-07: derives the ephemeral watch identity from a raw commerce record.
 * Nothing here is invented -- every field is copied from the candidate, and an
 * absent one stays absent so the eligibility predicate can refuse the row.
 */
function buildWatchCandidate(
  raw: Record<string, unknown>,
  productUrl: string | undefined,
  retailer: string,
): WatchCandidate | undefined {
  const capability = watchCapabilityOf(raw);
  if (!capability) return undefined;
  return {
    id: typeof raw.id === 'string' ? raw.id : undefined,
    title: titleOf(raw),
    productUrl,
    retailer,
    source: typeof raw.source === 'string' ? raw.source : undefined,
    price: (raw.price as string | number | null | undefined) ?? null,
    currency: typeof raw.currency === 'string' ? raw.currency : undefined,
    imageUrl: imageUrlOf(raw),
    type: raw.type === 'retail' || raw.type === 'similar' ? raw.type : undefined,
    commerceType:
      raw.commerceType === 'retail' || raw.commerceType === 'resale' ? raw.commerceType : undefined,
    watchCapability: capability,
  };
}

/**
 * Maps one raw commerce product record (backend `RankedScanProduct` shape)
 * into the render-ready `PurchaseOption` shape. Extracted so a single-item
 * shelf (`legacy.purchaseOptions`) and a per-item Build 32 commerce card can
 * normalize offers identically instead of maintaining two copies of this.
 */
export function mapRawProductToPurchaseOption(
  raw: Record<string, unknown>,
  index = 0,
): PurchaseOption {
  const productUrl = productUrlOf(raw);
  const retailer =
    typeof raw.retailer === 'string'
      ? raw.retailer
      : typeof raw.source === 'string'
      ? raw.source
      : 'Retailer';

  return {
    id: String(raw.id ?? `purchase-${index}`),
    retailer,
    title: titleOf(raw),
    priceLabel: formatPriceLabel(raw.price, typeof raw.currency === 'string' ? raw.currency : undefined),
    availabilityLabel: availabilityLabel(raw.availability),
    productUrl,
    // DEF-WL-07: derived here, from the SAME canonical record this row is
    // rendered from, so the Watch that results carries the retailer/product-URL
    // identity the user is actually looking at. Read straight off the live
    // analysis record -- `watchCapability` is server-authored and survives
    // intact here; it is the persisted normalizer that strips it, which is why
    // this surface must not source eligibility from there.
    watchCandidate: buildWatchCandidate(raw, productUrl, retailer),
    // VTO-REACH-001: derived from the SAME canonical record, by the SAME
    // shared derivation ProductShelf uses. Null when the record carries no
    // stable product reference -- the panel then renders no try-on entry at
    // all, rather than one anchored to nothing.
    vtoGarment: buildVtoGarmentFromCommerceRecord(raw),
  };
}

/** Maps legacy analysis data into the V2 shape for forward-compat rendering. */
export function mapLegacyToV2(
  legacy: LegacyAnalysisData | null | undefined,
  scanImageUri?: string | null
): ScanResultV2 | null {
  if (!legacy) return null;

  const meta = legacy.metadata ?? {};
  const analysisText = legacy.result ?? '';

  // Prefer a title already computed by the mapper; otherwise build one
  // deterministically from the available metadata (no fake brands, no "Match").
  let title = legacy.title;
  if (!title || !title.trim()) {
    title = buildScanTitle({
      rawVisionTitle: analysisText,
      primaryItem: meta.primaryItem ?? meta.category,
      displayCategory: meta.displayCategory ?? meta.category,
      color: meta.color,
      brand: meta.brand,
      brandConfidence: meta.brandConfidence,
      fit: meta.fit,
      material: meta.material,
      styleDescriptors: meta.styleDescriptors ?? meta.styleTags,
      recommendedProducts: legacy.purchaseOptions ?? legacy.products,
    });

    if (SCAN_IDENTITY_DEBUG) {
      console.log('[KSCAN_IDENTITY] titleBuilderLocation=mapLegacyToV2');
      console.log('[KSCAN_IDENTITY] rawVisionTitle=' + analysisText);
      console.log('[KSCAN_IDENTITY] normalizedCategory=' + (meta.displayCategory ?? meta.category ?? ''));
      console.log('[KSCAN_IDENTITY] brandCandidate=' + (meta.brand ?? ''));
      console.log('[KSCAN_IDENTITY] brandConfidence=' + (meta.brandConfidence ?? ''));
      console.log('[KSCAN_IDENTITY] finalDisplayTitle=' + title);
    }
  }

  const similarFinds: ProductMatch[] | undefined = Array.isArray(legacy.products)
    ? legacy.products
      .filter((p) => p && typeof p === 'object')
      .map((p, index) => {
        const product = p as Record<string, unknown>;
        return {
          id: String(product.id ?? `similar-${index}`),
          title: titleOf(product),
          brand: typeof product.brand === 'string' ? product.brand : undefined,
          retailer: typeof product.retailer === 'string'
            ? product.retailer
            : typeof product.source === 'string'
            ? product.source
            : undefined,
          imageUrl: imageUrlOf(product),
          priceLabel: formatPriceLabel(product.price, typeof product.currency === 'string' ? product.currency : undefined),
          matchPercent: typeof product.similarityPercentage === 'number'
            ? product.similarityPercentage
            : typeof product.matchScore === 'number'
            ? Math.round(product.matchScore)
            : undefined,
          productUrl: productUrlOf(product),
        };
      })
      .filter((p) => SCAN_RESULTS_DEMO_UI_ENABLED || !isDemoProductMatch(p))
    : undefined;

  const purchaseOptions: PurchaseOption[] | undefined = Array.isArray(legacy.purchaseOptions)
    ? legacy.purchaseOptions
      .filter((p) => p && typeof p === 'object')
      .map((p, index) => mapRawProductToPurchaseOption(p as Record<string, unknown>, index))
      .filter((p) => SCAN_RESULTS_DEMO_UI_ENABLED || !isDemoPurchaseOption(p))
    : undefined;

  return {
    imageUri: scanImageUri ?? undefined,
    title,
    category: meta.category || undefined,
    color: meta.color || undefined,
    silhouette: meta.silhouette || undefined,
    material: meta.material || undefined,
    pattern: meta.pattern || undefined,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : undefined,
    styleTags: meta.styleTags,
    styleAnalysis: analysisText || undefined,
    analysisText: analysisText || undefined,
    similarFinds: similarFinds && similarFinds.length > 0 ? similarFinds : undefined,
    purchaseOptions: purchaseOptions && purchaseOptions.length > 0 ? purchaseOptions : undefined,
  };
}
