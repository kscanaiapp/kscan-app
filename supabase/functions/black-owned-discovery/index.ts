import { requireUser, rest, assertAccountActive } from '../_shared/deletion/common.ts';
import { createDiscoveryAuthenticator } from './accountAuthorization.ts';
import { discoveryFlags, type CatalogRow, type OwnershipIdentity } from './contracts.ts';
import { createDiscoveryService } from './engine.ts';
import { createDiscoveryHandler } from './handler.ts';
import { sponsorshipSnapshot } from './sponsorshipStore.ts';
import { createShadowEvaluator, shadowScheduler } from './sponsorshipShadow.ts';

async function query(path: string, body: unknown | undefined, signal: AbortSignal) {
  const response = await rest(path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  if (!response.ok) throw new Error('discovery_store_unavailable');
  return await response.json();
}
const discover = createDiscoveryService({
  revision: async (signal) => {
    const rows = await query('discovery_catalog_revision?select=revision&singleton=eq.true', undefined, signal);
    if (!Number.isSafeInteger(rows?.[0]?.revision)) throw new Error('invalid_revision');
    return rows[0].revision;
  },
  candidates: async (input, signal) => {
    const data = await query('rpc/discovery_candidates', { p_category: input.garment.item_type, p_subtype: input.garment.subtype ?? '', p_market: input.market }, signal);
    if (!Array.isArray(data?.rows) || data.rows.length > 160 || !Number.isSafeInteger(data.revision)) throw new Error('invalid_catalog_snapshot');
    return { revision: data.revision as number, rows: data.rows as CatalogRow[], ownership: {} };
  },
  ownership: async (input, signal) => await query('rpc/discovery_primary_ownership', { p_products: input.primaryProducts }, signal) as Record<string, OwnershipIdentity>,
  event: (event, payload) => console.info(JSON.stringify({ event, ...payload })),
});
const runtime = (globalThis as unknown as { EdgeRuntime?: { waitUntil: (task: Promise<void>) => void } }).EdgeRuntime;
const scheduleShadow = shadowScheduler(Deno.env.get('SPONSORSHIP_SHADOW_MODE') === 'true',runtime ? (task)=>runtime.waitUntil(task) : undefined,
  createShadowEvaluator({snapshot:sponsorshipSnapshot,emit:(event)=>console.info(JSON.stringify(event))}));
Deno.serve(createDiscoveryHandler({
  flags: () => discoveryFlags((key) => Deno.env.get(key)),
  authenticate: createDiscoveryAuthenticator(requireUser, assertAccountActive),
  claim: async (id, signal) => (await query('rpc/discovery_claim_request', { p_actor: id }, signal)) === true,
  discover,
  completed:scheduleShadow,
}));
