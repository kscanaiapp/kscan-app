// Dominant-garment resolution for Elise's ITEM-path photo attachments.
//
// WHY THIS EXISTS
//
// Elise's direct photo attachment (`elise_camera` / `elise_gallery`) analyses
// ONE garment, so the client refuses to guess when detection reports several
// candidates: `identifyPreparedImageForStyle` returns `needs_selection` for
// `candidates.length > 1` on the `item` policy, and the composer shows a
// terminal "several items found" chip.
//
// That rule is right for a genuinely ambiguous photo and wrong for an ordinary
// one. A close-up of a worn top routinely includes an incidental sliver of the
// trousers below it. Detection is correct to notice the second garment, but
// requiring the user to crop every other garment out of a normal fashion photo
// is not a product we want. The detector is not the defect; treating
// "more than one candidate" as terminal is.
//
// This module answers, server-side, the only question the client cannot:
// is one of these garments unambiguously the subject of the photo?
//
// THE RULE
//
//   1. Rank candidates by bounding-box AREA, descending.
//   2. Break ties by distance from the image centre, ascending.
//   3. Resolve automatically ONLY when the largest is at least
//      ELISE_GARMENT_DOMINANCE_RATIO times the runner-up's area.
//   4. Otherwise report `ambiguous` and leave every candidate in place, so the
//      caller's existing selection behaviour is exactly what it is today.
//
// NOT INVENTED HERE. Steps 1-4 and the 1.6 ratio are the shipped
// `resolvePrimaryPerson` rule from `services/mirror/mirrorPersonResolution.ts`
// (`MIRROR_PERSON_DOMINANCE_RATIO`, Build 2.5), applied to garment boxes
// instead of person boxes. 1.6 was chosen there because two subjects at
// comparable prominence differ in area by well under it — so the case where a
// silent guess is both likely and infuriating always asks — while an
// incidental subject sits well under half the main one's area and resolves
// silently. Both properties are what this path needs, and re-deriving a second
// threshold for the same question would only create two answers to it.
//
// WHY AREA AND NOT CONFIDENCE. `SanitizedDetectedGarment.confidenceScore` is
// the model's self-reported certainty that it classified the garment
// correctly, not a claim about which garment the photo is OF. A crisply
// classified waistband can out-score a partly out-of-frame coat. Area is a
// proxy for prominence, and prominence is the actual question.
//
// Note one deliberate departure from the mirror rule: it drops detections
// below a confidence floor before ranking. This does not, because dropping a
// low-confidence garment can only ever turn an ambiguous photo into a
// confident-looking one — the precise failure this module must not cause.
// Every detected garment gets a vote on whether the image is ambiguous.
//
// EVERY CANDIDATE MUST CARRY BOUNDS. A garment the provider located but did
// not box cannot be ranked, and a comparison that silently skipped it would
// rank an incomplete field. Detection can legitimately omit `bounds`, so a set
// with any unboxed candidate is `ambiguous` — never a guess drawn from
// whichever garments happened to be measurable.
//
// SCOPE. Applies only to the two Elise item entry paths named in
// ELISE_ITEM_ENTRY_PATHS. Scanner (`scanner_*`), Closet (`closet_*`) and
// Elise's outfit-oriented header gallery (`elise_header_gallery`) are
// untouched: they either want the full multi-item candidate set or route it
// through a UX that already resolves it.

import type { SanitizedDetectedGarment } from './multiItemGarments.ts';

/**
 * See MIRROR_PERSON_DOMINANCE_RATIO in types/mirrorExtraction.ts. Deliberately
 * the same number as the person rule it is ported from, not a second one tuned
 * for garments.
 */
export const ELISE_GARMENT_DOMINANCE_RATIO = 1.6;

/**
 * The entry paths whose UX analyses exactly one garment.
 *
 * `elise_header_gallery` is absent on purpose: it is outfit-oriented and
 * identifies the whole bounded candidate set, so collapsing it to one garment
 * would delete evidence it exists to gather.
 */
