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
  | 'shared_product_url'
  /**
   * A caller-supplied authoritative identifier (GTIN / UPC / SKU / style code —
   * the caller normalizes to whichever it has) agreed on both sides. Checkpoint
   * 4: stronger than `shared_product_url` because it is not sensitive to the
   * item being relisted at a different URL.
   */
  | 'authoritative_identifier_match';

/**
 * Checkpoint 4 — named NEGATIVE evidence.
 *
 * Symmetric with `SimilarityReason` on purpose: a conflict is exactly as
 * checkable and exactly as nameable as an agreement, and burying it inside a
 * bare score would make "why did this get suppressed" as unanswerable as "why
 * did this get shown" was before `SimilarityReason` existed.
 *
 * `identifier_conflict` and `category_conflict` are STRUCTURAL — either one
 * present means no notice is produced at all, regardless of any other
 * agreement (see `closetSimilarity.ts`). No amount of "same brand, same
 * colour" should outrank a barcode or a canonical category saying these are
 * different products.
 *
 * The other three are SOFT — they lower the net score but do not by themselves
 * block a notice, because a real product legitimately varies this way (a scan
 * can be the same shoe in a different colourway, and telling the user that is
 * more useful than staying silent).
 */
export type ConflictReason =
  | 'identifier_conflict'
  | 'category_conflict'
  | 'different_model_family'
  | 'different_silhouette'
  | 'different_colorway'
  /**
   * Both sides declare a pattern and they disagree — a floral dress against a
   * striped one. Soft rather than structural because pattern vocabulary is
   * noisy ("striped" / "stripe" / "breton") and a single mis-read pattern
   * should lower confidence, not silence a comparison that is otherwise
   * well-evidenced.
   *
   * There is deliberately NO `different_material` counterpart: material text
   * is the noisiest field the scanner emits ("cotton" vs "cotton blend" vs
   * "100% cotton" are the same garment), so a material conflict would fire
   * constantly on agreement. Material only ever contributes positively.
   */
  | 'different_pattern';

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
   * Checkpoint 4 — named disagreements found alongside the agreements above.
   * May be non-empty even when a notice is shown: "same brand, same model,
   * different colourway" is still worth surfacing. Never includes a
   * STRUCTURAL conflict (`identifier_conflict` / `category_conflict`) — those
   * suppress the notice entirely rather than appearing here. Defaults to `[]`
   * when nothing conflicted; always present so a client does not have to treat
   * "absent" and "empty" as different states.
   */
  conflicts: ConflictReason[];
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
  /**
   * Checkpoint 4 — present ONLY when the caller opted in via
   * `ProductMatchRequest.debugSimilarity`. Carries the scoring internals a
   * calibration pass needs (threshold version, classification, evidence mode,
   * coverage, the net score) and is never emitted by default, so a developer
   * debug field can never reach production user copy by accident.
   */
  internal?: SimilarityInternalDebug;
};

/** Checkpoint 4 — dev-only scoring detail. See `PotentialSimilarItem.internal`. */
export type SimilarityInternalDebug = {
  thresholdVersion: string;
  classification: 'POTENTIAL_SIMILAR_ITEM' | 'STRONG_SIMILARITY';
  evidenceMode: 'identifier_backed' | 'attribute_only';
  categoryFamily: 'uniform_basic' | 'identity_strong' | 'general';
  coverage: 'rich' | 'partial' | 'thin';
  imageAvailability: 'both' | 'one_missing' | 'none' | 'poor_quality';
  netScore: number;
  potentialAt: number;
  strongAt: number;
  distinctPositiveClasses: number;
  minDistinctPositiveClasses: number;
  adjustmentsApplied: string[];
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
  /**
   * Phase 7. The scanner's middle taxonomy tier (`item.clothingType`), between
   * `canonicalCategory` and the model/subtype text already carried above.
   * Preserved through this contract as a neutral text attribute — see
   * `queryPlanner.ts`, which reads query fields by name and does not read this
   * one, so carrying it here does not change query construction or ranking.
   */
  clothingType?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  styleTags?: string[];
  /** Free-text search hints already produced by the scanner. */
  searchQueries?: string[];
};

/**
 * Checkpoint 4 — scan-side fields for the advisory closet/recent-scan
 * comparison ONLY.
 *
 * Deliberately NOT part of `ProductMatchQuery`. That type is provider-search
 * input — `queryPlanner.ts` builds literal search strings from it — and the
 * module carries a hard invariant that it is text-only with no URL and no
 * image reference, because either one could otherwise leak into a third-party
 * provider query. `productUrl` and `authoritativeId` are exactly the kind of
 * field this invariant exists to keep out, so they live here instead: on
 * `ProductMatchRequest` directly, alongside `newScanImageUri` / `newScanLabel`
 * (the same "echoed back for comparison, never forwarded to a provider"
 * category those two already are).
 */
