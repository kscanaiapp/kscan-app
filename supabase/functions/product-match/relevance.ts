/**
 * Product Match V1 — lightweight relevance scoring and category-conflict
 * rejection.
 *
 * WHAT THIS IS FOR
 *
 * Web shopping search returns adjacent products confidently. A query for a grey
 * wool coat returns coat hangers, coat racks, and "wool coat care spray"; a
 * query for white sneakers returns sneaker cleaner and shoe trees. Production
 * telemetry already shows the scanner discarding results for
 * `category_mismatch_removed`, so this is a known failure mode — this module
 * makes the rejection explicit, attributable and testable rather than a side
 * effect of a filter chain.
 *
 * TWO SEPARATE MECHANISMS, ON PURPOSE
 *
 *   1. CATEGORY CONFLICT is a hard rejection. If the scan says footwear and the
 *      listing is unambiguously a bag, no score can rescue it. A wrong-category
 *      result is not a weak match, it is a different product.
 *
 *   2. RELEVANCE SCORE is a soft floor for everything else. It removes listings
 *      that share nothing with the query beyond having been returned by a
 *      search engine.
 *
 * Conflating them produces the classic failure where a very "relevant-looking"
 * accessory outranks the actual garment because it shares more title tokens.
 *
 * WHAT THIS IS NOT
 *
 * Not a ranker for tiers. Relevance decides whether a listing is admitted at
 * all; `evidence.ts` decides what may be CLAIMED about the ones that are. A
 * listing cannot improve its tier by scoring well here, and nothing in this
 * module reads a clock.
 */

import type { ProductListing, ProductMatchQuery } from './contracts.ts';
import { contentTokens, normalizeColor } from './identity.ts';
import { categoryRouteOf, queryTokens, type CategoryRoute } from './queryPlanner.ts';

/**
 * Minimum score for admission. Below this a listing shares essentially nothing
 * with the query.
 *
 * Set low deliberately. This is a floor against noise, not a precision knob —
 * tightening it to raise precision would silently drop real matches for
 * unbranded items, which are exactly the ones with the fewest title tokens to
 * match on.
 */
export const RELEVANCE_FLOOR = 0.2;

/**
 * Title tokens that identify a listing as an ACCESSORY TO a product rather than
 * the product: care products, storage, spare parts, gift cards.
 *
 * These are rejected regardless of category agreement, because "shoe cleaner"
 * genuinely is footwear-adjacent and would pass a category check.
 */
const ADJACENT_PRODUCT_TOKENS = new Set([
  'cleaner', 'cleaning', 'protector', 'protectant', 'spray', 'wipes', 'brush',
  'polish', 'conditioner', 'deodorizer', 'freshener', 'insole', 'insoles',
  'laces', 'lace', 'shoetree', 'trees', 'hanger', 'hangers', 'rack', 'racks',
  'storage', 'organizer', 'garment', 'cover', 'bagcover', 'dustbag',
  'giftcard', 'voucher', 'repair', 'kit', 'replacement', 'strap', 'straps',
  'stand', 'holder', 'box', 'case',
]);

/**
 * Route-identifying tokens, used to infer what a listing actually IS from its
 * title. Only unambiguous words: `bag` identifies a bag, but `leather` does not
 * identify anything.
 */
const ROUTE_MARKERS: Record<Exclude<CategoryRoute, 'unknown'>, string[]> = {
  footwear: ['sneaker', 'sneakers', 'shoe', 'shoes', 'boot', 'boots', 'trainer', 'trainers', 'loafer', 'loafers', 'heel', 'heels', 'sandal', 'sandals'],
  bag: ['bag', 'handbag', 'tote', 'backpack', 'purse', 'clutch', 'satchel', 'crossbody'],
  accessory: ['belt', 'hat', 'cap', 'scarf', 'glove', 'gloves', 'sunglasses', 'watch', 'earrings', 'necklace', 'bracelet', 'ring'],
  outerwear: ['coat', 'jacket', 'blazer', 'parka', 'trench', 'overcoat', 'anorak'],
  garment: ['shirt', 'tshirt', 'blouse', 'sweater', 'jumper', 'cardigan', 'knit', 'dress', 'skirt', 'trousers', 'pants', 'jeans', 'shorts', 'top'],
};

export type RelevanceVerdict = {
  admitted: boolean;
  score: number;
  reason?: 'category_conflict' | 'adjacent_product' | 'low_relevance';
  /** What the listing appears to be, inferred from its title. */
  inferredRoute: CategoryRoute;
};

/**
 * Infers the route a listing belongs to from its title.
 *
 * Returns `unknown` when nothing unambiguous is present — and `unknown` never
 * conflicts with anything. Guessing a route from weak signals and then
 * rejecting on that guess would discard real listings for a reason nobody could
 * later reconstruct.
 */
