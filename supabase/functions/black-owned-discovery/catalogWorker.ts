import { createAuthorizedJsonAdapter, type AuthorizedJsonSourceConfig } from './authorizedJsonAdapter.ts';
import { synchronizeCatalog, type AuthorizedMerchant, type CatalogAdapter, type CatalogStore } from './catalog.ts';
import { createShopifyAdapter, type ShopifySourceConfig } from './shopifyAdapter.ts';

export const WORKER_HEADER = 'x-discovery-worker-secret';
export const MAX_MERCHANTS_PER_RUN = 25;
const RUN_BUDGET_MS = 100_000;
const CREDENTIAL_REF = /^[A-Z0-9_]{3,64}$/;

export type SyncCandidate = { id: string; credentialRef: string | null };
export type CatalogWorkerDependencies = {
  secret: () => string | null;
  /** Server-side kill switch; anything but an explicit `true` changes nothing. */
  enabled: () => boolean;
  secretsEqual: (provided: string, expected: string) => Promise<boolean>;
  merchants: (signal: AbortSignal) => Promise<SyncCandidate[]>;
  /** Parsed `DISCOVERY_SOURCE_<credential_ref>` server secret, or null. */
  sourceConfig: (credentialRef: string) => unknown;
  store: CatalogStore;
  now?: () => number;
  fetcher?: typeof fetch;
  log?: (event: string, fields: Record<string, unknown>) => void;
};
export type CatalogSyncReport = {
  mode: 'catalog_sync'; enabled: boolean;
  merchants: number; succeeded: number; failed: number; skipped: number; products: number;
};
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });

/** One idempotency key per merchant per UTC hour: a retried run never re-ingests. */
export function syncKey(now: number): string {
  return `catalog:${new Date(now).toISOString().slice(0, 13).replace(/[-T]/g, '')}`;
}
export function adapterFor(merchant: AuthorizedMerchant, config: unknown, fetcher?: typeof fetch): CatalogAdapter {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('source_not_configured');
  if (merchant.sourceKind === 'authorized_json') return createAuthorizedJsonAdapter(merchant, config as AuthorizedJsonSourceConfig, fetcher);
  if (merchant.sourceKind === 'shopify_storefront') return createShopifyAdapter(merchant, config as ShopifySourceConfig, fetcher);
  throw new Error('unauthorized_source');
}

export async function runCatalogSync(deps: CatalogWorkerDependencies): Promise<CatalogSyncReport> {
  const report: CatalogSyncReport = { mode: 'catalog_sync', enabled: true, merchants: 0, succeeded: 0, failed: 0, skipped: 0, products: 0 };
  const now = deps.now ?? Date.now;
  const deadline = AbortSignal.timeout(RUN_BUDGET_MS);
  const key = syncKey(now());
  const merchants = (await deps.merchants(deadline)).slice(0, MAX_MERCHANTS_PER_RUN);
  report.merchants = merchants.length;
  for (const merchant of merchants) {
    if (deadline.aborted) { report.skipped++; continue; }
    // A merchant without a server-held source secret is reported, never guessed.
    const ref = merchant.credentialRef;
    const config = ref && CREDENTIAL_REF.test(ref) ? deps.sourceConfig(ref) : null;
    if (!config) { report.skipped++; deps.log?.('discovery_catalog_sync_skipped', { merchantId: merchant.id, reason: 'source_not_configured' }); continue; }
    try {
      const count = await synchronizeCatalog(deps.store, merchant.id, key, (m) => adapterFor(m, config, deps.fetcher), deadline);
      report.succeeded++; report.products += count;
      deps.log?.('discovery_catalog_synced', { merchantId: merchant.id, products: count });
    } catch (error) {
      report.failed++;
      deps.log?.('discovery_catalog_sync_failed', { merchantId: merchant.id, reason: error instanceof Error ? error.message : 'unknown' });
    }
  }
  return report;
}

export function createCatalogWorkerHandler(deps: CatalogWorkerDependencies) {
  return async (request: Request): Promise<Response> => {
    void request.body?.cancel().catch(() => undefined);
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);
    const expected = deps.secret();
    const provided = request.headers.get(WORKER_HEADER)?.trim();
    // No secret configured means no worker: there is no JWT or anonymous path.
    if (!expected || !provided || !(await deps.secretsEqual(provided, expected))) return json({ error: 'unauthorized' }, 401);
    if (!deps.enabled()) return json({ mode: 'catalog_sync', enabled: false, merchants: 0, succeeded: 0, failed: 0, skipped: 0, products: 0 });
    try { return json(await runCatalogSync(deps)); }
    catch { return json({ error: 'catalog_sync_unavailable' }, 503); }
  };
}