export type SimilarityScanIdentity = {
  /** See `ExistingItemCandidate.productUrl`. */
  productUrl?: string | null;
  /** See `ExistingItemCandidate.authoritativeId`. */
  authoritativeId?: string | null;
  /** See `ExistingItemCandidate.imageQuality`. */
  imageQuality?: 'ok' | 'poor' | 'missing' | null;
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
  /** Phase 7. See `ProductMatchQuery.clothingType`. Preserved, not scored. */
  clothingType?: string | null;
  color?: string | null;
  material?: string | null;
  silhouette?: string | null;
  pattern?: string | null;
  productUrl?: string | null;
  /** Checkpoint 4. See `ProductMatchQuery.authoritativeId`. */
  authoritativeId?: string | null;
  /**
   * Checkpoint 4. Explicit quality hint for THIS item's stored image. Defaults
   * to `'ok'` when omitted — see `ProductMatchQuery.newScanImageQuality`.
   */
  imageQuality?: 'ok' | 'poor' | 'missing' | null;
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
  /**
   * Checkpoint 4 — see `SimilarityScanIdentity`. Flattened onto the request
   * (rather than nested) to match the existing `newScanImageUri`/
   * `newScanLabel` fields, which are the same kind of thing: comparison-only,
   * never forwarded to a provider.
   */
  newScanProductUrl?: string | null;
  newScanAuthoritativeId?: string | null;
  newScanImageQuality?: 'ok' | 'poor' | 'missing' | null;
  /**
   * Checkpoint 4 — dev/test opt-in ONLY. When true, each `PotentialSimilarItem`
   * carries `internal` scoring detail (classification, evidence mode, coverage,
   * net score). Never set by a production client; the inspection surface and
   * the calibration tooling are the only intended callers. Absent this flag,
   * `internal` is never populated, which is what keeps developer-only scoring
   * detail out of production user copy structurally rather than by convention.
   */
  debugSimilarity?: boolean;
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
  /**
   * Checkpoint 4. Present whenever `existingItems` was supplied (even empty),
   * absent otherwise — so "the caller sent no candidates" and "the caller sent
   * candidates and none survived retrieval" stay distinguishable. See
   * `candidateRetrieval.ts`.
   */
  similarityRetrieval?: SimilarityRetrievalReport;
  /**
   * Checkpoint 4. Sub-timings inside the single `similarity` entry of
   * `timings.stages`. Kept as a SEPARATE field rather than new stage names so
   * the governed `stages` sequence (`plan, retrieve, normalize, relevance,
   * dedupe, tier, similarity`) never changes shape for an existing consumer.
   */
  similarityDiagnostics?: SimilarityStageDiagnostics;
  /** Present only when the whole result is empty, explaining why. */
  emptyReason?: 'no_query' | 'no_eligible_providers' | 'no_results' | 'below_confidence';
};

/**
 * Checkpoint 4 — candidate-retrieval accounting for the advisory similarity
 * stage. Answers "what did we even have to compare against" independently of
 * "how many comparisons were shown" (`potentialSimilarItems.length`), because
 * a calibration pass needs both — a threshold change can only be judged
 * against the population it ran over.
 */
export type SimilarityRetrievalReport = {
  /** Sources the caller actually supplied candidates from. */
  sourcesChecked: ExistingItemSource[];
  /** Candidates the caller sent, before any filtering here. */
  recordsConsidered: number;
  /** Candidates that survived pre-score filtering and were actually compared. */
  candidatesRetained: number;
  /** Candidates dropped before scoring, by named reason. Sums to the delta
   *  between `recordsConsidered` and `candidatesRetained`. */
  candidatesRejected: Array<{ reason: CandidateRejectionReason; count: number }>;
  /** Wall-clock time spent on retrieval/pre-filtering, milliseconds. */
  durationMs: number;
};

/**
 * Why a candidate was dropped before it ever reached scoring. Named so
 * "rejected before scoring" is attributable rather than a bare count.
 */
export type CandidateRejectionReason =
  /** Neither side has a single comparable attribute — scoring would be a
   *  guaranteed no-op, so it is skipped rather than performed. */
  | 'no_comparable_fields'
  /** A structural category conflict was cheap to detect up front — see
   *  `ConflictReason.category_conflict`. Rejecting here means the (more
   *  expensive) full comparison never runs for an item that could never
   *  qualify anyway. */
  | 'category_conflict'
  /** Beyond the per-request candidate cap, after the caller's own list was
   *  already within `MAX_EXISTING_ITEMS` — a second, defensive bound. */
  | 'over_scoring_cap';

/** Checkpoint 4 — timing breakdown for the `similarity` stage. */
export type SimilarityStageDiagnostics = {
  thresholdVersion: string;
  /** Time spent selecting/pruning candidates, before any pair was scored. */
  retrieveMs: number;
  /** Time spent scoring the retained candidates. */
  compareMs: number;
  /** `retrieveMs + compareMs`, i.e. the total cost of the `similarity` stage. */
  totalMs: number;
  /** `potentialSimilarItems.length` before the display cap was applied. */
  classifiedBeforeCap: number;
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
