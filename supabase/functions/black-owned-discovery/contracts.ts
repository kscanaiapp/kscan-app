import type { RecommendedProduct } from '../scan-identify/shoppingProvider.ts';
import type { CanonicalCommerce } from '../scan-identify/canonicalCommerce.ts';

export const DISCOVERY_VERSION = 'black-owned-discovery-v1' as const;
export type OwnershipIdentity = {
  brandId: string;
  brandName: string;
  ownershipVerificationStatus: 'verified';
  publicOwnershipLabelAllowed: true;
  verifiedUntil: string;
};
export type DiscoveryProduct = RecommendedProduct & {
  productId: string;
  brandId: string;
  merchantId: string;
  brandName: string;
  type: 'similar';
  matchType: 'similar';
  placementType: 'organic';
  ownershipIdentity?: OwnershipIdentity;
  inventoryVerifiedAt: string;
  relevanceExplanation: string;
  checkoutCapability: 'product_destination';
};
export type DiscoveryResponse = {
  version: typeof DISCOVERY_VERSION;
  status: 'ready' | 'empty' | 'unavailable';
  products: DiscoveryProduct[];
  canonicalCommerce: CanonicalCommerce;
  primaryOwnership: Record<string, OwnershipIdentity>;
  generatedAt: string;
};
export type FashionAttributes = {
  item_type: string;
  subtype?: string;
  primary_color?: string;
  secondary_color?: string;
  material_estimate?: string;
  silhouette?: string;
  pattern?: string;
  distinctive_features?: string[];
};
export type DiscoveryInput = {
  garment: FashionAttributes;
  market: string;
  primaryProducts: { id: string; productUrl?: string }[];
};
export type CatalogRow = {
  id: string; brand_id: string; merchant_id: string; source_product_id: string;
  variant_id: string; title: string; category: string; subtype: string | null;
  attributes: Partial<FashionAttributes>; image_url: string | null; product_url: string;
  price_amount: string | number | null; currency: string | null;
  availability: 'in_stock' | 'out_of_stock' | 'unknown';
  sizes: string[]; markets: string[]; synced_at: string; expires_at: string;
  brand_name: string; verified_until: string; approved_domains: string[]; image_domains: string[];
  eligible_until?: string;
};
export type DiscoveryFlags = { discovery: boolean; badges: boolean; sponsored: boolean };

/** Owner-directed defaults (2026-10-29): organic discovery and badges ON.
 * Explicit false is the independent rollback; malformed values fail closed. */
export function discoveryFlags(env: (key: string) => string | undefined): DiscoveryFlags {
  const organic = env('BLACK_OWNED_DISCOVERY_V1_ENABLED');
  const badges = env('VERIFIED_OWNERSHIP_BADGE_V1_ENABLED');
  return {
    discovery: organic === undefined || organic === 'true',
    badges: badges === undefined || badges === 'true',
    // A separate production-activation implementation and review are required.
    sponsored: false,
  };
}
