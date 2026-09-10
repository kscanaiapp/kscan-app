// Closet Experience V1 — the read-only inventory lens (PR A1).
//
// WHAT THIS IS: pure, deterministic functions over an already-loaded array of
// `ClosetItemProjection`. Summary, search, filter and sort — nothing else.
//
// WHAT IT IS NOT, and the invariants it exists to hold:
//
//     inventory lens  !=  a store
//     inventory lens  !=  a write model
//     inventory lens  !=  a network client
//
// Nothing here reads a file, calls Supabase, mutates a record, or knows an actor
// id. It takes the projections `hooks/useCloset.js` already produced and returns
// new arrays. That is what keeps section 33's local-first invariant true for
// free: search and filter cannot fail when the cloud does, because they never
// touch it.
//
// LOCAL-ONLY SEARCH (section 28). No Supabase endpoint, no full-text index, no
// embedding. Normalization is case-folding plus whitespace collapse and nothing
// else (section 29) — no fuzzy matching, no stemming, no synonyms, so a result
// set is explainable by pointing at the substring that matched.
//
// UNCLASSIFIED ITEMS ARE NEVER HIDDEN (section 30). An item with no category
// belongs to the reserved `UNCATEGORIZED_FILTER_VALUE` bucket, which is a real
// selectable filter value, not an exclusion.

import type { ClosetItemProjection } from '../closetItemProjection';

/** Bumped when the SHAPE below changes, never when a count changes. */
export const CLOSET_INVENTORY_CONTRACT_VERSION = 1;

/**
 * The reserved bucket for an item whose `category` is absent.
 *
 * A sentinel rather than the literal string a user might type: a real garment
 * category called "uncategorized" would otherwise merge with the absent bucket
 * and make "items with no category" unaskable. The `__closet:` prefix cannot
 * collide with a stored value because `buildClosetRecord` trims and bounds
 * every category it persists but never emits this shape.
 */
export const UNCATEGORIZED_FILTER_VALUE = '__closet:uncategorized' as const;

/** Customer-facing label for the reserved bucket. */
export const UNCATEGORIZED_LABEL = 'Uncategorized';

export const CLOSET_SORT_IDS = [
  'recently_added',
  'oldest_added',
  'alphabetical',
  'category',
] as const;
export type ClosetSortId = (typeof CLOSET_SORT_IDS)[number];

export function isClosetSortId(value: unknown): value is ClosetSortId {
  return typeof value === 'string' && (CLOSET_SORT_IDS as readonly string[]).includes(value);
}

/**
 * Sort labels.
 *
 * "Recently added" says ADDED. `createdAt` is the moment the Closet record was
 * written; it is not a purchase date and section 30 forbids calling it one.
 */
export const CLOSET_SORT_LABELS: Readonly<Record<ClosetSortId, string>> = Object.freeze({
  recently_added: 'Recently added',
  oldest_added: 'Oldest added',
  alphabetical: 'A to Z',
  category: 'Category',
});

export const CLOSET_ORIGIN_FILTER_IDS = ['all', 'direct_intake', 'recent_scan'] as const;
export type ClosetOriginFilterId = (typeof CLOSET_ORIGIN_FILTER_IDS)[number];

export function isClosetOriginFilterId(value: unknown): value is ClosetOriginFilterId {
  return (
    typeof value === 'string' && (CLOSET_ORIGIN_FILTER_IDS as readonly string[]).includes(value)
  );
}

/**
 * Origin labels, in customer language.
 *
 * NOT "direct_intake" / "recent_scan". These describe how the user put the item
 * in the Closet, and neither wording implies that scanning alone owns anything —
 * both buckets are already owned items by definition (section 2).
 */
export const CLOSET_ORIGIN_LABELS: Readonly<Record<ClosetOriginFilterId, string>> = Object.freeze({
  all: 'All items',
  direct_intake: 'Added directly',
  recent_scan: 'Added from a scan',
});

export type ClosetCategoryCount = {
  /** The stored category, or UNCATEGORIZED_FILTER_VALUE for the absent bucket. */
  value: string;
  /** What a person reads. */
  label: string;
  count: number;
};

export type ClosetInventorySummary = {
  contractVersion: typeof CLOSET_INVENTORY_CONTRACT_VERSION;
  /** Every item this actor owns in K Scan. */
  totalItems: number;
  /** Deterministic: count desc, then label ascending, Uncategorized always last. */
  categories: readonly ClosetCategoryCount[];
  /** Items whose `category` is absent. */
  uncategorizedCount: number;
  /** Distinct stored categories, EXCLUDING the reserved absent bucket. */
  distinctCategoryCount: number;
};

