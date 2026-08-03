/**
 * Product Match Foundation V1 — canonical contracts.
 *
 * THE THREE-LEVEL MODEL
 *
 *   ProductFamily   "the thing itself"        Nike Air Force 1 '07
 *   ProductVariant  "which one"               Nike Air Force 1 '07, Triple White
 *   ProductListing  "where you can get it"    that variant, on Farfetch, $110
 *
 * The levels exist because the three questions have different answers and
 * different evidence. Today's scanner collapses all three into a flat product
 * array, which is why two listings of the same shoe at two retailers read as
 * two matches, and why a colourway mismatch is indistinguishable from a
 * different model. Confidence is asserted at the level the evidence actually
 * supports: proving the family is not proving the variant.
 *
 * WHY LISTINGS ARE NOT MERGED AWAY
 *
 * A listing is never dropped because a "better" listing exists for the same
 * variant. Price, availability and retailer are the useful part of a listing,
 * and collapsing them loses exactly the information a shopper wants. Dedupe
 * groups listings; it does not discard them.
 *
 * IDENTIFIERS ARE DERIVED, NOT ASSIGNED
 *
 * `familyKey` / `variantKey` / `listingKey` are pure functions of normalized
 * content (see `identity.ts`). Nothing here mints a UUID or persists a row, so
 * two independent runs over the same provider output produce byte-identical
 * keys. That property is what makes the offline benchmark reproducible and what
 * lets dedupe run without a database.
 */

// ── Evidence ─────────────────────────────────────────────────────────────────

/**
 * A single, independently checkable reason to believe a match.
 *
 * Kept as a discriminated list rather than a numeric score so that a tier can
 * always be explained by naming the evidence that produced it. A score alone
 * cannot be audited after the fact, and this phase's whole purpose is that
 * match claims be defensible.
 */
export type EvidenceKind =
  /**
   * An exact, provider-supplied product identifier, from ONE non-authoritative
   * source.
   *
   * Note what this is and is not. Farfetch's `19334521` and KicksCrew's product
   * id are catalogue identifiers *for that retailer*. They pin a variant within
   * that retailer's inventory, which is real and useful, but a single retailer
   * asserting its own row number is not proof that the photographed item is
   * that product. On its own this evidence does not open the EXACT gate.
   */
  | 'exact_product_id'
  /**
   * An identifier from an AUTHORITATIVE identity source — a verified GTIN/UPC/
   * EAN, a manufacturer style code, or a first-party manufacturer record.
   *
   * Decisive on its own. This is the durable definition of exactness: what
   * makes an identifier sufficient is that it is authoritative about product
   * identity, not that two parties happened to repeat it.
   *
   * NO CURRENTLY WIRED SOURCE PRODUCES THIS. It is declared now so the tier
   * rule is written in terms of the right concept rather than in terms of the
   * corroboration workaround, and so a future authoritative feed is a source
   * change rather than a tier-logic rewrite.
   */
  | 'authoritative_product_id'
  /**
   * The same exact identifier, independently produced by two or more sources
   * structurally capable of carrying one.
   *
   * A second, weaker route to decisive identity, available today where
   * `authoritative_product_id` is not. Two independent catalogues agreeing on
   * an identifier is a claim about the product rather than about one retailer's
   * database — but corroboration is EVIDENCE OF authority, not the definition
   * of it, and it must not calcify into the permanent meaning of EXACT.
   */
  | 'corroborated_product_id'
  /** Brand read directly off the garment in the source image, by the scanner. */
  | 'visible_brand_text'
  /** Brand inferred by the identification model, without visible text. */
  | 'brand_guess'
  /** A model/style name token shared between the query and the listing title. */
  | 'model_token'
  /** Normalized colourway agreement. */
  | 'colorway'
  /** Canonical category agreement (footwear vs. outerwear vs. bag ...). */
  | 'category'
  /** Material agreement. */
  | 'material'
  /** Silhouette agreement. */
  | 'silhouette'
  /** Pattern agreement. */
  | 'pattern'
  /** The same variant was produced independently by more than one source. */
  | 'cross_source_agreement';

export type MatchEvidence = {
  kind: EvidenceKind;
  /**
   * Free-text detail, already sanitized for logging (no PII, no raw provider
   * payloads, no URLs beyond the canonical product URL).
   */
  detail?: string;
  /**
   * How much this single piece of evidence contributes, 0..1. Weights are
   * declared in `evidence.ts` rather than inline so the whole scoring surface
   * is reviewable in one place.
   */
  weight: number;
};

// ── Tiers ────────────────────────────────────────────────────────────────────

