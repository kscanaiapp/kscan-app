import type { AuthorizedMerchant, CatalogAdapter, FeedProduct } from './catalog.ts';
import { assertAuthorizedMerchant } from './catalog.ts';
import type { FashionAttributes } from './contracts.ts';

export const SHOPIFY_API_VERSION = '2026-10';
export type ShopifySourceConfig = {
  shopDomain: string;
  privateStorefrontToken: string;
  marketCountry: string;
  /** Explicit merchant-reviewed taxonomy mapping. No category or attributes
   * guessed from Shopify vendor/title/tags, and no AI enrichment. */
  fashionByProductId: Record<string, { category: string; subtype: string; attributes: Partial<FashionAttributes> }>;
};
const QUERY = `query DiscoveryCatalog($after: String, $country: CountryCode!) @inContext(country: $country) {
  products(first: 40, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { id title productType onlineStoreUrl featuredImage { url }
      variants(first: 40) { pageInfo { hasNextPage } nodes {
        id sku availableForSale image { url } price { amount currencyCode }
        selectedOptions { name value }
      } }
    }
  }
}`;
async function boundedResponse(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_feed');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > 2_000_000) throw new Error('feed_limit'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const data = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(data));
}
/** Server-side only, merchant-authorized Storefront access. No scraping, cart
 * mutation, image upload, customer data, tracking redirects, or checkout claim. */
export function createShopifyAdapter(merchant: AuthorizedMerchant, config: ShopifySourceConfig, fetcher: typeof fetch = fetch): CatalogAdapter {
  assertAuthorizedMerchant(merchant);
  const domain = config.shopDomain.toLowerCase();
  if (merchant.sourceKind !== 'shopify_storefront' || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(domain)
    || !merchant.approvedDomains.includes(domain) || !config.privateStorefrontToken || /[\r\n]/.test(config.privateStorefrontToken)
    || !/^[A-Z]{2}$/.test(config.marketCountry) || !merchant.markets.includes(config.marketCountry)) throw new Error('unauthorized_shopify_source');
  return { kind: 'shopify_storefront', snapshot: async (signal) => {
    const products: FeedProduct[] = []; let after: string | null = null;
    const cursors = new Set<string>();
    for (let page = 0; page < 13; page++) {
      const response = await fetcher(`https://${domain}/api/${SHOPIFY_API_VERSION}/graphql.json`, {
        method: 'POST', redirect: 'error', signal,
        headers: { 'Content-Type': 'application/json', 'Shopify-Storefront-Private-Token': config.privateStorefrontToken },
        body: JSON.stringify({ query: QUERY, variables: { after, country: config.marketCountry } }),
      });
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('source_unavailable'); }
      const payload = await boundedResponse(response);
      const connection = payload?.data?.products;
      if (payload.errors?.length || !Array.isArray(connection?.nodes) || !connection?.pageInfo) throw new Error('invalid_feed');
      for (const product of connection.nodes) {
        const mapping = config.fashionByProductId[product.id];
        // Unmapped inventory is withheld, never classified by a guess.
        if (!mapping || !product.onlineStoreUrl) continue;
        if (product.variants?.pageInfo?.hasNextPage || !Array.isArray(product.variants?.nodes)) throw new Error('variant_limit');
        for (const variant of product.variants.nodes) {
          products.push({ sourceProductId: product.id, variantId: variant.id, sku: variant.sku || undefined,
            title: product.title, category: mapping.category, subtype: mapping.subtype, attributes: mapping.attributes,
            imageUrl: variant.image?.url ?? product.featuredImage?.url ?? null, productUrl: product.onlineStoreUrl,
            priceAmount: variant.price?.amount ?? null, currency: variant.price?.currencyCode ?? null,
            availability: variant.availableForSale === true ? 'in_stock' : variant.availableForSale === false ? 'out_of_stock' : 'unknown',
            sizes: (variant.selectedOptions ?? []).filter((o: { name: string }) => o.name.toLowerCase() === 'size').map((o: { value: string }) => o.value),
            markets: [config.marketCountry], provenanceRef: merchant.authorizationRef });
          if (products.length > 500) throw new Error('feed_limit');
        }
      }
      if (connection.pageInfo.hasNextPage === false) return { products, complete: true };
      const cursor = connection.pageInfo.endCursor;
      if (typeof cursor !== 'string' || !cursor || cursors.has(cursor)) throw new Error('invalid_pagination');
      cursors.add(cursor); after = cursor;
    }
    throw new Error('feed_limit');
  } };
}
