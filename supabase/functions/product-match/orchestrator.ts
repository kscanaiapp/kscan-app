/**
 * Product Match Foundation V1 — parallel provider orchestration.
 *
 * WHAT THIS REPLACES
 *
 * The deployed `scan-identify` commerce path is a sequential `await` cascade:
 * KicksCrew, then Farfetch, then Serper, then Brave, each gated on the last.
 * Production telemetry over that path (n = 54, `scan_commerce_events`) shows
 * `providers_tried` values of `[farfetch, serper]` and
 * `[kickscrew, farfetch, serper]`, and a `provider_outcome` of `serper` in
 * essentially every completed row — the specialist providers are paid for in
 * latency and then almost never win. Sequential execution means the total is
 * the SUM of the attempts, and one slow provider extends every request behind
 * it.
 *
 * THE FOUR GUARANTEES
 *
 *   1. No provider can block the whole result. Each runs under its own
 *      deadline and its own abort signal.
 *   2. Eligible providers run concurrently, so the wall clock is the SLOWEST
 *      provider rather than their sum.
 *   3. Partial results are preserved. Whatever completed before the total
 *      deadline is returned and labelled `partial`, never discarded.
 *   4. Time-to-first-useful-match is measured separately from time-to-complete.
 *      Both are reported; neither is allowed to influence tier assignment.
 *
 * STAGED RETRIEVAL WITHOUT STREAMING
 *
 * The first-useful checkpoint is computed by re-evaluating the accumulated rows
 * each time a provider settles. That is the same computation a streaming
 * transport would perform at flush time, so the number reported here is the
 * latency a staged client WOULD observe — the design is staged, the transport
 * is not yet, and this phase deliberately does not require mobile streaming.
 *
 * The re-evaluation is cheap by construction: dedupe and tier assignment are
 * pure functions over at most a few dozen rows, with no I/O.
 */

import type {
  MatchTier,
  MatchedFamily,
  MatchedVariant,
  ProductListing,
  ProductMatchQuery,
  ProductMatchResponse,
  ProductMatchTimings,
  ProductSource,
  ProviderOutcome,
  ProviderOutcomeStatus,
} from './contracts.ts';
import { isUsefulTier, tierRank } from './contracts.ts';
import {
  PRODUCT_MATCH_CONTRACT_VERSION,
  PRODUCT_MATCH_MAX_FAMILIES,
  PRODUCT_MATCH_MAX_LISTINGS,
  PRODUCT_MATCH_VERSION,
  type ProductMatchDeadlines,
} from './config.ts';
import { dedupeRows, type DedupeResult, type DedupeStats } from './dedupe.ts';
import { assessVariant } from './evidence.ts';
import type { NormalizedRow } from './normalize.ts';

/**
 * A provider, as far as the orchestrator is concerned.
 *
 * `run` receives an `AbortSignal` and is expected to honour it. A provider that
 * ignores the signal still cannot extend the request — the orchestrator stops
 * waiting either way — but it will keep an upstream socket open, so honouring
 * it is the difference between a bounded request and a bounded request that
 * leaks work.
 */
export type ProviderExecutor = {
  source: ProductSource;
  /** When false the provider is reported as `disabled` and never invoked. */
  enabled: boolean;
  run: (context: {
    query: ProductMatchQuery;
    signal: AbortSignal;
    deadlineMs: number;
  }) => Promise<NormalizedRow[]>;
};

export type OrchestrationOptions = {
  deadlines: ProductMatchDeadlines;
  /** Injectable clock. Real `Date.now` in production; fixed in tests. */
  now?: () => number;
  maxListings?: number;
  maxFamilies?: number;
};

/**
 * The response plus the dedupe accounting behind it.
 *
 * Dedupe statistics are returned alongside rather than embedded in
 * `ProductMatchResponse` because they are operator evidence, not part of the
 * caller-facing contract — a client should never branch on how many listings
 * were merged, but telemetry must be able to explain the merge.
 */
export type OrchestrationOutcome = {
  response: ProductMatchResponse;
  dedupeStats: DedupeStats;
};

type Settlement = {
  source: ProductSource;
  status: ProviderOutcomeStatus;
  durationMs: number;
  rows: NormalizedRow[];
  reason?: string;
};