/**
 * Confidence tiers, strongest first.
 *
 * `EXACT` requires DECISIVE, AUTHORITATIVE IDENTITY EVIDENCE. That is the
 * durable rule. Two routes satisfy it: an authoritative identifier (verified
 * GTIN, manufacturer style code, first-party manufacturer record), or the same
 * identifier corroborated by two independent id-bearing catalogues. The second
 * is a stand-in available today, not the definition — a future authoritative
 * feed reaches EXACT on its own, without needing a second provider.
 *
 * No accumulation of soft signals promotes a match to EXACT, and neither does
 * one retailer's own catalogue row number.
 *
 * Separately and independently, exact claims are DISABLED by default
 * (`PRODUCT_MATCH_EXACT_CLAIMS_ENABLED`, see config.ts) until the evidence
 * paths have been validated end to end. With the flag off a would-be EXACT is
 * reported as `LIKELY_EXACT`. The gate and the flag are two different
 * questions: "is this evidence decisive" and "are we willing to say so in
 * production yet".
 */
export type MatchTier =
  | 'EXACT'
  | 'LIKELY_EXACT'
  | 'PRODUCT_FAMILY'
  | 'SIMILAR'
  | 'NO_CONFIDENT_MATCH';

export const MATCH_TIERS: readonly MatchTier[] = [
  'EXACT',
  'LIKELY_EXACT',
  'PRODUCT_FAMILY',
  'SIMILAR',
  'NO_CONFIDENT_MATCH',
] as const;

/** Rank for ordering and comparison. Lower is stronger. */
export function tierRank(tier: MatchTier): number {
  const index = MATCH_TIERS.indexOf(tier);
  return index === -1 ? MATCH_TIERS.length : index;
}

/**
 * "Useful" means a caller could render it and a shopper could act on it.
 * `SIMILAR` counts: a good similar item is a real answer. `NO_CONFIDENT_MATCH`
 * does not, which is the point of having the tier at all.
 */
export function isUsefulTier(tier: MatchTier): boolean {
  return tier !== 'NO_CONFIDENT_MATCH';
}

// ── Sources ──────────────────────────────────────────────────────────────────

/**
 * Every source this phase can normalize. No new external providers are added
 * here — this is exactly the set already reachable from the deployed
 * `scan-identify` closure, plus the internal catalog.
 */
export type ProductSource =
  | 'kickscrew'
  | 'farfetch'
  | 'serper'
  | 'brave'
  | 'catalog';

export const PRODUCT_SOURCES: readonly ProductSource[] = [
  'kickscrew',
  'farfetch',
  'serper',
  'brave',
  'catalog',
] as const;

/**
 * Whether a source is capable of carrying a first-party product identifier.
 *
 * `serper` and `brave` are web/shopping search surfaces: their "id" is a result
 * position or a hashed URL, never a manufacturer SKU. Treating those as exact
 * identifiers is precisely how a search hit becomes a false EXACT claim, so the
 * capability is declared here and enforced in `evidence.ts`.
 */
export function sourceCanCarryExactId(source: ProductSource): boolean {
  return source === 'kickscrew' || source === 'farfetch' || source === 'catalog';
}

// ── Canonical entities ───────────────────────────────────────────────────────

export type ProductFamily = {
  /** Derived. Stable across runs for identical normalized content. */
  familyKey: string;
  /** Normalized brand, or null when no brand could be established. */
  brand: string | null;
  /** Normalized model/style name, or null. */
  model: string | null;
  /** Canonical category, e.g. 'footwear' | 'outerwear' | 'dress'. */
  canonicalCategory: string | null;
  /** Human-facing label, derived from the strongest listing title. */
  displayName: string;
};

export type ProductVariant = {
  /** Derived. */
  variantKey: string;
  familyKey: string;
  /** Normalized colourway, or null when unknown. */
  colorway: string | null;
  /**
   * Exact identifier when a capable source supplied one. Never synthesized.
   */
  exactProductId: string | null;
  /** Size is carried but never used for identity — listings differ by size. */
  sizeHint: string | null;
};

export type ProductListing = {
  /** Derived from the canonical product URL, or from source+id when absent. */
  listingKey: string;
  variantKey: string;
  familyKey: string;
  source: ProductSource;
  /** Retailer display name. May differ from `source` (Serper surfaces many). */
  retailer: string | null;
  title: string;
  /** Canonicalized product URL (tracking parameters stripped). */
  productUrl: string | null;
  imageUrl: string | null;
  /** Raw price string as provided; not parsed into a number in V1. */
  price: string | null;
  currency: string | null;
  availability: string | null;
};

