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
   * An exact, provider-supplied product identifier, from ONE source.
   *
   * Note what this is and is not. Farfetch's `19334521` and KicksCrew's product
   * id are catalogue identifiers *for that retailer*. They pin a variant within
   * that retailer's inventory, which is real and useful, but a single retailer
   * asserting its own row number is not proof that the photographed item is
   * that product. On its own this evidence does not open the EXACT gate.
   */
  | 'exact_product_id'
  /**
   * The same exact identifier, independently produced by two or more sources
   * structurally capable of carrying one.
   *
   * This is the only evidence that opens EXACT. Two independent catalogues
   * agreeing on an identifier is a claim about the product rather than about
   * one retailer's database. The scanner cannot currently obtain a manufacturer
   * style code, so in practice this is rare — which is the intended outcome
   * while production exact-match claims are out of scope.
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
 * `EXACT` is deliberately unreachable from inference alone: it requires an
 * exact product identifier CORROBORATED by two independent id-bearing sources.
 * That is a hard rule, not a threshold — no accumulation of soft signals
 * promotes a match to EXACT, and neither does one retailer's own catalogue id,
 * because "this is the exact product" is a claim the current evidence sources
 * cannot support alone. This phase explicitly does not ship production
 * exact-match claims.
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

export type MatchedVariant = {
  variant: ProductVariant;
  tier: MatchTier;
  /** 0..1. Reported for ordering and telemetry; the tier is the contract. */
  confidence: number;
  evidence: MatchEvidence[];
  /** Every listing for this variant, strongest source first. Never empty. */
  listings: ProductListing[];
};

export type MatchedFamily = {
  family: ProductFamily;
  /** Strongest tier across the family's variants. */
  tier: MatchTier;
  variants: MatchedVariant[];
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

export type ProductMatchRequest = {
  query: ProductMatchQuery;
  /** Opaque correlation id supplied by the caller. Not a user identifier. */
  correlationId?: string;
  /** Restrict execution to a subset of sources. Defaults to all eligible. */
  sources?: ProductSource[];
  limit?: number;
};

export type ProductMatchTimings = {
  /** Time from request start to the first listing at a useful tier. */
  firstUsefulMatchMs: number | null;
  /** Time from request start to the fully enriched, deduped result. */
  completeMs: number;
  /** True when the total deadline cut off at least one in-flight provider. */
  deadlineExceeded: boolean;
  /**
   * True when the result is usable but incomplete — at least one provider was
   * cut off or errored while at least one other returned listings. Surfaced so
   * a caller can decide to re-query later rather than treating a partial answer
   * as final.
   */
  partial: boolean;
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
  /** Present only when the whole result is empty, explaining why. */
  emptyReason?: 'no_query' | 'no_eligible_providers' | 'no_results' | 'below_confidence';
};

// ── Guards ───────────────────────────────────────────────────────────────────

export function isProductSource(value: unknown): value is ProductSource {
  return typeof value === 'string' && (PRODUCT_SOURCES as readonly string[]).includes(value);
}

export function isMatchTier(value: unknown): value is MatchTier {
  return typeof value === 'string' && (MATCH_TIERS as readonly string[]).includes(value);
}