/** Assembles the deduped, tiered view of whatever rows exist so far. */
function assemble(
  query: ProductMatchQuery,
  rows: NormalizedRow[],
): { deduped: DedupeResult; families: MatchedFamily[]; listings: ProductListing[]; tier: MatchTier } {
  const deduped = dedupeRows(rows);

  const matchedByFamily = new Map<string, MatchedVariant[]>();
  for (const variant of deduped.variants) {
    const family = deduped.families.get(variant.familyKey);
    if (!family) continue;
    const assessment = assessVariant({ query, family, variant });
    const matched: MatchedVariant = {
      variant: {
        variantKey: variant.variantKey,
        familyKey: variant.familyKey,
        colorway: variant.colorway,
        exactProductId: variant.exactProductId,
        sizeHint: variant.sizeHint,
      },
      tier: assessment.tier,
      confidence: Number(assessment.confidence.toFixed(4)),
      evidence: assessment.evidence,
      listings: variant.listings,
    };
    const bucket = matchedByFamily.get(variant.familyKey);
    if (bucket) bucket.push(matched);
    else matchedByFamily.set(variant.familyKey, [matched]);
  }

  const families: MatchedFamily[] = [];
  for (const [familyKey, variants] of matchedByFamily) {
    const family = deduped.families.get(familyKey);
    if (!family) continue;
    variants.sort((a, b) => {
      const rank = tierRank(a.tier) - tierRank(b.tier);
      if (rank !== 0) return rank;
      if (b.confidence !== a.confidence) return b.confidence - a.confidence;
      return a.variant.variantKey.localeCompare(b.variant.variantKey);
    });
    families.push({
      family: {
        familyKey: family.familyKey,
        brand: family.brand,
        model: family.model,
        canonicalCategory: family.canonicalCategory,
        displayName: family.displayName,
      },
      tier: variants[0]?.tier ?? 'NO_CONFIDENT_MATCH',
      variants,
    });
  }

  families.sort((a, b) => {
    const rank = tierRank(a.tier) - tierRank(b.tier);
    if (rank !== 0) return rank;
    return a.family.familyKey.localeCompare(b.family.familyKey);
  });

  const listings: ProductListing[] = [];
  for (const family of families) {
    for (const variant of family.variants) listings.push(...variant.listings);
  }

  const tier = families[0]?.tier ?? 'NO_CONFIDENT_MATCH';
  return { deduped, families, listings, tier };
}

/** True when the accumulated rows already contain a match a caller could use. */
function hasUsefulMatch(query: ProductMatchQuery, rows: NormalizedRow[]): boolean {
  if (rows.length === 0) return false;
  return isUsefulTier(assemble(query, rows).tier);
}

function queryIsEmpty(query: ProductMatchQuery): boolean {
  const hasText = [
    query.brand,
    query.visibleBrandText,
    query.model,
    query.canonicalCategory,
    query.color,
    query.material,
    query.silhouette,
    query.pattern,
  ].some((value) => typeof value === 'string' && value.trim().length > 0);
  const hasArrays = (query.styleTags?.length ?? 0) > 0 || (query.searchQueries?.length ?? 0) > 0;
  return !hasText && !hasArrays;
}