// ── Match results ────────────────────────────────────────────────────────────

/**
 * One retailer's listings for a variant, rolled up.
 *
 * Retailers list the same product more than once — a sale page, a size-specific
 * page, a syndicated card that resolves to the same product. Grouping by
 * retailer turns that into "Farfetch, from $115 (2 listings)" instead of three
 * near-identical rows, without discarding any of them.
 *
 * Grouping is presentation over the deduped set. Dedupe decides what is the
 * same thing; grouping decides how the surviving listings are arranged.
 */
export type ListingGroup = {
  /** Derived: variantKey + retailer. */
  groupKey: string;
  retailer: string | null;
  source: ProductSource;
  /** Every listing from this retailer for this variant. Never empty. */
  listings: ProductListing[];
  /**
   * A price to show for the group, taken verbatim from the strongest listing.
   * Not parsed, not compared numerically, not converted — V1 has no currency
   * model, and inventing a "lowest price" across unparsed strings would be a
   * claim the data does not support.
   */
  representativePrice: string | null;
};

export type MatchedVariant = {
  variant: ProductVariant;
  tier: MatchTier;
  /** 0..1. Reported for ordering and telemetry; the tier is the contract. */
  confidence: number;
  evidence: MatchEvidence[];
  /** Every listing for this variant, strongest source first. Never empty. */
  listings: ProductListing[];
  /** The same listings, grouped by retailer. */
  groups: ListingGroup[];
  /** Distinct retailers offering this variant. */
  retailerCount: number;
};

export type MatchedFamily = {
  family: ProductFamily;
  /** Strongest tier across the family's variants. */
  tier: MatchTier;
  variants: MatchedVariant[];
};

// ── Advisory similarity against the user's own items ─────────────────────────

/**
 * ADVISORY ONLY. This is not deduplication and must never become it.
 *
 * Commerce dedupe answers "are these two retailer listings the same product",
 * and getting it wrong costs a duplicate row. Closet similarity answers "is the
 * thing you just scanned the thing you already own", and getting it wrong costs
 * the user an item they wanted to keep. Those are not the same risk, so they do
 * not share a mechanism, a threshold, or a vocabulary.
 *
 * Consequently:
 *   - the flag is `potentialSimilarItem`, and it is always `true` when the
 *     record exists. There is no `isDuplicate` field anywhere in this contract,
 *     and adding one would be a breaking change to the safety model, not a
 *     refinement.
 *   - nothing is merged, hidden, replaced or deleted automatically
 *   - both records continue to exist unless the USER decides otherwise
 *   - `resolution` starts as `user_required` and only the user moves it
 */
export type ExistingItemSource = 'closet' | 'recent_scan';

/**
 * Why the two items looked alike. Named reasons rather than a bare score,
 * because the user is being asked to make a judgement and "87% similar" does
 * not help them make it — "same brand, same colour, same category" does.
 */
export type SimilarityReason =
  | 'same_canonical_category'
  | 'same_normalized_color'
  | 'same_brand'
  | 'same_model_tokens'
  | 'same_material'
  | 'same_silhouette'
  | 'same_pattern'
  | 'shared_product_url';

/**
 * Everything the user may choose. All six are offered whenever a comparison is
 * surfaced; the client decides presentation, never eligibility.
 *
 * `keep_both` is listed explicitly rather than being implied by dismissal, so
 * that "these really are two different items" is a recordable answer instead of
 * an absence of one.
 */
export type SimilarItemAction =
  | 'reject_new_scan'
  | 'add_to_closet'
  | 'keep_in_recent_scans'
  | 'delete_existing_item'
  | 'shop_identified_product'
  | 'keep_both';

export const SIMILAR_ITEM_ACTIONS: readonly SimilarItemAction[] = [
  'reject_new_scan',
  'add_to_closet',
  'keep_in_recent_scans',
  'delete_existing_item',
  'shop_identified_product',
  'keep_both',
] as const;

/** Side-by-side comparison payload. Both images, so the user can just look. */
export type SimilarItemComparison = {
  /** The image the user just scanned. */
  newScanImageUri: string | null;
  /** The image of the item they already have. */
  existingItemImageUri: string | null;
  newScanLabel: string | null;
  existingItemLabel: string | null;
};

