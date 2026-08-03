/**
 * Product Match V1 — category-aware query planning.
 *
 * WHY THIS EXISTS
 *
 * The deployed scanner builds ONE weighted query string from whatever
 * attributes it has and sends it to every provider. Production telemetry shows
 * the consequence: `provider_outcome` is `serper` in essentially every completed
 * row, and `failure_reason` is `commerce_primary_empty` or
 * `product_dedupe_reduction` often enough to matter. A single string that works
 * for "Nike Air Force 1 white" is the wrong string for "grey wool coat", and
 * when it comes back empty nothing records which signal was missing.
 *
 * This module makes two changes:
 *
 *   1. A query is built per NAMED STRATEGY, strongest identity signal first, so
 *      a result can be attributed to what was actually known about the item.
 *   2. Which strategies apply, and in what order, depends on the CATEGORY.
 *      Footwear is identified by model name and colourway; a coat is identified
 *      by material and silhouette. Searching a coat by model name produces
 *      noise, and searching a sneaker by material produces "leather sneakers".
 *
 * CONTROLLED FALLBACK
 *
 * At most ONE fallback query runs, and only when the primary pass returned too
 * few usable listings. The bound is deliberate: the deployed quality-tune path
 * can already re-query, and an unbounded broaden-until-something-comes-back
 * loop is how a scan silently costs four provider round trips and returns
 * results nobody asked for. A fallback is a second chance, not a search.
 *
 * No provider is called from here. This module is pure string construction over
 * attributes the caller already resolved.
 */

import type { PlannedQuery, ProductMatchQuery, QueryStrategy } from './contracts.ts';
import { contentTokens, normalizeColor, normalizeText, slugify } from './identity.ts';

/** Below this many usable listings, the fallback query is allowed to run. */
export const FALLBACK_LISTING_FLOOR = 3;

/** Hard cap on primary queries per request. Cost control, not tuning. */
export const MAX_PRIMARY_QUERIES = 2;

/**
 * Category routes this planner distinguishes.
 *
 * Coarse on purpose. The distinctions that matter for query construction are
 * "is this identified by a model name" and "is this identified by material and
 * shape"; finer taxonomy belongs to the scanner, not to a search-string builder.
 */
export type CategoryRoute = 'footwear' | 'bag' | 'accessory' | 'outerwear' | 'garment' | 'unknown';

const FOOTWEAR = new Set(['footwear', 'shoes', 'shoe', 'sneakers', 'sneaker', 'boots', 'boot', 'heels', 'sandals']);
const BAGS = new Set(['bag', 'bags', 'handbag', 'purse', 'backpack', 'tote']);
const ACCESSORIES = new Set(['accessory', 'accessories', 'jewelry', 'jewellery', 'belt', 'hat', 'scarf', 'sunglasses', 'watch']);
const OUTERWEAR = new Set(['outerwear', 'coat', 'jacket', 'blazer', 'parka', 'trench']);
const GARMENTS = new Set(['top', 'shirt', 'tshirt', 't-shirt', 'blouse', 'sweater', 'knitwear', 'dress', 'skirt', 'pants', 'trousers', 'jeans', 'shorts', 'suit', 'bottom']);

export function categoryRouteOf(canonicalCategory: unknown): CategoryRoute {
  const normalized = normalizeText(canonicalCategory).replace(/-/g, ' ').trim();
  if (!normalized) return 'unknown';
  for (const token of normalized.split(' ')) {
    if (FOOTWEAR.has(token)) return 'footwear';
    if (BAGS.has(token)) return 'bag';
    if (ACCESSORIES.has(token)) return 'accessory';
    if (OUTERWEAR.has(token)) return 'outerwear';
    if (GARMENTS.has(token)) return 'garment';
  }
  return 'unknown';
}

/**
 * Strategy preference per route, strongest first.
 *
 * Footwear leads with model because sneakers ARE their model name and the
 * retailers index them that way. Outerwear and garments lead with material and
 * silhouette because most of them have no model name at all — "wool coat
 * double breasted" retrieves; "Zara coat" does not. Bags and accessories sit in
 * between: branded when the brand is visible, shape-led otherwise.
 */
const ROUTE_STRATEGIES: Record<CategoryRoute, QueryStrategy[]> = {
  footwear: ['visible_brand_model', 'brand_model', 'brand_color_category', 'category_color'],
  bag: ['visible_brand_model', 'brand_model', 'brand_color_category', 'material_silhouette_category', 'category_color'],
  accessory: ['visible_brand_model', 'brand_color_category', 'material_silhouette_category', 'category_color'],
  outerwear: ['visible_brand_model', 'material_silhouette_category', 'brand_color_category', 'category_color'],
  garment: ['visible_brand_model', 'material_silhouette_category', 'brand_color_category', 'category_color'],
  unknown: ['visible_brand_model', 'brand_model', 'brand_color_category', 'category_color'],
};

const MAX_QUERY_LENGTH = 200;

function clean(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  return text;
}