export async function orchestrateProductMatch(input: {
  query: ProductMatchQuery;
  providers: ProviderExecutor[];
  options: OrchestrationOptions;
}): Promise<OrchestrationOutcome> {
  const { query, providers, options } = input;
  const now = options.now ?? (() => Date.now());
  const { deadlines } = options;
  const startedAt = now();

  const maxListings = options.maxListings ?? PRODUCT_MATCH_MAX_LISTINGS;
  const maxFamilies = options.maxFamilies ?? PRODUCT_MATCH_MAX_FAMILIES;

  const emptyOutcome = (
    emptyReason: ProductMatchResponse['emptyReason'],
    outcomes: ProviderOutcome[],
  ): OrchestrationOutcome => ({
    response: {
      contractVersion: PRODUCT_MATCH_CONTRACT_VERSION,
      version: PRODUCT_MATCH_VERSION,
      tier: 'NO_CONFIDENT_MATCH',
      families: [],
      listings: [],
      providers: outcomes,
      timings: { firstUsefulMatchMs: null, completeMs: now() - startedAt, deadlineExceeded: false, partial: false },
      emptyReason,
    },
    dedupeStats: dedupeRows([]).stats,
  });

  if (queryIsEmpty(query)) return emptyOutcome('no_query', []);

  const eligible = providers.filter((provider) => provider.enabled);
  const disabledOutcomes: ProviderOutcome[] = providers
    .filter((provider) => !provider.enabled)
    .map((provider) => ({ source: provider.source, status: 'disabled', durationMs: 0, rawCount: 0 }));

  if (eligible.length === 0) return emptyOutcome('no_eligible_providers', disabledOutcomes);

  // ── Launch every eligible provider concurrently ─────────────────────────
  const totalController = new AbortController();
  const accumulated: NormalizedRow[] = [];
  let firstUsefulMatchMs: number | null = null;
  const settlements: Settlement[] = [];

  const recordFirstUseful = (): void => {
    if (firstUsefulMatchMs !== null) return;
    if (hasUsefulMatch(query, accumulated)) firstUsefulMatchMs = now() - startedAt;
  };

  const runOne = async (provider: ProviderExecutor): Promise<void> => {
    const providerStartedAt = now();
    const providerController = new AbortController();
    const abortProvider = () => providerController.abort();
    totalController.signal.addEventListener('abort', abortProvider, { once: true });

    // Aborting a provider makes a well-behaved `run` reject with an AbortError,
    // and that rejection can win the race below against the timeout's own
    // resolution. Without this flag the catch block would classify a deadline
    // hit as a provider `error`, which is a materially different operational
    // signal: an error implicates the provider, a timeout implicates the budget.
    let timedOut = false;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const perProviderTimeout = new Promise<'provider_timeout'>((resolve) => {
      timer = setTimeout(() => {
        timedOut = true;
        providerController.abort();
        resolve('provider_timeout');
      }, deadlines.perProviderMs);
    });

    try {
      const outcome = await Promise.race([
        provider.run({
          query,
          signal: providerController.signal,
          deadlineMs: deadlines.perProviderMs,
        }),
        perProviderTimeout,
      ]);

      if (outcome === 'provider_timeout') {
        settlements.push({
          source: provider.source,
          status: 'timeout',
          durationMs: now() - providerStartedAt,
          rows: [],
        });
        return;
      }

      const rows = Array.isArray(outcome) ? outcome.filter(Boolean) : [];
      accumulated.push(...rows);
      settlements.push({
        source: provider.source,
        status: rows.length > 0 ? 'completed' : 'empty',
        durationMs: now() - providerStartedAt,
        rows,
      });
      recordFirstUseful();
    } catch (error) {
      const cutOff = timedOut || totalController.signal.aborted;
      settlements.push({
        source: provider.source,
        status: cutOff ? 'timeout' : 'error',
        durationMs: now() - providerStartedAt,
        rows: [],
        // Deliberately a class name, never the message: provider messages can
        // carry URLs, keys or upstream payload fragments.
        ...(cutOff ? {} : { reason: error instanceof Error ? error.name : 'unknown' }),
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      totalController.signal.removeEventListener('abort', abortProvider);
    }
  };

  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  const totalDeadline = new Promise<'total_timeout'>((resolve) => {
    totalTimer = setTimeout(() => {
      totalController.abort();
      resolve('total_timeout');
    }, deadlines.totalMs);
  });

  const allProviders = Promise.all(eligible.map((provider) => runOne(provider))).then(() => 'all_settled' as const);
  const raceOutcome = await Promise.race([allProviders, totalDeadline]);
  if (totalTimer !== undefined) clearTimeout(totalTimer);

  const deadlineExceeded = raceOutcome === 'total_timeout';
  if (deadlineExceeded) {
    // Stop waiting, but do not discard: anything already accumulated stands.
    totalController.abort();
  }

  const settledSources = new Set(settlements.map((settlement) => settlement.source));
  const outcomes: ProviderOutcome[] = [
    ...disabledOutcomes,
    ...settlements.map((settlement) => ({
      source: settlement.source,
      status: settlement.status,
      durationMs: settlement.durationMs,
      rawCount: settlement.rows.length,
      ...(settlement.reason ? { reason: settlement.reason } : {}),
    })),
    // Providers still in flight when the total deadline fired.
    ...eligible
      .filter((provider) => !settledSources.has(provider.source))
      .map((provider): ProviderOutcome => ({
        source: provider.source,
        status: 'timeout',
        durationMs: now() - startedAt,
        rawCount: 0,
        reason: 'total_deadline',
      })),
  ];
  outcomes.sort((a, b) => a.source.localeCompare(b.source));

  const assembled = assemble(query, accumulated);
  const families = assembled.families.slice(0, maxFamilies);
  const listings = assembled.listings.slice(0, maxListings);

  const producedSomething = outcomes.some((outcome) => outcome.status === 'completed');
  const lostSomething = outcomes.some(
    (outcome) => outcome.status === 'timeout' || outcome.status === 'error',
  );

  const timings: ProductMatchTimings = {
    firstUsefulMatchMs,
    completeMs: now() - startedAt,
    deadlineExceeded,
    partial: producedSomething && lostSomething,
  };

  if (listings.length === 0) {
    return {
      response: {
        contractVersion: PRODUCT_MATCH_CONTRACT_VERSION,
        version: PRODUCT_MATCH_VERSION,
        tier: 'NO_CONFIDENT_MATCH',
        families: [],
        listings: [],
        providers: outcomes,
        timings,
        emptyReason: 'no_results',
      },
      dedupeStats: assembled.deduped.stats,
    };
  }

  return {
    response: {
      contractVersion: PRODUCT_MATCH_CONTRACT_VERSION,
      version: PRODUCT_MATCH_VERSION,
      tier: assembled.tier,
      families,
      listings,
      providers: outcomes,
      timings,
      ...(assembled.tier === 'NO_CONFIDENT_MATCH' ? { emptyReason: 'below_confidence' as const } : {}),
    },
    dedupeStats: assembled.deduped.stats,
  };
}