export type PotentialSimilarItem = {
  /**
   * Always `true`. Present as a literal field so the advisory nature survives
   * serialization into clients, logs and fixtures — a reader who has never seen
   * this file still cannot mistake it for a duplicate verdict.
   */
  potentialSimilarItem: true;
  /** Identifier of the item the user already has. */
  existingItemId: string;
  /** Where it lives now. Shown to the user — "already in your Closet". */
  existingItemSource: ExistingItemSource;
  comparison: SimilarItemComparison;
  /** Named agreements, strongest first. Never empty. */
  reasons: SimilarityReason[];
  /**
   * 0..1, advisory. Orders multiple candidates; never gates an action and never
   * auto-resolves anything.
   */
  advisoryConfidence: number;
  /** Every action the user may take. Always all six. */
  availableActions: SimilarItemAction[];
  /**
   * Always `user_required` from this service. The backend does not resolve a
   * similarity; it reports one.
   */
  resolution: 'user_required';
};

// ── Provider execution reporting ─────────────────────────────────────────────

export type ProviderOutcomeStatus =
  | 'completed'
  | 'empty'
  | 'timeout'
  | 'error'
  | 'skipped'
  | 'disabled';

export type ProviderOutcome = {
  source: ProductSource;
  status: ProviderOutcomeStatus;
  /** Wall-clock duration of this provider's attempt, milliseconds. */
  durationMs: number;
  /** Listings contributed before dedupe. */
  rawCount: number;
  /**
   * Stable, non-sensitive reason string when status is `error`/`skipped`.
   * Never a provider message, never a URL, never a key.
   */
  reason?: string;
};

// ── Request / response envelope ──────────────────────────────────────────────

/**
 * Query attributes. Text only, by design.
 *
 * This endpoint accepts NO image bytes and no image URL. Product retrieval in
 * this phase operates on attributes the scanner has already extracted, so no
 * new category of user data reaches any provider and no new privacy boundary
 * is created. A field for image data would be the boundary change — its absence
 * is the control.
 */
export type ProductMatchQuery = {
  brand?: string | null;
  visibleBrandText?: string | null;
  model?: string | null;
  canonicalCategory?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  styleTags?: string[];
  /** Free-text search hints already produced by the scanner. */
  searchQueries?: string[];
};

/**
 * An item the user already has, supplied by the caller for advisory comparison.
 *
 * The caller owns the closet and the recent-scan list; this service does not
 * read them. Passing candidates in keeps the endpoint free of any user-scoped
 * database access and means the comparison logic can be tested without one.
 *
 * `imageUri` is a reference the CLIENT already holds and will render locally.
 * It is never fetched here and never forwarded to a provider — see the
 * `ProductMatchQuery` note on why no image reaches this service.
 */
export type ExistingItemCandidate = {
  id: string;
  source: ExistingItemSource;
  label?: string | null;
  imageUri?: string | null;
  brand?: string | null;
  model?: string | null;
  canonicalCategory?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  productUrl?: string | null;
};

/**
 * Named query construction paths, strongest identity signal first.
 *
 * The deployed scanner builds one weighted query string and sends it. That
 * conflates two different things — "what is this item" and "how do I search a
 * retailer for it" — and when the result is bad there is no way to tell which
 * signal was responsible. Naming the strategies makes the retrieval attributable:
 * a `caller_supplied` result and a `category_color` result are different claims
 * about how much was actually known.
 */
export type QueryStrategy =
  /** A query the caller already built (the scanner's tuned query). Wins. */
  | 'caller_supplied'
  /** Visible brand text read off the garment + model tokens. */
  | 'visible_brand_model'
  /** Inferred brand + model tokens. */
  | 'brand_model'
  /** Brand + colourway + category. */
  | 'brand_color_category'
  /** Material + silhouette + category — for unbranded items. */
  | 'material_silhouette_category'
  /** Colour + category. The broadest useful query. */
  | 'category_color';

export const QUERY_STRATEGIES: readonly QueryStrategy[] = [
  'caller_supplied',
  'visible_brand_model',
  'brand_model',
  'brand_color_category',
  'material_silhouette_category',
  'category_color',
] as const;

export type PlannedQuery = {
  strategy: QueryStrategy;
  text: string;
  /**
   * `primary` runs immediately. `fallback` runs only if the primary pass
   * produced too few usable listings — see `queryPlanner.ts` for the bound.
   */
  role: 'primary' | 'fallback';
};

export type ProductMatchRequest = {
  query: ProductMatchQuery;
  /** Opaque correlation id supplied by the caller. Not a user identifier. */
  correlationId?: string;
  /** Restrict execution to a subset of sources. Defaults to all eligible. */
  sources?: ProductSource[];
  limit?: number;
  /**
   * Closet and recent-scan items to compare against. Absent or empty means no
   * comparison is attempted — this feature is opt-in per request.
   */
  existingItems?: ExistingItemCandidate[];
  /** Image of the scan being matched, for side-by-side display only. */
  newScanImageUri?: string | null;
  newScanLabel?: string | null;
};

