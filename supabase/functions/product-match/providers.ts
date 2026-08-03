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

import type { ProductMatchQuery, ProductSource } from './contracts.ts';
import type { ProviderExecutor } from './orchestrator.ts';
import type { NormalizedRow } from './normalize.ts';
import {
  isTestCatalogRow,
  normalizeCatalogRow,
  normalizeRecommendedProduct,
  normalizeRetailerProduct,
  type NormalizeHints,
  type RawCatalogRow,
} from './normalize.ts';
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
 * Builds the upstream search string from the canonical query.
 *
 * Deliberately simple and separate from `scan-identify`'s weighted query
 * builder: this endpoint receives attributes a caller already resolved, so
 * re-running the scanner's query-weighting heuristics here would make the two
 * paths diverge silently. Callers that want the tuned query pass it in through
 * `searchQueries`, which wins.
 */
export function buildProviderQuery(query: ProductMatchQuery): string {
  const supplied = query.searchQueries?.find(
    (candidate) => typeof candidate === 'string' && candidate.trim().length > 0,
  );
  if (supplied) return supplied.trim().slice(0, 200);

  const parts = [
    query.visibleBrandText ?? query.brand,
    query.color,
    query.material,
    query.model,
    query.silhouette,
    query.canonicalCategory,
  ]
    .map((part) => (typeof part === 'string' ? part.trim() : ''))
    .filter((part) => part.length > 0);

  const seen = new Set<string>();
  const deduped = parts.filter((part) => {
    const key = slugify(part);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return deduped.join(' ').slice(0, 200);
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
      run: async ({ query }) => {
        const searchQuery = buildProviderQuery(query);
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
      run: async ({ query }) => {
        const searchQuery = buildProviderQuery(query);
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
      run: async ({ query }) => {
        const searchQuery = buildProviderQuery(query);
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
        const hints = hintsFrom(query);
        return (data as RawCatalogRow[])
          // Production `product_catalog` is currently 100% seeded test data.
          // Filtering here rather than at the query keeps the exclusion visible
          // in code review and testable without a database.
          .filter((row) => !isTestCatalogRow(row))
          .map((row) => normalizeCatalogRow(row, hints))
          .filter((row): row is NormalizedRow => row !== null);
      },
    });
  }

  return executors;
}
