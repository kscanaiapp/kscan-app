/**
 * Product Match Foundation V1 — provider executors over the EXISTING providers.
 *
 * NO NEW EXTERNAL PROVIDERS. Every executor here wraps a module that is already
 * part of the deployed `scan-identify` closure and is already reachable in
 * production:
 *
 *   ../scan-identify/kicksCrewProvider.ts   KICKSCREW_ENABLED + KICKSCREW_RAPIDAPI_KEY
 *   ../scan-identify/farfetchProvider.ts    FARFETCH_ENABLED  + FARFETCH_RAPIDAPI_KEY
 *   ../scan-identify/shoppingProvider.ts    SHOPPING_ENABLED  + SHOPPING_SERPER_API_KEY
 *                                                             (Brave is its internal fallback)
 *   product_catalog table                   injected Supabase client
 *
 * These three modules are leaves — none of them imports another local module —
 * so wrapping them adds exactly three files to this function's dependency
 * closure and changes nothing about `scan-identify`'s. The edge parity manifest
 * hashes a function's own directory plus the modules IT reaches; being imported
 * BY a new function does not alter a module's hash or `scan-identify`'s tree.
 *
 * COST CONTROL
 *
 * Each executor's `enabled` flag mirrors the upstream module's own gate. With
 * no provider keys configured — the state of every environment in this phase —
 * every executor reports `disabled` and no upstream call is made. That is the
 * mechanism by which "no paid provider calls" is enforced structurally rather
 * than by remembering not to run something.
 *
 * SERPER / BRAVE ARE ONE EXECUTOR
 *
 * `getShoppingResults` implements Serper-primary with Brave as its internal
 * fallback, and this phase does not rewrite it. The executor is therefore
 * registered under `serper`, and individual listings carry whichever source
 * actually produced them. Splitting that pair into two independently scheduled
 * providers is a change to the provider itself, not to orchestration, and is
 * out of scope here.
 */

import type { PlannedQuery, ProductMatchQuery, ProductSource } from './contracts.ts';
import type { ProviderExecutor } from './orchestrator.ts';
import type { NormalizedRow } from './normalize.ts';
import {
  normalizeCatalogRow,
  normalizeRecommendedProduct,
  normalizeRetailerProduct,
  type NormalizeHints,
  type RawCatalogRow,
} from './normalize.ts';
import { applyCatalogExclusionGate } from './catalogExclusion.ts';
import { searchKicksCrewProducts } from '../scan-identify/kicksCrewProvider.ts';
import { searchFarfetchProducts } from '../scan-identify/farfetchProvider.ts';
import { getShoppingResults } from '../scan-identify/shoppingProvider.ts';
import { slugify } from './identity.ts';

export type EnvGet = (key: string) => string | undefined;

const defaultEnvGet: EnvGet = (key) => {
  try {
    return Deno.env.get(key);
  } catch {
    return undefined;
  }
};

function envEnabled(envGet: EnvGet, flagKey: string, ...keyNames: string[]): boolean {
  const flag = envGet(flagKey)?.trim().toLowerCase();
  if (flag === 'false' || flag === '0' || flag === 'off' || flag === 'no') return false;
  // A provider without its credential cannot be called, so it is reported as
  // disabled rather than allowed to fail once per request.
  return keyNames.some((name) => (envGet(name)?.trim().length ?? 0) > 0);
}

/**
 * Picks the search string an executor sends upstream from the planned queries.
 *
 * Query CONSTRUCTION now lives in `queryPlanner.ts`; this only chooses which of
 * the planned queries to issue. One query per provider per pass is deliberate —
 * issuing every planned query to every provider multiplies cost by the number
 * of strategies for a benefit nothing has yet measured, and this phase is
 * explicitly not spending provider calls ahead of evidence.
 */
export function selectProviderQuery(queries: PlannedQuery[]): string | null {
  for (const planned of queries) {
    const text = typeof planned?.text === 'string' ? planned.text.trim() : '';
    if (text) return text.slice(0, 200);
  }
  return null;
}

function hintsFrom(query: ProductMatchQuery): NormalizeHints {
  return {
    brand: query.visibleBrandText ?? query.brand ?? null,
    canonicalCategory: query.canonicalCategory ?? null,
    color: query.color ?? null,
  };
}

/**
 * Minimal structural view of the Supabase client, matching the one
 * `_shared/catalogRetrieval.ts` already relies on. Typed structurally so this
 * module never imports the Supabase SDK.
 */
