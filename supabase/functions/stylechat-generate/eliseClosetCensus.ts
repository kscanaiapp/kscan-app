/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C2 sections 26/27.
 *
 * Deterministic category census of the authoritative Closet.
 *
 * THE PROBLEM THIS SOLVES
 * -----------------------
 * The advice shortlist is bounded (10 items). Reasoning about absence from a
 * bounded shortlist produces a specific, corrosive lie:
 *
 *     "not in the shortlist"  spoken as  "you do not own a jacket"
 *
 * A user who owns four jackets and is told they own none stops trusting every
 * other claim in the answer. Section 27 is explicit that correctness beats
 * artificial completeness, so this module exists to make the distinction
 * checkable rather than assumed.
 *
 * WHY THIS IS NOT "SEND THE CLOSET TO THE LLM"
 * --------------------------------------------
 * The census COUNTS rows; it never reads them out. Its entire output is
 * (category -> integer) and (layering role -> integer) pairs plus a total. No
 * title, brand, colour, note, image or id is produced, so nothing here can
 * reach the prompt as item content. Section 26 asks for deterministic
 * aggregation instead of a bigger prompt, and this is that aggregation.
 *
 * WHY EXHAUSTIVENESS IS MEASURED, NOT ASSUMED
 * -------------------------------------------
 * The census reads a bounded page (`CENSUS_ROW_CAP`) of two tiny columns. When
 * fewer rows come back than the cap, the page WAS the whole Closet and the
 * census is exhaustive -- absence is then a fact. When the cap is hit, the
 * Closet is larger than the page and `exhaustive` is false, which forces every
 * downstream consumer to scope its language rather than assert absence. That
 * is the difference between this and the arbitrary "latest 200 items" sample
 * section 27 forbids: the sample size is not the claim, the cap-hit is.
 */

import { inferLayeringRole } from './eliseFashionFeatures.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';
import type { EliseClosetCensus } from './eliseAdviceTypes.ts';

/**
 * Row cap for the census page. Two narrow columns, so even at the cap this is a
 * small read; the cap exists to bound worst-case latency and memory, not to
 * define the claim. Crossing it degrades the CLAIM (exhaustive -> false), it
 * does not silently truncate the answer.
 */
export const CENSUS_ROW_CAP = 1_000;

/** The minimal row shape the census needs. Deliberately not the item row. */
export interface EliseClosetCensusRow {
  category?: unknown;
  clothing_type?: unknown;
  subtype?: unknown;
}

function asCategoryToken(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return cleaned.slice(0, 40);
}

/**
 * Build the census from an already-fetched page of Closet rows.
 *
 * Pure and synchronous so it is testable without a database: the caller owns
 * the query, this owns the arithmetic and -- critically -- the honesty of
 * `exhaustive`.
 */
export function buildClosetCensus(input: {
  rows: EliseClosetCensusRow[];
  /** The cap the caller queried with. Hitting it means "there may be more". */
  rowCap?: number;
}): EliseClosetCensus {
  const rowCap = input.rowCap ?? CENSUS_ROW_CAP;
  const rows = Array.isArray(input.rows) ? input.rows : [];

  const countsByCategory: Record<string, number> = {};
  const countsByLayeringRole: Record<string, number> = {};
  let unclassifiedItems = 0;

  for (const row of rows) {
    // Prefer the specific garment type over the broad taxonomy bucket, matching
    // the same preference the retrieval mapper applies, so the census and the
    // shortlist speak about categories in one vocabulary rather than two.
    const category =
      asCategoryToken(row.clothing_type) ?? asCategoryToken(row.category);
    const subtype = asCategoryToken(row.subtype);

    if (category) {
      countsByCategory[category] = (countsByCategory[category] ?? 0) + 1;
    }

    const role = inferLayeringRole(category, subtype);
    if (role) {
      countsByLayeringRole[role] = (countsByLayeringRole[role] ?? 0) + 1;
    } else {
      // A row the mapper cannot place. Counting these is what keeps the
      // exhaustiveness claim honest: the page was complete, the CLASSIFICATION
      // was not, and only the second of those licenses "you do not own X".
      unclassifiedItems += 1;
    }
  }

  // Bound the RESULT, keeping the largest categories -- a census that returned
  // an unbounded map would be a way to smuggle Closet shape into the prompt.
  const boundedCategories: Record<string, number> = {};
  for (const [key, value] of Object.entries(countsByCategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, ELISE_ADVICE_LIMITS.censusCategories)) {
    boundedCategories[key] = value;
  }

  return {
    // Strictly fewer rows than the cap proves we saw the end of the table.
    // Equality is deliberately NOT exhaustive: a Closet of exactly `rowCap`
    // items is indistinguishable from a larger one at this call site.
    exhaustive: rows.length < rowCap,
    totalItems: rows.length,
    countsByCategory: boundedCategories,
    countsByLayeringRole,
    unclassifiedItems,
  };
}

/**
 * Does the census PROVE the Closet holds nothing in this layering role?
 *
 * Returns false whenever the census is non-exhaustive -- an unproven absence
 * must never be reported as a confirmed one. This is the single predicate every
 * "you do not own ..." claim has to pass.
 *
 * AUDIT-CON-001. It also returns false while ANY row went unclassified. A row
 * the mapper could not place might be in the very role being asked about --
 * `clothing_type` is free-form user text, so "clogs", "moccasins" or "wellies"
 * are ordinary Closet entries, not edge cases. Reading "no role counted" as
 * "role absent" there turns a taxonomy limitation into a confident, false
 * statement about the customer's own wardrobe, which is the exact failure
 * section 27 exists to prevent. Absence of classification is not classification
 * of absence.
 */
export function censusConfirmsRoleAbsent(
  census: EliseClosetCensus | null,
  role: string,
): boolean {
  if (!census || !census.exhaustive) return false;
  if (census.unclassifiedItems > 0) return false;
  return !(census.countsByLayeringRole[role] > 0);
}

/**
 * Does the census AFFIRMATIVELY show the Closet holds this layering role?
 *
 * The mirror image of `censusConfirmsRoleAbsent`, and deliberately not its
 * negation: a counted row proves PRESENCE outright, while absence additionally
 * requires that nothing went unclassified. Keeping the two predicates separate
 * is what lets a gap be suppressed on proven presence without that same
 * unproven state being read as proven absence.
 */
export function censusShowsRolePresent(
  census: EliseClosetCensus | null,
  role: string,
): boolean {
  if (!census) return false;
  return census.countsByLayeringRole[role] > 0;
}

/**
 * Categories the census PROVES are absent, from a candidate list of interest.
 * Empty whenever the census is non-exhaustive, and -- AUDIT-CON-001 -- whenever
 * any row went unclassified, since such a row carries no category the caller
 * can compare against.
 */
export function censusConfirmedAbsentCategories(
  census: EliseClosetCensus | null,
  categoriesOfInterest: string[],
): string[] {
  if (!census || !census.exhaustive) return [];
  if (census.unclassifiedItems > 0) return [];
  return categoriesOfInterest.filter(
    (category) => !(census.countsByCategory[category] > 0),
  );
}
