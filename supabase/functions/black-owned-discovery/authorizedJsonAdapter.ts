import type { AuthorizedMerchant, CatalogAdapter, FeedProduct } from './catalog.ts';
import { assertAuthorizedMerchant } from './catalog.ts';
import { safeCatalogUrl } from './validation.ts';

export type AuthorizedJsonSourceConfig = {
  /** Merchant-published feed on one of the merchant's reviewed domains. */
  feedUrl: string;
  /** Optional server-side bearer credential issued by the merchant. */
  bearerToken?: string;
};
const FEED_BYTES = 2_000_000;
async function boundedJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('invalid_feed');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.length; if (bytes > FEED_BYTES) throw new Error('feed_limit'); chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  const data = new Uint8Array(bytes); let offset = 0;
  for (const chunk of chunks) { data.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(data));
}
/**
 * Merchant-authorized JSON feed: `{ "complete": true, "products": FeedProduct[] }`.
 * Category, subtype and attributes are the merchant's reviewed declarations; nothing
 * is inferred from titles, imagery or a model. Only an explicit `complete: true`
 * snapshot may withdraw products missing from the feed.
 */
export function createAuthorizedJsonAdapter(merchant: AuthorizedMerchant, config: AuthorizedJsonSourceConfig, fetcher: typeof fetch = fetch): CatalogAdapter {
  assertAuthorizedMerchant(merchant);
  const feedUrl = safeCatalogUrl(config.feedUrl, merchant.approvedDomains);
  if (merchant.sourceKind !== 'authorized_json' || !feedUrl
    || (config.bearerToken !== undefined && (typeof config.bearerToken !== 'string' || !config.bearerToken || /[\r\n]/.test(config.bearerToken)))) throw new Error('unauthorized_feed_source');
  return { kind: 'authorized_json', snapshot: async (signal) => {
    const response = await fetcher(feedUrl, {
      method: 'GET', redirect: 'error', signal,
      headers: { Accept: 'application/json', ...(config.bearerToken ? { Authorization: `Bearer ${config.bearerToken}` } : {}) },
    });
    if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Error('source_unavailable'); }
    const payload = await boundedJson(response) as { products?: unknown; complete?: unknown } | null;
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.products) || payload.products.length > 500) throw new Error('invalid_feed');
    const products = (payload.products as FeedProduct[]).map((p) => (p && typeof p === 'object' && !p.provenanceRef ? { ...p, provenanceRef: merchant.authorizationRef } : p));
    return { products, complete: payload.complete === true };
  } };
}
