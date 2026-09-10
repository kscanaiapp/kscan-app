// Closet Intelligence V1 — deterministic wardrobe facts (PR B).
//
// WHAT THIS IS: one pure function from an already-loaded Closet to a versioned,
// machine-readable set of structured facts.
//
// WHAT IT IS NOT:
//
//     intelligence  !=  Elise
//     intelligence  !=  the Wardrobe Concierge
//     intelligence  !=  generative advice
//     intelligence  !=  shopping, or a gap-to-purchase funnel
//
// COST (section 14). NEW LLM CALLS: 0. NEW EMBEDDING CALLS: 0. NEW VISION
// CALLS: 0. NEW AI PROVIDERS: 0. There is no server intelligence endpoint and no
// durable intelligence store — this is arithmetic over records the device
// already holds, recomputed when the Closet changes.
//
// DETERMINISM (section 56) is a hard requirement, not an aspiration: the same
// Closet must produce a BYTE-EQUIVALENT result on every run. So there is no
// Math.random, no Date.now, no locale-dependent comparison, and every ordering
// ends in an id or key tie-break.
//
// THE CLAIM BOUNDARY (sections 58, 87) is enforced in this file rather than left
// to whoever renders it. Every completeness figure is expressed as a fraction of
// K SCAN AI CLOSET RECORDS, and the type system carries that in the field names.
// This module knows what the user recorded. It does not know what is in their
// wardrobe, what they bought, what fits, or what they spent, and nothing derived
// here may be presented as any of those.

import type { ClosetItemProjection } from '../closetItemProjection';
import {
  summarizeCloset,
  UNCATEGORIZED_FILTER_VALUE,
  type ClosetCategoryCount,
} from './closetInventory';
import { deriveClosetReview } from './closetReview';
import type { ClosetSyncEntry } from './closetSyncContract';

/**
 * Bumped when the SHAPE changes, never when a number changes.
 *
 * This is the program bridge (section 19): downstream evaluation instruments
 * validate their fixtures against this contract, and a shape change that does
 * not bump this version is how a fixture silently stops describing reality.
 */
export const CLOSET_INTELLIGENCE_CONTRACT_VERSION = 1;

/**
 * Coverage of ONE optional field across the actor's Closet records.
 *
 * `populated / total`, plus the floor verdict. `meetsFilterFloor` is the same
 * 70% rule the A1 coverage gate applies, computed here from real data so a
 * consumer never has to re-derive it — and so "this field is too sparse to
 * feature" is a fact the contract states rather than a convention a surface
 * remembers.
 */
export type ClosetFieldCoverage = {
  field: string;
  populated: number;
  /** Records considered. Always the actor's whole Closet. */
  total: number;
  /** Integer percent, floored. No float, so the value is byte-stable. */
  percent: number;
  meetsFilterFloor: boolean;
};

/**
 * A pair the contract believes MIGHT be the same garment recorded twice.
 *
 * V1 CAN NEVER PRODUCE ONE. See `duplicateDetection` below.
 */
export type ClosetDuplicateCandidate = {
  itemIds: readonly string[];
  /** The stable identifier the two records shared. */
  identityKind: string;
  identityValue: string;
};

/**
 * Why duplicate detection produced what it produced.
 *
 * `unavailable_no_stable_identifier` is the ONLY value this build can return,
 * and that is a finding rather than a bug — see the note on
 * `findDuplicateCandidates`.
 */
export type ClosetDuplicateDetectionState =
  | 'unavailable_no_stable_identifier'
  | 'evaluated';

