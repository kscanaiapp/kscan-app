/**
 * Product Match Foundation V1 — telemetry.
 *
 * WHAT THIS PHASE DOES AND DOES NOT DO
 *
 * It BUILDS the event and it PROVES the event is safe. It does not write one.
 * Database writes are not authorized for this phase, so `buildProductMatchEvent`
 * is a pure function and the only sink (`emitProductMatchEvent`) is disabled by
 * default and requires an explicitly injected writer. There is no code path
 * from an HTTP request to an INSERT in this branch.
 *
 * The migration that creates the destination table ships alongside
 * (`supabase/migrations/…_product_match_events.sql`) and is likewise NOT
 * applied. Shipping the event shape and its table together is what makes the
 * later activation a one-line flag change rather than a schema design exercise
 * performed under time pressure.
 *
 * PRIVACY MODEL — CATEGORICAL ONLY
 *
 * The event carries counts, durations, tiers, source names and version strings.
 * It carries NO user identifier, NO image, NO image hash, NO raw query text, NO
 * product title, NO URL, and no provider payload. `assertProductMatchTelemetry`
 * enforces that mechanically rather than by review, following the precedent set
 * by `llm_routing_events` ("categorical routing evidence, contains no user
 * identity, prompts, messages, images, or provider response bodies").
 *
 * The one free-text field is `correlationHash`, which the caller supplies and
 * which is required to be a hex digest — never a scan id, never a user id.
 */

import type {
  MatchTier,
  ProductMatchResponse,
  ProductSource,
  ProviderOutcomeStatus,
  QueryStrategy,
  StageTiming,
} from './contracts.ts';
import { MATCH_TIERS, PRODUCT_SOURCES, QUERY_STRATEGIES } from './contracts.ts';
import { PRODUCT_MATCH_CONTRACT_VERSION, PRODUCT_MATCH_VERSION } from './config.ts';
import type { DedupeStats } from './dedupe.ts';

export type ProductMatchProviderTelemetry = {
  source: ProductSource;
  status: ProviderOutcomeStatus;
  durationMs: number;
  rawCount: number;
};

export type ProductMatchEvent = {
  /** Contract + implementation version, for cohorting across deploys. */
  contract_version: number;
  match_version: string;

  /** Categorical outcome. */
  tier: MatchTier;
  empty_reason: string | null;

  /** Result-shape counts. */
  family_count: number;
  variant_count: number;
  listing_count: number;

  /** Tier histogram across variants. Every tier present, zero-filled. */
  tier_counts: Record<MatchTier, number>;

  /** Dedupe accounting, so merge behaviour is auditable from telemetry alone. */
  rows_in: number;
  listings_merged_by_url: number;
  variants_merged_by_exact_id: number;
  variants_merged_by_colorway: number;
  variants_with_cross_source_agreement: number;

  /** Latency, split so a change can be attributed rather than argued about. */
  first_useful_match_ms: number | null;
  complete_ms: number;
  deadline_exceeded: boolean;
  partial: boolean;
  /** Per-stage attribution: [{stage,durationMs,itemCount}, ...] */
  stages: StageTiming[];
  /** What the same providers would have cost run sequentially. */
  sequential_equivalent_ms: number;
  /** complete_ms measured against the ~9.2 s production scan baseline. */
  baseline_delta_ms: number;
  /** First useful match arrived past the observational threshold. A label. */
  first_useful_slow: boolean;

  /** Retrieval attribution: what was searched and what was rejected, and why. */
  strategies_used: QueryStrategy[];
  fallback_used: boolean;
  category_conflict_rejections: number;
  low_relevance_rejections: number;
  test_catalog_exclusions: number;

  /**
   * Advisory closet/recent-scan comparisons offered. A COUNT only — never an
   * item id, never an image, never a resolution. This service does not know
   * what the user chose and must not appear to.
   */
  potential_similar_item_count: number;

  /**
   * Checkpoint 4 — similarity-stage calibration counters. Categorical/numeric
   * only, matching the rest of this event: candidate counts, named sources, a
   * version string, and timings. Never an item id.
   */
  similarity_threshold_version: string | null;
  similarity_sources_checked: string[];
  similarity_candidates_considered: number;
  similarity_candidates_retained: number;
  similarity_retrieve_ms: number;
  similarity_compare_ms: number;

  /** Per-provider execution record. */
  providers: ProductMatchProviderTelemetry[];

  /** Caller-supplied opaque hex digest, or null. Never an identifier. */
  correlation_hash: string | null;

  app_platform: string | null;
  app_version: string | null;
};

