import { rest } from '../_shared/deletion/common.ts';
import type { AuthorizedMerchant, CatalogStore } from './catalog.ts';

async function rpc(name: string, body: unknown, signal?: AbortSignal) {
  const response = await rest(`rpc/${name}`, { method: 'POST', body: JSON.stringify(body), signal });
  if (!response.ok) throw new Error('discovery_operation_rejected');
  return response.status === 204 ? null : await response.json();
}
/** Import only in trusted backend workers/tooling, never the mobile app. The DB
 * checks p_actor against protected discovery_reviewers for every operation. */
export async function manageDiscovery(actorId: string, action: 'prospect' | 'campaign' | 'register_brand' | 'submit_evidence' | 'request_review' | 'review_ownership' | 'brand_visibility' | 'merchant' | 'partnership' | 'withdraw_product', data: Record<string, unknown>): Promise<string> {
  return await rpc('discovery_manage', { p_actor: actorId, p_action: action, p_data: data }) as string;
}
export const catalogStore: CatalogStore = {
  begin: async (id, key, signal) => await rpc('discovery_begin_sync', { p_merchant: id, p_key: key }, signal),
  merchant: async (id, signal) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid_merchant');
    const response = await rest(`discovery_merchants?id=eq.${id}&select=id,brand_id,status,catalog_status,identity_expires_at,source_authorized_until,source_kind,source_authorization_ref,approved_domains,image_domains,markets`, { signal });
    if (!response.ok) throw new Error('merchant_unavailable');
    const rows = await response.json(); const m = rows?.[0];
    if (!m) throw new Error('merchant_unavailable');
    return { id: m.id, brandId: m.brand_id, status: m.status, catalogStatus: m.catalog_status,
      identityExpiresAt: m.identity_expires_at, sourceAuthorizedUntil: m.source_authorized_until,
      sourceKind: m.source_kind, authorizationRef: m.source_authorization_ref,
      approvedDomains: m.approved_domains, imageDomains: m.image_domains, markets: m.markets } as AuthorizedMerchant;
  },
  ingest: async (id, key, products, complete, signal) => await rpc('discovery_ingest', { p_merchant: id, p_key: key, p_products: products, p_complete: complete }, signal) as number,
  failed: async (id, key, code, signal) => { await rpc('discovery_sync_failed', { p_merchant: id, p_key: key, p_code: code }, signal); },
};
export async function cleanupDiscovery(actorId: string) { await rpc('discovery_cleanup', { p_actor: actorId }); }
