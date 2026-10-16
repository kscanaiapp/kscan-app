/** Portable Scanner commerce evidence contract. No server, model, or provider dependencies. */
import { isNonPublicHost } from '../_shared/net/publicHost.ts';
export const COMMERCE_MATCH_VERSION = 1 as const;
export type CommerceMatchTier = 'exact' | 'same_brand' | 'similar';
export type CommerceMatchMetadata = {
  version: 1;
  tier: CommerceMatchTier;
  listing: { productId: string | null; productUrl: string };
  evidence: {
    brand: { scanned: string | null; product: string | null; source: 'wordmark' | 'logo' | 'none'; productSource: 'provider' | 'title' | 'none'; supported: boolean };
    model: { scanned: string | null; product: string | null; verification: 'verified_product_identity' | 'none' };
    variant: { scanned: string | null; product: string | null; verification: 'verified_product_identity' | 'none' };
    categoryCompatible: boolean;
    subtypeCompatible: boolean;
  };
};
export type CommerceMatchContext = {
  brandEvidence: { brand: string | null; verified: boolean; source: 'wordmark' | 'logo' | 'none' };
  categoryCompatible: boolean;
  subtypeCompatible: boolean;
  /** Never populate from a model hypothesis, model confidence, title, or score. */
  exactIdentity?: { source: 'verified_product_identity'; scanModel: string; productModel: string; scanVariant: string; productVariant: string };
};
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {};
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() && value.length <= 160 && !/[\u0000-\u001f]/.test(value) ? value.replace(/\s+/g, ' ').trim() : null;
const key = (value: string | null): string => (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const agrees = (a: string | null, b: string | null): boolean => !!key(a) && key(a) === key(b);
function destination(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || isNonPublicHost(url.hostname) || (url.port && url.port !== '443')) return null;
    const intermediary = ['google.com', 'google.co.uk', 'googleadservices.com', 'googleusercontent.com', 'shopping.google.com', 'bing.com', 'duckduckgo.com', 'search.yahoo.com'];
    if (intermediary.some(host => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    for (const name of url.searchParams.keys()) {
      if (/^(token|access_token|api_?key|secret|signature|sig|x-amz-|x-goog-)/i.test(name)) return null;
    }
    return url.href;
  } catch { return null; }
}
function listingOf(product: RecordValue) {
  return { productId: text(product.id) ?? text(product.productId), productUrl: destination(product.productUrl ?? product.product_url ?? product.purchaseUrl ?? product.url ?? product.link) };
}
function distinctiveModel(model: string | null, brand: string | null): boolean {
  const brandTokens = new Set(key(brand).split(' '));
  const generic = new Set(['sneaker', 'sneakers', 'shoe', 'shoes', 'boot', 'boots', 'jacket', 'dress', 'bag', 'handbag', 'top', 'pants', 'sunglasses', 'burgundy', 'black', 'white', 'red', 'blue', 'suede', 'leather', 'classic']);
  return key(model).split(' ').some(token => token && !brandTokens.has(token) && !generic.has(token));
}
function tierFor(evidence: CommerceMatchMetadata['evidence']): CommerceMatchTier {
  const brand = evidence.brand;
  const sameBrand = brand.supported && brand.source !== 'none' && brand.productSource !== 'none' && agrees(brand.scanned, brand.product);
  const compatible = evidence.categoryCompatible && evidence.subtypeCompatible;
  if (!sameBrand || !compatible) return 'similar';
  const { model, variant } = evidence;
  return model.verification === 'verified_product_identity' && variant.verification === 'verified_product_identity' &&
    agrees(model.scanned, model.product) && distinctiveModel(model.scanned, brand.scanned) &&
    agrees(variant.scanned, variant.product) ? 'exact' : 'same_brand';
}

/** Validate metadata again after response mapping or saved-result hydration. Unknown/legacy claims confer no tier. */
export function normalizeCommerceMatchMetadata(value: unknown, product?: RecordValue): CommerceMatchMetadata | null {
  const src = record(value);
  if (src.version !== COMMERCE_MATCH_VERSION || !['exact', 'same_brand', 'similar'].includes(String(src.tier))) return null;
  const bound = record(src.listing);
  const productUrl = destination(bound.productUrl);
  const productId = text(bound.productId);
  if (!productUrl) return null;
  if (product) {
    const actual = listingOf(product);
    if (actual.productUrl !== productUrl || (productId && actual.productId && productId !== actual.productId)) return null;
  }
  const raw = record(src.evidence);
  const brand = record(raw.brand), model = record(raw.model), variant = record(raw.variant);
  const evidence: CommerceMatchMetadata['evidence'] = {
    brand: { scanned: text(brand.scanned), product: text(brand.product), source: brand.source === 'wordmark' || brand.source === 'logo' ? brand.source : 'none', productSource: brand.productSource === 'provider' || brand.productSource === 'title' ? brand.productSource : 'none', supported: brand.supported === true },
    model: { scanned: text(model.scanned), product: text(model.product), verification: model.verification === 'verified_product_identity' ? model.verification : 'none' },
    variant: { scanned: text(variant.scanned), product: text(variant.product), verification: variant.verification === 'verified_product_identity' ? variant.verification : 'none' },
    categoryCompatible: raw.categoryCompatible === true,
    subtypeCompatible: raw.subtypeCompatible === true,
  };
  // A current provider brand contradiction invalidates an otherwise copied or
  // stale assertion. Retailer/source names are deliberately never consulted.
  if (product && text(product.brand) && !agrees(text(product.brand), evidence.brand.product)) evidence.brand.supported = false;
  return { version: COMMERCE_MATCH_VERSION, tier: tierFor(evidence), listing: { productId, productUrl }, evidence };
}

/** Backend classification from existing supported brand and explicit compatibility checks. */
export function classifyCommerceMatch(product: RecordValue, context: CommerceMatchContext): CommerceMatchMetadata | null {
  const listing = listingOf(product);
  if (!listing.productUrl) return null;
  const scanned = text(context.brandEvidence.brand);
  const providerBrand = text(product.brand);
  const title = key(text(product.title));
  const scannedKey = key(scanned);
  const titleAgrees = !!scannedKey && ` ${title} `.includes(` ${scannedKey} `) &&
    !/\b(alternative to|inspired by|similar to|style of|dupe|inspired)\b/.test(title);
  const productBrand = providerBrand ?? (titleAgrees ? scanned : null);
  const proof = context.exactIdentity?.source === 'verified_product_identity' ? context.exactIdentity : null;
  return normalizeCommerceMatchMetadata({
    version: COMMERCE_MATCH_VERSION, tier: 'similar', listing,
    evidence: {
      brand: { scanned, product: productBrand, source: context.brandEvidence.source, productSource: providerBrand ? 'provider' : titleAgrees ? 'title' : 'none', supported: context.brandEvidence.verified },
      model: { scanned: proof?.scanModel ?? null, product: proof?.productModel ?? null, verification: proof ? 'verified_product_identity' : 'none' },
      variant: { scanned: proof?.scanVariant ?? null, product: proof?.productVariant ?? null, verification: proof ? 'verified_product_identity' : 'none' },
      categoryCompatible: context.categoryCompatible, subtypeCompatible: context.subtypeCompatible,
    },
  }, product);
}

export function commerceMatchLabel(value: unknown, product?: RecordValue): string {
  const tier = normalizeCommerceMatchMetadata(value, product)?.tier ?? 'similar';
  return tier === 'exact' ? 'Exact Match' : tier === 'same_brand' ? 'Same Brand Alternatives' : 'Similar Styles';
}
