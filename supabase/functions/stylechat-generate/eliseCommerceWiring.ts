/**
 * OC-01 runtime wiring for stylechat-generate: binds the read-only broker to
 * the EXISTING server services only — JWT verification, account-active guard,
 * Gemini consent guard, the service-role REST helper, the discovery catalog
 * queries/RPCs and the discovery rate limit. No new provider, credential or
 * environment secret is introduced. One broker per isolate (lazy).
 */
import { assertAccountActive, requireUser, rest } from '../_shared/deletion/common.ts';
import { requireGeminiConsent } from '../_shared/geminiConsent.ts';
import type { CatalogRow, OwnershipIdentity } from '../black-owned-discovery/contracts.ts';
import { discoveryFlags } from '../black-owned-discovery/contracts.ts';
import type { DiscoveryDependencies } from '../black-owned-discovery/engine.ts';
import { discoverySubtypeKeys } from '../black-owned-discovery/validation.ts';
import { createSupabaseReferenceStore } from '../_shared/corporateIntelligence/readOnlyTools/sessionStore.ts';
import { createOc01Broker, createTurnPermits } from './eliseCommerceTools.ts';
import { EXPANSION_FLAG, resolveBrandExpansion } from '../_shared/brandSearchExpansion.ts';

async function query(path: string, body: unknown | undefined, signal: AbortSignal) {
  const response = await rest(path, { method: body === undefined ? 'GET' : 'POST', ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal });
  if (!response.ok) throw new Error('discovery_store_unavailable');
  return await response.json();
}

/** Same authorized catalog transports as the black-owned-discovery function (eligibility predicates live in SQL). */
const discovery: DiscoveryDependencies = {
  revision: async (signal) => {
    const rows = await query('discovery_catalog_revision?select=revision&singleton=eq.true', undefined, signal);
    if (!Number.isSafeInteger(rows?.[0]?.revision)) throw new Error('invalid_revision');
    return rows[0].revision;
  },
  candidates: async (input, signal) => {
    const snapshots = await Promise.all(discoverySubtypeKeys(input.garment.subtype, false).map((key) =>
      query('rpc/discovery_candidates', { p_category: input.garment.item_type, p_subtype: key, p_market: input.market }, signal)));
    const rows = new Map<string, CatalogRow>();
    let revision: number | undefined;
    for (const data of snapshots) {
      if (!Array.isArray(data?.rows) || data.rows.length > 160 || !Number.isSafeInteger(data.revision)) throw new Error('invalid_catalog_snapshot');
      revision = revision === undefined ? data.revision : Math.min(revision, data.revision);
      for (const row of data.rows as CatalogRow[]) if (rows.size < 160 && !rows.has(row.id)) rows.set(row.id, row);
    }
    return { revision: revision ?? 0, rows: [...rows.values()], ownership: {} };
  },
  ownership: async (input, signal) => await query('rpc/discovery_primary_ownership', { p_products: input.primaryProducts }, signal) as Record<string, OwnershipIdentity>,
  event: () => {},
};

const envGet = (k: string) => Deno.env.get(k) ?? undefined;
export const oc01Permits = createTurnPermits();
const store = createSupabaseReferenceStore(rest);

/**
 * One broker PER REQUEST. The broker's "one outstanding retrieval" bound then
 * applies to that customer's turn, so one customer's slow or repeated search
 * can never make search unavailable for others sharing the isolate (review
 * P2-3). Accumulation stays bounded by the provider timeouts and the
 * existing per-actor burst/daily limits that gate this path.
 */
export function getOc01Broker(actorId?: string) {
  return createOc01Broker({
    envGet,
    authenticate: requireUser,
    assertActive: assertAccountActive,
    consentCurrent: async (actorId) => (await requireGeminiConsent(actorId)) === null,
    permits: oc01Permits,
    discovery,
    store,
    ...(actorId && envGet(EXPANSION_FLAG) === 'true' ? { expansion: (input: import('../_shared/corporateIntelligence/readOnlyTools/request.ts').Search, signal: AbortSignal) => resolveBrandExpansion(actorId, { ...input.garment }, signal) } : {}),
    // Broker metadata is closed codes/counts/durations only (no text, ids, titles or URLs).
    emit: (m) => console.log('[stylechat-generate] oc01_tool %s', JSON.stringify(m)),
  });
}

/** The discovery lane's own rollout policy plus its existing per-actor rate limit. */
export async function blackOwnedLaneAllowed(actorId: string): Promise<boolean> {
  const flags = discoveryFlags(envGet);
  if (!flags.discovery) return false;
  return (await query('rpc/discovery_claim_request', { p_actor: actorId }, AbortSignal.timeout(1_000))) === true;
}

export function ownershipLabelsAllowed(): boolean {
  return discoveryFlags(envGet).badges;
}