export type ClosetIntelligence = {
  contractVersion: typeof CLOSET_INTELLIGENCE_CONTRACT_VERSION;

  // ── Core, free (section 57) ────────────────────────────────────────────────
  /** Items this actor has recorded in K Scan AI. Never "your wardrobe". */
  totalItems: number;
  /** Category counts, Uncategorized last. Same ordering as the A1 summary. */
  categoryCounts: readonly ClosetCategoryCount[];
  /** Distinct stored categories, excluding the absent bucket. */
  distinctCategoryCount: number;
  reviewRequiredCount: number;

  // ── K+ enhancement (section 57) ────────────────────────────────────────────
  /** Fraction of records carrying a category. The one coverage number that
   *  every intake path can affect. */
  classificationCoverage: ClosetFieldCoverage;
  /** Per-field coverage for the optional taxonomy, in a fixed field order. */
  fieldCoverage: readonly ClosetFieldCoverage[];
  /** Records added in the trailing window. Descriptive only. */
  recentlyAddedCount: number;
  recentlyAddedWindowDays: number;
  /** Records carrying no structured taxonomy at all (`taxonomyUnknown`). */
  unclassifiedItems: number;
  /**
   * Records with no CATEGORY.
   *
   * Deliberately distinct from `unclassifiedItems`, and it is this one the
   * absence licence depends on. An item can carry a colour and a size — so it
   * is not "taxonomy unknown" — while still having no category, and
   * `categoryCounts` is keyed on category alone. Conflating the two produced a
   * contract that licensed absence claims over a Closet with eight
   * uncategorized items in it, which is precisely the weaker second authority
   * section 65 forbids.
   */
  uncategorizedItems: number;
  duplicateCandidates: readonly ClosetDuplicateCandidate[];
  duplicateDetection: ClosetDuplicateDetectionState;

  // ── Absence safety (section 65) ────────────────────────────────────────────
  /**
   * May a consumer read a MISSING category key as "the user owns none of these"?
   *
   * Reuses the doctrine already written down for the Elise census
   * (`censusLicensesAbsenceClaims`, supabase/functions/stylechat-generate/
   * eliseClosetCensus.ts) rather than inventing a second, weaker answer to the
   * same question. Conditions here:
   *
   *   - the whole Closet was read (this contract is computed over the complete
   *     local array, never a page), AND
   *   - every record carries a category, so none could be the one being asked
   *     about, AND
   *   - the category list is complete rather than a top-N slice
   *
   * When false, absence of a category proves nothing: a record the taxonomy
   * could not place might be the very thing being asked about. Absence of
   * classification is not classification of absence.
   */
  licensesAbsenceClaims: boolean;
};

/** The optional taxonomy fields, in a FIXED order. Determinism depends on it. */
const COVERAGE_FIELDS = Object.freeze([
  'brand',
  'primaryColor',
  'clothingType',
  'subtype',
  'material',
  'secondaryColors',
  'size',
] as const);

/** The A1 coverage gate's floor, named once (section 22). */
export const CLOSET_COVERAGE_FILTER_FLOOR_PERCENT = 70;

/** Recently-added window. A constant, never "now minus a config value". */
export const CLOSET_RECENTLY_ADDED_WINDOW_DAYS = 30;