const HEX_DIGEST = /^[0-9a-f]{8,64}$/;

function zeroTierCounts(): Record<MatchTier, number> {
  const counts = {} as Record<MatchTier, number>;
  for (const tier of MATCH_TIERS) counts[tier] = 0;
  return counts;
}

function safeVersionString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  // Version strings are short and structured; anything longer is not a version.
  return trimmed.slice(0, 32);
}

function safePlatform(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toLowerCase();
  return normalized === 'ios' || normalized === 'android' || normalized === 'web' ? normalized : null;
}

export function buildProductMatchEvent(input: {
  response: ProductMatchResponse;
  dedupeStats: DedupeStats;
  correlationHash?: string | null;
  appPlatform?: unknown;
  appVersion?: unknown;
}): ProductMatchEvent {
  const { response, dedupeStats } = input;

  const tierCounts = zeroTierCounts();
  let variantCount = 0;
  for (const family of response.families) {
    for (const variant of family.variants) {
      variantCount += 1;
      tierCounts[variant.tier] += 1;
    }
  }

  const correlation = typeof input.correlationHash === 'string'
    ? input.correlationHash.trim().toLowerCase()
    : '';

  return {
    contract_version: PRODUCT_MATCH_CONTRACT_VERSION,
    match_version: PRODUCT_MATCH_VERSION,
    tier: response.tier,
    empty_reason: response.emptyReason ?? null,
    family_count: response.families.length,
    variant_count: variantCount,
    listing_count: response.listings.length,
    tier_counts: tierCounts,
    rows_in: dedupeStats.rowsIn,
    listings_merged_by_url: dedupeStats.listingsMergedByUrl,
    variants_merged_by_exact_id: dedupeStats.variantsMergedByExactId,
    variants_merged_by_colorway: dedupeStats.variantsMergedByColorway,
    variants_with_cross_source_agreement: dedupeStats.variantsWithCrossSourceAgreement,
    first_useful_match_ms: response.timings.firstUsefulMatchMs,
    complete_ms: response.timings.completeMs,
    deadline_exceeded: response.timings.deadlineExceeded,
    partial: response.timings.partial,
    stages: response.timings.stages.map((stage) => ({ ...stage })),
    sequential_equivalent_ms: response.timings.sequentialEquivalentMs,
    baseline_delta_ms: response.timings.baselineDeltaMs,
    first_useful_slow: response.timings.firstUsefulSlow,
    strategies_used: [...response.retrieval.strategiesUsed],
    fallback_used: response.retrieval.fallbackUsed,
    category_conflict_rejections: response.retrieval.categoryConflictRejections,
    low_relevance_rejections: response.retrieval.lowRelevanceRejections,
    test_catalog_exclusions: response.retrieval.testCatalogExclusions,
    potential_similar_item_count: response.potentialSimilarItems.length,
    similarity_threshold_version: response.similarityDiagnostics?.thresholdVersion ?? null,
    similarity_sources_checked: response.similarityRetrieval
      ? [...response.similarityRetrieval.sourcesChecked]
      : [],
    similarity_candidates_considered: response.similarityRetrieval?.recordsConsidered ?? 0,
    similarity_candidates_retained: response.similarityRetrieval?.candidatesRetained ?? 0,
    similarity_retrieve_ms: response.similarityDiagnostics?.retrieveMs ?? 0,
    similarity_compare_ms: response.similarityDiagnostics?.compareMs ?? 0,
    providers: response.providers.map((provider) => ({
      source: provider.source,
      status: provider.status,
      durationMs: provider.durationMs,
      rawCount: provider.rawCount,
    })),
    correlation_hash: HEX_DIGEST.test(correlation) ? correlation : null,
    app_platform: safePlatform(input.appPlatform),
    app_version: safeVersionString(input.appVersion),
  };
}