export const ELISE_ITEM_ENTRY_PATHS = ['elise_camera', 'elise_gallery'] as const;

export type EliseDominantGarmentResolution =
  | { kind: 'dominant'; garment: SanitizedDetectedGarment; reason: 'single' | 'area_dominance' }
  | { kind: 'ambiguous'; reason: 'no_candidates' | 'missing_bounds' | 'comparable_area' };

/** True only for the Elise entry paths whose UX analyses one garment. */
export function isEliseItemEntryPath(entryPath: string | null | undefined): boolean {
  return (ELISE_ITEM_ENTRY_PATHS as readonly string[]).includes(String(entryPath));
}

type GarmentBounds = NonNullable<SanitizedDetectedGarment['bounds']>;

function area(bounds: GarmentBounds): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

/** Squared distance from a box centre to the image centre; squared is enough
 *  to order by and avoids a pointless sqrt. */
function centerDistanceSquared(bounds: GarmentBounds): number {
  const dx = bounds.x + bounds.width / 2 - 0.5;
  const dy = bounds.y + bounds.height / 2 - 0.5;
  return dx * dx + dy * dy;
}

/**
 * Total order over boxed garments. Every comparison is decided by a value
 * detection supplied, so the same detection always produces the same order and
 * the outcome never depends on the provider's emission order.
 */
function compareGarments(a: SanitizedDetectedGarment, b: SanitizedDetectedGarment): number {
  const boundsA = a.bounds;
  const boundsB = b.bounds;
  // Unreachable once `resolve` has rejected unboxed sets; ordered defensively
  // rather than throwing, so a future caller cannot get a partial sort.
  if (!boundsA || !boundsB) return boundsA ? -1 : boundsB ? 1 : 0;

  const areaDelta = area(boundsB) - area(boundsA);
  if (areaDelta !== 0) return areaDelta;
  const centerDelta = centerDistanceSquared(boundsA) - centerDistanceSquared(boundsB);
  if (centerDelta !== 0) return centerDelta;
  // Final positional tie-breaks so the order is total even for identical boxes.
  if (boundsA.x !== boundsB.x) return boundsA.x - boundsB.x;
  if (boundsA.y !== boundsB.y) return boundsA.y - boundsB.y;
  return a.order - b.order;
}

/**
 * Apply the rule to one detection's garments.
 *
 * Never mutates or reorders the input: the caller keeps the detection exactly
 * as it arrived for every non-`dominant` outcome.
 */
export function resolveEliseDominantGarment(
  garments: readonly SanitizedDetectedGarment[],
): EliseDominantGarmentResolution {
  if (!Array.isArray(garments) || garments.length === 0) {
    return { kind: 'ambiguous', reason: 'no_candidates' };
  }
  if (garments.length === 1) {
    // One candidate is already the client's auto-continue case; naming it
    // `dominant` keeps the caller from having to special-case it.
    return { kind: 'dominant', garment: garments[0], reason: 'single' };
  }
  if (garments.some((garment) => !garment.bounds)) {
    return { kind: 'ambiguous', reason: 'missing_bounds' };
  }

  const ordered = [...garments].sort(compareGarments);
  const topArea = area(ordered[0].bounds as GarmentBounds);
  const runnerUpArea = area(ordered[1].bounds as GarmentBounds);

  // A degenerate box cannot establish dominance either way. `cleanBounds`
  // clamps width and height to a 0.01 floor, so this is unreachable through
  // the sanitizer — it exists so a future caller passing raw boxes still
  // cannot get a guess out of this function.
  if (!(topArea > 0) || !(runnerUpArea > 0)) {
    return { kind: 'ambiguous', reason: 'comparable_area' };
  }
  if (topArea >= runnerUpArea * ELISE_GARMENT_DOMINANCE_RATIO) {
    return { kind: 'dominant', garment: ordered[0], reason: 'area_dominance' };
  }
  return { kind: 'ambiguous', reason: 'comparable_area' };
}