export type ClosetInventoryQuery = {
  /** Raw user text. Normalized here, never by the caller. */
  search?: string;
  /** A stored category, or UNCATEGORIZED_FILTER_VALUE, or null for "all". */
  category?: string | null;
  origin?: ClosetOriginFilterId;
  sort?: ClosetSortId;
  /**
   * Narrow to the items in `reviewIds` (Closet Ownership V1, PR A2).
   *
   * The ids arrive as DATA. This lens does not know what "needs review" means
   * and must not: the condition is derived in services/closet/closetReview.ts
   * from the item plus its sync state, and duplicating any part of that rule
   * here would create a second, weaker answer to the same question.
   */
  review?: boolean;
  reviewIds?: readonly string[];
};

export type ClosetInventoryResult = {
  contractVersion: typeof CLOSET_INVENTORY_CONTRACT_VERSION;
  items: readonly ClosetItemProjection[];
  /** Items before this query narrowed anything. */
  totalItems: number;
  /** Items after the query. */
  visibleItems: number;
  /** True when a query is actually narrowing — drives "no matches" vs "empty Closet". */
  filtered: boolean;
};

// ── Normalization (section 29) ────────────────────────────────────────────────

/**
 * Case-fold, trim, collapse internal whitespace. That is the whole rule.
 *
 * `toLowerCase()` rather than `toLocaleLowerCase()` deliberately: a locale-aware
 * fold makes the same Closet and the same query produce different results on
 * two devices, which would break the determinism PR B depends on and make a
 * search result impossible to reproduce from a bug report.
 */
export function normalizeClosetSearchText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * The searchable text of one item.
 *
 * Only fields the record actually stores, and only fields a user could
 * reasonably expect to find an item by. Deliberately EXCLUDES `origin` (an
 * internal enum), `id`, and every timestamp — searching "2026" should not return
 * a wardrobe.
 */
function searchableText(item: ClosetItemProjection): string {
  const parts: (string | null)[] = [
    item.title,
    item.category,
    item.clothingType,
    item.subtype,
    item.brand,
    item.primaryColor,
    item.size,
    item.notes,
    ...item.secondaryColors,
    ...item.material,
  ];
  return normalizeClosetSearchText(parts.filter(Boolean).join(' '));
}

// ── Summary (section 26) ──────────────────────────────────────────────────────

/**
 * Category label for a stored value.
 *
 * Title-cases only the first letter of each word and leaves the rest alone, so
 * "t-shirt" reads as "T-shirt" and an already-capitalized "Outerwear" is not
 * mangled into "outerwear". A classifier that returns "TOPS" keeps its own
 * shape rather than being silently rewritten — this is presentation, and it must
 * never be mistaken for normalization of the stored fact.
 */
export function closetCategoryLabel(value: string): string {
  if (value === UNCATEGORIZED_FILTER_VALUE) return UNCATEGORIZED_LABEL;
  return value.replace(/(^|\s)(\p{Ll})/gu, (_m, lead: string, ch: string) => lead + ch.toUpperCase());
}

/**
 * Count what this actor actually owns in K Scan.
 *
 * CLAIM BOUNDARY (section 87): every number here describes ITEMS RECORDED IN
 * K SCAN. Nothing in this file may be presented as the user's whole wardrobe.
 *
 * Ordering is fully deterministic — count descending, then label ascending as a
 * tie-break, with the reserved absent bucket pinned last regardless of size. A
 * `Map` preserves insertion order, which would make the output depend on item
 * order; the explicit sort removes that dependency so PR B can assert
 * byte-equivalence across runs.
 */
export function summarizeCloset(
  items: readonly ClosetItemProjection[] | null | undefined,
): ClosetInventorySummary {
  const source = Array.isArray(items) ? items : [];
  const counts = new Map<string, number>();
  let uncategorizedCount = 0;

  for (const item of source) {
    const category = typeof item?.category === 'string' ? item.category.trim() : '';
    if (!category) {
      uncategorizedCount += 1;
      continue;
    }
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }

  const categories: ClosetCategoryCount[] = [...counts.entries()]
    .map(([value, count]) => ({ value, label: closetCategoryLabel(value), count }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label, 'en'));

  if (uncategorizedCount > 0) {
    categories.push({
      value: UNCATEGORIZED_FILTER_VALUE,
      label: UNCATEGORIZED_LABEL,
      count: uncategorizedCount,
    });
  }

  return {
    contractVersion: CLOSET_INVENTORY_CONTRACT_VERSION,
    totalItems: source.length,
    categories,
    uncategorizedCount,
    distinctCategoryCount: counts.size,
  };
}

// ── Query (sections 28, 30) ───────────────────────────────────────────────────