/**
 * Named stages, in execution order. Every one of them is timed on every
 * request.
 *
 * The point of naming them is attribution. "Product match took 2.4 s" is not
 * actionable; "planning 3 ms, retrieval 2210 ms, normalize 9 ms, relevance
 * 4 ms, dedupe 2 ms, tiering 6 ms" tells you the answer is upstream in a
 * provider and that nothing local is worth optimizing.
 */
export type StageName =
  /** Building the category-aware query plan. */
  | 'plan'
  /** Provider execution (concurrent). Wall clock, not summed provider time. */
  | 'retrieve'
  /** Adapting raw provider rows into canonical listings. */
  | 'normalize'
  /** Relevance scoring and category-conflict rejection. */
  | 'relevance'
  /** Cross-source dedupe and grouping. */
  | 'dedupe'
  /** Evidence collection and tier assignment. */
  | 'tier'
  /** Advisory closet / recent-scan similarity. */
  | 'similarity';

export type StageTiming = {
  stage: StageName;
  durationMs: number;
  /**
   * Rows or items the stage handled. Lets a slow stage be read as "slow per
   * item" or "slow because there were 400 items", which are different problems.
   */
  itemCount: number;
};

export type ProductMatchTimings = {
  /** Time from request start to the first listing at a useful tier. */
  firstUsefulMatchMs: number | null;
  /** Time from request start to the fully enriched, deduped result. */
  completeMs: number;
  /** True when the total ceiling cut off at least one in-flight provider. */
  deadlineExceeded: boolean;
  /**
   * True when the result is usable but incomplete — at least one provider was
   * cut off or errored while at least one other returned listings. Surfaced so
   * a caller can decide to re-query later rather than treating a partial answer
   * as final.
   */
  partial: boolean;
  /** Per-stage attribution. See `StageName`. */
  stages: StageTiming[];
  /**
   * Wall clock the same providers would have cost run sequentially, i.e. the
   * sum of their durations. Reported so the value of running them concurrently
   * is visible in the data rather than asserted in a document.
   */
  sequentialEquivalentMs: number;
  /**
   * `completeMs` expressed against `PRODUCT_MATCH_BASELINE_SCAN_MS`. Negative
   * means this stage is inside the current scan's budget. Reported for
   * attribution; nothing branches on it.
   */
  baselineDeltaMs: number;
  /**
   * True when the first useful match arrived later than the observational
   * threshold. A label for finding slow cases in telemetry — it does not mean
   * the request failed, and nothing was truncated because of it.
   */
  firstUsefulSlow: boolean;
};

export type ProductMatchResponse = {
  contractVersion: number;
  version: string;
  /** Strongest tier present anywhere in the result. */
  tier: MatchTier;
  families: MatchedFamily[];
  /** Flattened listings, strongest tier first. Convenience for simple callers. */
  listings: ProductListing[];
  providers: ProviderOutcome[];
  timings: ProductMatchTimings;
  /**
   * Advisory comparisons against items the caller said the user already has.
   * Empty when none were supplied or none looked alike. Never a duplicate
   * verdict — see `PotentialSimilarItem`.
   */
  potentialSimilarItems: PotentialSimilarItem[];
  /** What the query planner did, for attribution. */
  retrieval: RetrievalReport;
  /** Present only when the whole result is empty, explaining why. */
  emptyReason?: 'no_query' | 'no_eligible_providers' | 'no_results' | 'below_confidence';
};

/** What was searched, what came back, and what was thrown away and why. */
export type RetrievalReport = {
  /** Query strategies executed, in order. */
  strategiesUsed: QueryStrategy[];
  /** True when a fallback query ran because the primary was insufficient. */
  fallbackUsed: boolean;
  /** Listings rejected because their category conflicted with the scan's. */
  categoryConflictRejections: number;
  /** Listings rejected for scoring below the relevance floor. */
  lowRelevanceRejections: number;
  /** Catalog rows excluded by the production test-data gate. */
  testCatalogExclusions: number;
};

// ── Guards ───────────────────────────────────────────────────────────────────

export function isProductSource(value: unknown): value is ProductSource {
  return typeof value === 'string' && (PRODUCT_SOURCES as readonly string[]).includes(value);
}

export function isMatchTier(value: unknown): value is MatchTier {
  return typeof value === 'string' && (MATCH_TIERS as readonly string[]).includes(value);
}