export type CatalogClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (column: string, value: string) => {
        limit: (count: number) => Promise<{ data: unknown[] | null; error: { message: string } | null }>;
      };
    };
  };
};

export type BuildProvidersOptions = {
  envGet?: EnvGet;
  catalogClient?: CatalogClient | null;
  /** Restrict to a subset. Sources outside the list are omitted entirely. */
  only?: ProductSource[];
  /**
   * Called with the number of catalog rows the production test-data gate
   * rejected. Reported so the gate's activity reaches the retrieval report
   * rather than being an invisible filter.
   */
  onCatalogExclusions?: (count: number) => void;
};

export function buildProviderExecutors(options: BuildProvidersOptions = {}): ProviderExecutor[] {
  const envGet = options.envGet ?? defaultEnvGet;
  const only = options.only;
  const include = (source: ProductSource) => !only || only.includes(source);

  const executors: ProviderExecutor[] = [];

  if (include('kickscrew')) {
    executors.push({
      source: 'kickscrew',
      enabled: envEnabled(envGet, 'KICKSCREW_ENABLED', 'KICKSCREW_RAPIDAPI_KEY', 'RAPIDAPI_KEY'),
      run: async ({ query, queries }) => {
        const searchQuery = selectProviderQuery(queries);
        if (!searchQuery) return [];
        const result = await searchKicksCrewProducts(searchQuery, { limit: 8 });
        const hints = hintsFrom(query);
        return result.products
          .map((product) => normalizeRetailerProduct(product, 'kickscrew', hints))
          .filter((row): row is NormalizedRow => row !== null);
      },
    });
  }

  if (include('farfetch')) {
    executors.push({
      source: 'farfetch',
      enabled: envEnabled(envGet, 'FARFETCH_ENABLED', 'FARFETCH_RAPIDAPI_KEY', 'RAPIDAPI_KEY'),
      run: async ({ query, queries }) => {
        const searchQuery = selectProviderQuery(queries);
        if (!searchQuery) return [];
        const result = await searchFarfetchProducts(searchQuery, { limit: 8 });
        const hints = hintsFrom(query);
        return result.products
          .map((product) => normalizeRetailerProduct(product, 'farfetch', hints))
          .filter((row): row is NormalizedRow => row !== null);
      },
    });
  }

  if (include('serper')) {
    executors.push({
      source: 'serper',
      enabled: envEnabled(envGet, 'SHOPPING_ENABLED', 'SHOPPING_SERPER_API_KEY', 'SHOPPING_BRAVE_API_KEY'),
      run: async ({ query, queries }) => {
        const searchQuery = selectProviderQuery(queries);
        if (!searchQuery) return [];
        const result = await getShoppingResults({ query: searchQuery, limit: 8 });
        if (result.provider === 'none') return [];
        const source: Extract<ProductSource, 'serper' | 'brave'> =
          result.provider === 'brave' ? 'brave' : 'serper';
        const hints = hintsFrom(query);
        return result.products
          .map((product) => normalizeRecommendedProduct(product, source, hints))
          .filter((row): row is NormalizedRow => row !== null);
      },
    });
  }

  if (include('catalog')) {
    const client = options.catalogClient ?? null;
    executors.push({
      source: 'catalog',
      // No client means no catalog. The table is not reachable from this
      // function on its own, and inventing a service-role client here would put
      // an unauthorized write-capable credential into a read path.
      enabled: client !== null,
      run: async ({ query }) => {
        if (!client) return [];
        const category = query.canonicalCategory?.trim();
        if (!category) return [];
        const { data, error } = await client
          .from('product_catalog')
          .select('*')
          .eq('canonical_category', category)
          .limit(30);
        if (error || !Array.isArray(data)) return [];

        // Production `product_catalog` is currently 100% seeded test data, and
        // the table is world-readable. The gate runs here, before anything is
        // normalized, and reports how much it rejected — an exclusion nobody
        // can count is an exclusion nobody notices has stopped working.
        const gated = applyCatalogExclusionGate(data as RawCatalogRow[]);
        if (gated.excludedCount > 0) options.onCatalogExclusions?.(gated.excludedCount);

        const hints = hintsFrom(query);
        return gated.admitted
          .map((row) => normalizeCatalogRow(row, hints))
          .filter((row): row is NormalizedRow => row !== null);
      },
    });
  }

  return executors;
}