function isPopulated(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

function coverage(field: string, populated: number, total: number): ClosetFieldCoverage {
  // Math.floor, not toFixed: an integer percent is byte-stable, and a float
  // would make two runs differ in their last digit on some engines.
  const percent = total === 0 ? 0 : Math.floor((populated / total) * 100);
  return {
    field,
    populated,
    total,
    percent,
    meetsFilterFloor: total > 0 && percent >= CLOSET_COVERAGE_FILTER_FLOOR_PERCENT,
  };
}

/**
 * Conservative duplicate detection (sections 61, 62).
 *
 * V1 USES EXACT STABLE PRODUCT IDENTITY AND NOTHING ELSE. Explicitly forbidden:
 * fuzzy title similarity, image similarity, perceptual hashing, colour
 * similarity, and the experimental Canonical Product Identity resolver.
 *
 * THE FINDING THIS FUNCTION RECORDS. A committed Closet record carries no
 * product identifier at all — no product id, no SKU, no GTIN/UPC/EAN. Its only
 * stable identifiers are INTERNAL provenance (`sourceCandidateId`,
 * `sourceLineageId`, `sourceSavedScanId`), and those are:
 *
 *   1. deliberately dropped by the read projection, so this contract cannot
 *      see them even if it wanted to, and
 *   2. already unique by construction — `createClosetItem` dedupes on both, so
 *      two live records can never share one.
 *
 * Section 61's own rule therefore decides the outcome: "If no stable identifier
 * exists: NO DUPLICATE CANDIDATE." This build returns an empty list and says
 * WHY, rather than reaching for a similarity heuristic to produce something.
 * Where a real canonical identity could eventually plug in is documented in
 * docs/closet-productization/05-future-requirements.md; nothing experimental is
 * imported or promoted here.
 */
export function findDuplicateCandidates(_items: readonly ClosetItemProjection[]): {
  candidates: ClosetDuplicateCandidate[];
  detection: ClosetDuplicateDetectionState;
} {
  return { candidates: [], detection: 'unavailable_no_stable_identifier' };
}

/**
 * Compute the contract.
 *
 * @param now Injected so the recently-added window is testable and
 *   deterministic. A caller that omits it gets wall-clock, which is correct for
 *   a live screen and is the ONLY non-determinism in this module — it is
 *   confined to one field and one parameter for exactly that reason.
 */
export function computeClosetIntelligence(
  items: readonly ClosetItemProjection[] | null | undefined,
  syncEntries: Readonly<Record<string, ClosetSyncEntry>> = {},
  now: number = Date.now(),
): ClosetIntelligence {
  const source = Array.isArray(items) ? items.filter(Boolean) : [];
  const total = source.length;

  const summary = summarizeCloset(source);
  const review = deriveClosetReview(source, syncEntries);

  let categorized = 0;
  let unclassifiedItems = 0;
  let recentlyAddedCount = 0;
  const populatedCounts = new Map<string, number>(COVERAGE_FIELDS.map((f) => [f, 0]));

  const windowMs = CLOSET_RECENTLY_ADDED_WINDOW_DAYS * 24 * 60 * 60 * 1000;

  for (const item of source) {
    if (isPopulated(item.category)) categorized += 1;
    if (item.taxonomyUnknown === true) unclassifiedItems += 1;

    for (const field of COVERAGE_FIELDS) {
      if (isPopulated((item as unknown as Record<string, unknown>)[field])) {
        populatedCounts.set(field, (populatedCounts.get(field) ?? 0) + 1);
      }
    }

    // A record with no readable createdAt is NOT counted as recent. Unknown age
    // is not newness, and guessing would put a legacy record in a "recently
    // added" figure it does not belong in.
    const created = typeof item.createdAt === 'string' ? Date.parse(item.createdAt) : Number.NaN;
    if (Number.isFinite(created) && now - created <= windowMs && created <= now) {
      recentlyAddedCount += 1;
    }
  }

  const duplicates = findDuplicateCandidates(source);

  // The A1 summary already pins Uncategorized last and is not a top-N slice, so
  // the category list this contract exposes is complete by construction.
  const categoriesTruncated = false;

  return {
    contractVersion: CLOSET_INTELLIGENCE_CONTRACT_VERSION,
    totalItems: total,
    categoryCounts: summary.categories,
    distinctCategoryCount: summary.distinctCategoryCount,
    reviewRequiredCount: review.count,
    classificationCoverage: coverage('category', categorized, total),
    fieldCoverage: COVERAGE_FIELDS.map((field) => coverage(field, populatedCounts.get(field) ?? 0, total)),
    recentlyAddedCount,
    recentlyAddedWindowDays: CLOSET_RECENTLY_ADDED_WINDOW_DAYS,
    unclassifiedItems,
    uncategorizedItems: summary.uncategorizedCount,
    duplicateCandidates: duplicates.candidates,
    duplicateDetection: duplicates.detection,
    // Same three conditions as censusLicensesAbsenceClaims, adapted to a local
    // read: exhaustive (always true here — the whole array was read), every
    // record placed in a category, and a complete category list.
    //
    // The middle condition is UNCATEGORIZED, not taxonomyUnknown. An item with
    // a colour but no category is not "taxonomy unknown", yet it is exactly the
    // item that might belong to the category being asked about. Reading a
    // missing key as "the user owns none of these" while such an item exists is
    // how a taxonomy limitation becomes a confident, false statement about
    // someone's wardrobe.
    licensesAbsenceClaims:
      total > 0 && summary.uncategorizedCount === 0 && !categoriesTruncated,
  };
}

// ── Presentation (section 58) ────────────────────────────────────────────────

/**
 * The one sentence a coverage number may be said in.
 *
 * NEVER "Your wardrobe is 82% complete." K Scan AI does not know the user's
 * physical wardrobe, and a percentage that appears to describe it is a false
 * claim regardless of how the number was computed. Every string this function
 * can return names K Scan AI Closet records explicitly.
 */
export function describeCoverage(entry: ClosetFieldCoverage, label: string): string {
  if (entry.total === 0) return `No items in your K Scan AI Closet yet.`;
  return `${entry.percent}% of items in your K Scan AI Closet have ${label}.`;
}

/**
 * Descriptive category language (section 59).
 *
 * ALLOWED: "You have 14 Tops in K Scan AI."
 * NOT ALLOWED: "You need more Tops." Purchase and gap recommendations belong to
 * a different product surface, and this contract must not grow one.
 */
export function describeCategory(entry: ClosetCategoryCount): string {
  const noun = entry.count === 1 ? 'item' : 'items';
  if (entry.value === UNCATEGORIZED_FILTER_VALUE) {
    return `${entry.count} ${noun} in your K Scan AI Closet have no category yet.`;
  }
  return `You have ${entry.count} ${entry.label} ${noun} in K Scan AI.`;
}

/**
 * Duplicate language (section 62).
 *
 * Users may legitimately own identical garments, so this never says "Duplicate —
 * delete one." There is no auto-merge, no auto-delete, and no merge UI in V1.
 */
export function describeDuplicateCandidate(): string {
  return 'You may have added this item twice.';
}
