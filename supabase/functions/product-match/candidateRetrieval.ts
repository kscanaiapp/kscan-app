/**
 * Checkpoint 4 — bounded candidate retrieval for the advisory similarity stage.
 *
 * WHAT "RETRIEVAL" MEANS HERE
 *
 * There is NO DATABASE ACCESS in this service (see `closetSimilarity.ts`): the
 * caller already queried its own Closet and Recent Scans and sends candidates
 * in. "Retrieval" in this file is therefore the second of two bounding passes:
 *
 *   1. THE CLIENT bounds a potentially large Closet/Recent-Scans population
 *      down to a request-sized list before it ever leaves the device.
 *   2. THIS MODULE bounds and prunes THAT list further — dropping candidates
 *      that cannot possibly qualify — before the (relatively more expensive)
 *      full comparison in `closetSimilarity.ts` runs on what remains.
 *
 * Doing the cheap rejections here rather than inside the scorer is what makes
 * "candidates rejected before scoring" a real, distinct number rather than a
 * relabelling of the scorer's own output.
 *
 * `sanitizeExistingItemCandidates` (scan-identify) already enforces
 * `MAX_EXISTING_ITEMS` (25) and de-duplicates ids upstream of this module. The
 * cap here is a second, defensive bound — never load-bearing on its own, and
 * documented as such — so this module still behaves correctly if ever called
 * directly with an unsanitized list (e.g. from a future caller, or a test).
 */

import type {
  CandidateRejectionReason,
  ExistingItemCandidate,
  ExistingItemSource,
  ProductMatchQuery,
  SimilarityRetrievalReport,
} from './contracts.ts';
import { normalizeText, slugify } from './identity.ts';

/** Second, defensive bound. See the module header. */
export const MAX_CANDIDATES_SCORED = 20;

const COMPARABLE_FIELDS = [
  'brand', 'model', 'canonicalCategory', 'color', 'material', 'silhouette', 'pattern',
] as const;

/** True when the candidate carries at least one attribute the scorer can use. */
function hasAnyComparableField(existing: ExistingItemCandidate): boolean {
  if (normalizeText(existing.authoritativeId).length > 0) return true;
  if (normalizeText(existing.productUrl).length > 0) return true;
  return COMPARABLE_FIELDS.some((field) => normalizeText(existing[field]).length > 0);
}

/**
 * Cheap, structural category check — the same rule `closetSimilarity.ts` uses
 * as a hard veto, run here BEFORE scoring so a guaranteed-`NO_NOTICE` pair
 * never reaches the (heavier) full comparison.
 */
function hasCategoryConflict(query: ProductMatchQuery, existing: ExistingItemCandidate): boolean {
  const queryCategory = slugify(query.canonicalCategory);
  const existingCategory = slugify(existing.canonicalCategory);
  return queryCategory.length > 0 && existingCategory.length > 0 && queryCategory !== existingCategory;
}

export type CandidateRetrievalInput = {
  query: ProductMatchQuery;
  existingItems: ExistingItemCandidate[];
  now?: () => number;
};

export type CandidateRetrievalResult = {
  retained: ExistingItemCandidate[];
  report: SimilarityRetrievalReport;
};

/**
 * Filters and bounds candidates before scoring, timing itself throughout.
 *
 * Never throws: a malformed entry is excluded rather than raised, consistent
 * with the rest of this feature's rule that a comparison problem must never
 * cost the caller their scan result.
 */
export function retrieveCandidates(input: CandidateRetrievalInput): CandidateRetrievalResult {
  const now = input.now ?? (() => Date.now());
  const startedAt = now();

  const existingItems = Array.isArray(input.existingItems) ? input.existingItems : [];
  const rejectedCounts: Record<CandidateRejectionReason, number> = {
    no_comparable_fields: 0,
    category_conflict: 0,
    over_scoring_cap: 0,
  };

  const sources = new Set<ExistingItemSource>();
  const survivors: ExistingItemCandidate[] = [];

  for (const existing of existingItems) {
    if (!existing || typeof existing !== 'object') continue;
    sources.add(existing.source);

    if (!hasAnyComparableField(existing)) {
      rejectedCounts.no_comparable_fields += 1;
      continue;
    }
    if (hasCategoryConflict(input.query, existing)) {
      rejectedCounts.category_conflict += 1;
      continue;
    }
    survivors.push(existing);
  }

  const overCap = Math.max(0, survivors.length - MAX_CANDIDATES_SCORED);
  rejectedCounts.over_scoring_cap = overCap;
  const retained = survivors.slice(0, MAX_CANDIDATES_SCORED);

  const candidatesRejected = (Object.entries(rejectedCounts) as Array<
    [CandidateRejectionReason, number]
  >)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => ({ reason, count }));

  return {
    retained,
    report: {
      // Stable order, independent of which candidates happened to arrive first.
      sourcesChecked: (['closet', 'recent_scan'] as const).filter((source) => sources.has(source)),
      recordsConsidered: existingItems.length,
      candidatesRetained: retained.length,
      candidatesRejected,
      durationMs: now() - startedAt,
    },
  };
}