/**
 * Mechanical privacy gate.
 *
 * Throws rather than logging, so a violation fails a test instead of shipping a
 * warning nobody reads. Called by the endpoint before any sink is considered
 * and asserted directly in the test suite.
 */
export function assertProductMatchTelemetry(event: ProductMatchEvent): void {
  const allowedKeys = new Set([
    'contract_version', 'match_version', 'tier', 'empty_reason',
    'family_count', 'variant_count', 'listing_count', 'tier_counts',
    'rows_in', 'listings_merged_by_url', 'variants_merged_by_exact_id',
    'variants_merged_by_colorway', 'variants_with_cross_source_agreement',
    'first_useful_match_ms', 'complete_ms', 'deadline_exceeded', 'partial',
    'stages', 'sequential_equivalent_ms', 'baseline_delta_ms', 'first_useful_slow',
    'strategies_used', 'fallback_used', 'category_conflict_rejections',
    'low_relevance_rejections', 'test_catalog_exclusions',
    'potential_similar_item_count',
    'similarity_threshold_version', 'similarity_sources_checked',
    'similarity_candidates_considered', 'similarity_candidates_retained',
    'similarity_retrieve_ms', 'similarity_compare_ms',
    'providers', 'correlation_hash', 'app_platform', 'app_version',
  ]);

  for (const key of Object.keys(event)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`product-match telemetry: unexpected field '${key}'`);
    }
  }

  if (event.correlation_hash !== null && !HEX_DIGEST.test(event.correlation_hash)) {
    throw new Error('product-match telemetry: correlation_hash must be a hex digest or null');
  }

  for (const provider of event.providers) {
    if (!(PRODUCT_SOURCES as readonly string[]).includes(provider.source)) {
      throw new Error(`product-match telemetry: unknown provider source '${provider.source}'`);
    }
    if (Object.keys(provider).length !== 4) {
      throw new Error('product-match telemetry: provider record carries unexpected fields');
    }
  }

  for (const strategy of event.strategies_used) {
    if (!(QUERY_STRATEGIES as readonly string[]).includes(strategy)) {
      throw new Error(`product-match telemetry: unknown query strategy '${strategy}'`);
    }
  }

  // Stage rows are categorical by construction; assert it so a future stage
  // added with a free-text label cannot smuggle content into the event.
  for (const stage of event.stages) {
    if (Object.keys(stage).length !== 3) {
      throw new Error('product-match telemetry: stage record carries unexpected fields');
    }
    if (typeof stage.stage !== 'string' || stage.stage.length > 24) {
      throw new Error('product-match telemetry: stage name is not a short label');
    }
  }

  // A URL or an email anywhere in the serialized event is a contract breach, no
  // matter which field carried it.
  const serialized = JSON.stringify(event);
  if (/https?:\/\//i.test(serialized)) {
    throw new Error('product-match telemetry: URL present in event');
  }
  if (/[^\s@]+@[^\s@]+\.[^\s@]+/.test(serialized)) {
    throw new Error('product-match telemetry: email-shaped value present in event');
  }
}

export type ProductMatchTelemetryWriter = (event: ProductMatchEvent) => Promise<void>;

/**
 * Emits an event, if and only if a writer was injected.
 *
 * There is no default writer and no environment variable that supplies one.
 * Persisting product-match telemetry is a separate, authorized change; until
 * then this function validates and drops, which keeps the validation itself
 * exercised in production the moment the endpoint is enabled.
 */
export async function emitProductMatchEvent(
  event: ProductMatchEvent,
  writer?: ProductMatchTelemetryWriter | null,
): Promise<'written' | 'validated_only'> {
  assertProductMatchTelemetry(event);
  if (!writer) return 'validated_only';
  await writer(event);
  return 'written';
}
