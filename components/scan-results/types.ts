import { buildScanTitle } from '../../services/scanTitleBuilder';
import { SCAN_IDENTITY_DEBUG } from '../../constants/build';
import { SCAN_RESULTS_DEMO_UI_ENABLED } from '../../constants/featureFlags';
import type { OutfitConfirmationCandidate } from '../../services/outfitConfirmation/outfitDetectionBridge';

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

export type PurchaseOption = {
  id: string;
  retailer: string;
  title?: string;
  priceLabel?: string;
  availabilityLabel?: string;
  productUrl?: string;
};

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
  /** KSB29-037: pattern is part of the contract, not an optional extra. */
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
      .map((p, index) => {
        const product = p as Record<string, unknown>;
        return {
          id: String(product.id ?? `purchase-${index}`),
          retailer:
            typeof product.retailer === 'string'
              ? product.retailer
              : typeof product.source === 'string'
              ? product.source
              : 'Retailer',
          title: titleOf(product),
          priceLabel: formatPriceLabel(product.price, typeof product.currency === 'string' ? product.currency : undefined),
          availabilityLabel: availabilityLabel(product.availability),
          productUrl: productUrlOf(product),
        };
      })
      .filter((p) => SCAN_RESULTS_DEMO_UI_ENABLED || !isDemoPurchaseOption(p))
    : undefined;

  return {
    imageUri: scanImageUri ?? undefined,
    title,
    category: meta.category || undefined,
    color: meta.color || undefined,
    silhouette: meta.silhouette || undefined,
    material: meta.material || undefined,
    // Without this the V2 view model dropped pattern on the way in, so the
    // normalizer's surviving value never reached a chip.
    pattern: meta.pattern || undefined,
    confidence: typeof meta.confidence === 'number' ? meta.confidence : undefined,
    styleTags: meta.styleTags,
    styleAnalysis: analysisText || undefined,
    analysisText: analysisText || undefined,
    similarFinds: similarFinds && similarFinds.length > 0 ? similarFinds : undefined,
    purchaseOptions: purchaseOptions && purchaseOptions.length > 0 ? purchaseOptions : undefined,
  };
}