function matchesCategory(item: ClosetItemProjection, category: string | null | undefined): boolean {
  if (category == null || category === '') return true;
  const stored = typeof item.category === 'string' ? item.category.trim() : '';
  if (category === UNCATEGORIZED_FILTER_VALUE) return stored === '';
  return stored === category;
}

function matchesOrigin(item: ClosetItemProjection, origin: ClosetOriginFilterId): boolean {
  if (origin === 'all') return true;
  return item.origin === origin;
}

/**
 * Sort comparators.
 *
 * EVERY comparator ends in an `id` tie-break. Without it, two items with the
 * same timestamp or the same title would order by whatever `Array.prototype.sort`
 * happens to do, and the same Closet could render differently on two runs. The
 * `id` tie-break is what makes section 56's byte-equivalence assertion possible.
 *
 * A missing timestamp sorts LAST in both time orders rather than being treated as
 * epoch-zero — an item with no `createdAt` is unknown-age, not oldest.
 */
function compareBy(sort: ClosetSortId) {
  const byId = (a: ClosetItemProjection, b: ClosetItemProjection) => a.id.localeCompare(b.id, 'en');

  const time = (item: ClosetItemProjection): number => {
    const raw = item.createdAt;
    if (typeof raw !== 'string' || !raw) return Number.NaN;
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : Number.NaN;
  };

  switch (sort) {
    case 'oldest_added':
      return (a: ClosetItemProjection, b: ClosetItemProjection) => {
        const ta = time(a);
        const tb = time(b);
        if (Number.isNaN(ta) && Number.isNaN(tb)) return byId(a, b);
        if (Number.isNaN(ta)) return 1;
        if (Number.isNaN(tb)) return -1;
        return ta - tb || byId(a, b);
      };
    case 'alphabetical':
      return (a: ClosetItemProjection, b: ClosetItemProjection) =>
        a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || byId(a, b);
    case 'category':
      return (a: ClosetItemProjection, b: ClosetItemProjection) => {
        // Uncategorized sorts last here too, matching the summary's ordering.
        const ca = (a.category ?? '').trim();
        const cb = (b.category ?? '').trim();
        if (!ca && !cb) return a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) || byId(a, b);
        if (!ca) return 1;
        if (!cb) return -1;
        return (
          ca.localeCompare(cb, 'en', { sensitivity: 'base' }) ||
          a.title.localeCompare(b.title, 'en', { sensitivity: 'base' }) ||
          byId(a, b)
        );
      };
    case 'recently_added':
    default:
      return (a: ClosetItemProjection, b: ClosetItemProjection) => {
        const ta = time(a);
        const tb = time(b);
        if (Number.isNaN(ta) && Number.isNaN(tb)) return byId(a, b);
        if (Number.isNaN(ta)) return 1;
        if (Number.isNaN(tb)) return -1;
        return tb - ta || byId(a, b);
      };
  }
}

/**
 * Apply a query to an already-loaded Closet.
 *
 * OFFLINE-SAFE BY CONSTRUCTION (section 33): this function has no I/O of any
 * kind, so a cloud outage cannot degrade search, filter or sort.
 *
 * `filtered` is computed from whether the query NARROWS, not from whether a
 * query object was supplied, so a surface can tell "you own nothing" apart from
 * "nothing matched what you typed" without re-deriving the query itself.
 */
export function queryCloset(
  items: readonly ClosetItemProjection[] | null | undefined,
  query: ClosetInventoryQuery = {},
): ClosetInventoryResult {
  const source = Array.isArray(items) ? items.filter(Boolean) : [];
  const search = normalizeClosetSearchText(query.search);
  const category = query.category ?? null;
  const origin = isClosetOriginFilterId(query.origin) ? query.origin : 'all';
  const sort = isClosetSortId(query.sort) ? query.sort : 'recently_added';

  const reviewOnly = query.review === true;
  // A Set, so a 1000-item Closet with 200 reviewable items is one linear pass
  // rather than 200,000 comparisons.
  const reviewIds = reviewOnly ? new Set(query.reviewIds ?? []) : null;

  const narrowing = search.length > 0 || category !== null || origin !== 'all' || reviewOnly;

  const matched = source.filter(
    (item) =>
      matchesCategory(item, category) &&
      matchesOrigin(item, origin) &&
      (reviewIds === null || reviewIds.has(item.id)) &&
      (search.length === 0 || searchableText(item).includes(search)),
  );

  // `slice()` first: sort mutates, and mutating the array the hook holds in
  // state would make React's identity check miss the change.
  const ordered = matched.slice().sort(compareBy(sort));

  return {
    contractVersion: CLOSET_INVENTORY_CONTRACT_VERSION,
    items: ordered,
    totalItems: source.length,
    visibleItems: ordered.length,
    filtered: narrowing,
  };
}
