// Scheduled catalog maintenance for verified Black-owned discovery inventory.
// Worker-secret only (verify_jwt=false): no customer, JWT or anonymous path.
import { envOptional, logEvent, rest } from '../_shared/deletion/common.ts';
import { constantTimeEqual } from '../_shared/revenuecat/revenueCatWebhookAuth.ts';
import { catalogStore } from '../black-owned-discovery/adminService.ts';
import { createCatalogWorkerHandler, MAX_MERCHANTS_PER_RUN } from '../black-owned-discovery/catalogWorker.ts';

Deno.serve(createCatalogWorkerHandler({
  secret: () => envOptional('DISCOVERY_CATALOG_WORKER_SECRET'),
  enabled: () => Deno.env.get('DISCOVERY_CATALOG_SYNC_ENABLED') === 'true',
  secretsEqual: constantTimeEqual,
  merchants: async (signal) => {
    const response = await rest(`discovery_merchants?status=eq.active&catalog_status=eq.approved&select=id,credential_ref&order=id&limit=${MAX_MERCHANTS_PER_RUN}`, { signal });
    if (!response.ok) throw new Error('merchant_inventory_unavailable');
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('merchant_inventory_unavailable');
    return rows.map((row: { id: string; credential_ref: string | null }) => ({ id: row.id, credentialRef: row.credential_ref }));
  },
  sourceConfig: (ref) => {
    const raw = Deno.env.get(`DISCOVERY_SOURCE_${ref}`);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  },
  store: catalogStore,
  log: (event, fields) => logEvent(event, fields),
}));