export function inferListingRoute(title: unknown): CategoryRoute {
  const tokens = new Set(contentTokens(title));
  for (const [route, markers] of Object.entries(ROUTE_MARKERS) as [Exclude<CategoryRoute, 'unknown'>, string[]][]) {
    if (markers.some((marker) => tokens.has(marker))) return route;
  }
  return 'unknown';
}

function hasAdjacentProductToken(title: unknown): boolean {
  const tokens = contentTokens(title);
  return tokens.some((token) => ADJACENT_PRODUCT_TOKENS.has(token));
}

/**
 * Scores and admits one listing.
 *
 * The score is a weighted count of agreements between the query and the
 * listing's title, normalized to 0..1. It is intentionally crude: this is a
 * noise floor, and a sophisticated scorer here would be doing the tier
 * assignment's job with none of its auditability.
 */
export function scoreListing(
  listing: ProductListing,
  query: ProductMatchQuery,
): RelevanceVerdict {
  const inferredRoute = inferListingRoute(listing.title);

  // ── Hard rejection 1: an accessory TO the product, not the product ───────
  if (hasAdjacentProductToken(listing.title)) {
    return { admitted: false, score: 0, reason: 'adjacent_product', inferredRoute };
  }

  // ── Hard rejection 2: category conflict ──────────────────────────────────
  const queryRoute = categoryRouteOf(query.canonicalCategory);
  if (
    queryRoute !== 'unknown' &&
    inferredRoute !== 'unknown' &&
    queryRoute !== inferredRoute
  ) {
    return { admitted: false, score: 0, reason: 'category_conflict', inferredRoute };
  }

  // ── Soft score ───────────────────────────────────────────────────────────
  const tokens = queryTokens(query);
  const titleTokens = new Set(contentTokens(listing.title));

  let score = 0;
  let possible = 0;

  const award = (weight: number, matched: boolean) => {
    possible += weight;
    if (matched) score += weight;
  };

  if (tokens.brand.length > 0) {
    award(0.35, tokens.brand.every((token) => titleTokens.has(token)));
  }
  if (tokens.model.length > 0) {
    const hits = tokens.model.filter((token) => titleTokens.has(token)).length;
    award(0.30, hits >= Math.ceil(tokens.model.length / 2));
  }
  if (tokens.color) {
    const listingColor = normalizeColor([...titleTokens].join(' '));
    award(0.15, listingColor === tokens.color || titleTokens.has(tokens.color));
  }
  if (tokens.category.length > 0) {
    award(0.10, queryRoute !== 'unknown' && inferredRoute === queryRoute);
  }
  if (tokens.attributes.length > 0) {
    award(0.10, tokens.attributes.some((token) => titleTokens.has(token)));
  }

  // Nothing was known about the item beyond that it was searched for. Admit —
  // rejecting here would empty the result set for every low-signal scan, which
  // is the population most in need of a "similar item" answer.
  if (possible === 0) {
    return { admitted: true, score: RELEVANCE_FLOOR, inferredRoute };
  }

  const normalized = score / possible;
  if (normalized < RELEVANCE_FLOOR) {
    return { admitted: false, score: normalized, reason: 'low_relevance', inferredRoute };
  }
  return { admitted: true, score: normalized, inferredRoute };
}

export type RelevanceFilterResult<T> = {
  admitted: T[];
  categoryConflictRejections: number;
  lowRelevanceRejections: number;
  adjacentProductRejections: number;
};

/**
 * Filters normalized rows by relevance, counting rejections by reason.
 *
 * Counts are returned rather than logged because they belong in the retrieval
 * report: "we found 40 things and threw away 31 for category conflict" is the
 * single most useful diagnostic when a category's results look wrong, and it is
 * invisible if the rejections are silent.
 */
export function filterByRelevance<T extends { listing: ProductListing }>(
  rows: T[],
  query: ProductMatchQuery,
): RelevanceFilterResult<T> {
  const admitted: T[] = [];
  let categoryConflictRejections = 0;
  let lowRelevanceRejections = 0;
  let adjacentProductRejections = 0;

  for (const row of rows) {
    const verdict = scoreListing(row.listing, query);
    if (verdict.admitted) {
      admitted.push(row);
      continue;
    }
    if (verdict.reason === 'category_conflict') categoryConflictRejections += 1;
    else if (verdict.reason === 'adjacent_product') adjacentProductRejections += 1;
    else lowRelevanceRejections += 1;
  }

  return { admitted, categoryConflictRejections, lowRelevanceRejections, adjacentProductRejections };
}