/** Joins parts, dropping empties and token-level duplicates. */
function compose(...parts: unknown[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of parts) {
    const text = clean(part);
    if (!text) continue;
    for (const token of text.split(/\s+/)) {
      const key = slugify(token);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(token);
    }
  }
  return out.join(' ').slice(0, MAX_QUERY_LENGTH);
}

/**
 * Builds the text for one strategy, or null when the required signals are
 * absent.
 *
 * Returning null rather than a degraded string is the important part: a
 * `brand_model` query with no brand is not a weaker brand query, it is a
 * different query wearing the wrong label, and it would make the retrieval
 * report lie about what was known.
 */
export function buildStrategyQuery(
  strategy: QueryStrategy,
  query: ProductMatchQuery,
): string | null {
  const brand = clean(query.brand);
  const visibleBrand = clean(query.visibleBrandText);
  const model = clean(query.model);
  const color = clean(query.color);
  const material = clean(query.material);
  const silhouette = clean(query.silhouette);
  const pattern = clean(query.pattern);
  const category = clean(query.canonicalCategory);

  switch (strategy) {
    case 'caller_supplied': {
      const supplied = query.searchQueries?.find((candidate) => clean(candidate).length > 0);
      return supplied ? clean(supplied).slice(0, MAX_QUERY_LENGTH) : null;
    }
    case 'visible_brand_model': {
      // Requires text actually READ off the garment. This is the strongest
      // brand signal available and must not be satisfied by an inference.
      if (!visibleBrand || !model) return null;
      return compose(visibleBrand, model, color);
    }
    case 'brand_model': {
      if (!brand || !model) return null;
      return compose(brand, model, color);
    }
    case 'brand_color_category': {
      const anyBrand = visibleBrand || brand;
      if (!anyBrand || !category) return null;
      return compose(anyBrand, color, category);
    }
    case 'material_silhouette_category': {
      if (!category) return null;
      if (!material && !silhouette && !pattern) return null;
      return compose(color, material, pattern, silhouette, category);
    }
    case 'category_color': {
      if (!category) return null;
      return compose(color, category);
    }
    default:
      return null;
  }
}

export type QueryPlan = {
  route: CategoryRoute;
  primary: PlannedQuery[];
  /** At most one. Absent when nothing broader than the primaries exists. */
  fallback: PlannedQuery | null;
};

/**
 * Produces the ordered plan for a query.
 *
 * A caller-supplied query always leads when present — the scanner's tuned query
 * encodes work this module deliberately does not duplicate — but it no longer
 * SUPPRESSES the attribute strategies. Checkpoint 1 returned early on a
 * caller-supplied string, which meant the strongest identity signals were never
 * tried when the caller happened to pass anything at all.
 */
export function planQueries(query: ProductMatchQuery): QueryPlan {
  const route = categoryRouteOf(query.canonicalCategory);
  const ordered: QueryStrategy[] = ['caller_supplied', ...ROUTE_STRATEGIES[route]];

  const seenText = new Set<string>();
  const built: PlannedQuery[] = [];

  for (const strategy of ordered) {
    const text = buildStrategyQuery(strategy, query);
    if (!text) continue;
    const key = slugify(text);
    // Two strategies can legitimately produce the same string (a caller-supplied
    // query that happens to equal brand+model). Running it twice would double
    // the provider cost for identical results.
    if (seenText.has(key)) continue;
    seenText.add(key);
    built.push({ strategy, text, role: 'primary' });
  }

  if (built.length === 0) return { route, primary: [], fallback: null };

  const primary = built.slice(0, MAX_PRIMARY_QUERIES);
  // The fallback is the next-broadest query that was NOT already run, never a
  // re-run of a primary and never a newly invented broadening.
  const remaining = built.slice(MAX_PRIMARY_QUERIES);
  const fallbackSource = remaining[remaining.length - 1] ?? null;

  return {
    route,
    primary,
    fallback: fallbackSource ? { ...fallbackSource, role: 'fallback' } : null,
  };
}

/**
 * Whether the bounded fallback should run.
 *
 * Deliberately a function of the RESULT COUNT alone, not of elapsed time. A
 * fallback triggered by a latency budget would be exactly the trade this phase
 * is not making — spending a provider call to fill a gap the clock created
 * rather than one the evidence created.
 */
export function shouldRunFallback(usableListingCount: number): boolean {
  return usableListingCount < FALLBACK_LISTING_FLOOR;
}

/**
 * Tokens the scan asserts about the item, used by relevance scoring.
 * Exported here so query construction and relevance share one vocabulary.
 */
export function queryTokens(query: ProductMatchQuery): {
  brand: string[];
  model: string[];
  color: string | null;
  category: string[];
  attributes: string[];
} {
  return {
    brand: contentTokens(query.visibleBrandText ?? query.brand ?? ''),
    model: contentTokens(query.model ?? ''),
    color: normalizeColor(query.color),
    category: contentTokens(query.canonicalCategory ?? ''),
    attributes: [
      ...contentTokens(query.material ?? ''),
      ...contentTokens(query.silhouette ?? ''),
      ...contentTokens(query.pattern ?? ''),
    ],
  };
}
