// Primary-person resolution (Build 2.5 Step 3).
//
// A mirror selfie taken in a shop, a gym or a hallway routinely contains other
// people. Extracting a bystander's clothes into the user's Closet would be both
// wrong and creepy, so this module decides — deterministically, and with a
// documented rule — whose garments the session is about.
//
// THE RULE, in order:
//
//   1. Drop every detection below MIRROR_PERSON_CONFIDENCE_THRESHOLD.
//   2. Rank the survivors by bounding-box AREA, descending.
//   3. Break ties by distance from the image centre, ascending.
//   4. Select automatically ONLY when the largest is at least
//      MIRROR_PERSON_DOMINANCE_RATIO times the runner-up's area.
//   5. Otherwise return `ambiguous` and let the user point at the person.
//
// WHY AREA AND NOT CONFIDENCE. Detector confidence measures "is this a person",
// not "is this the photographer". A sharply-detected bystander four metres back
// can out-score a partially-occluded subject in the foreground. Area is a proxy
// for proximity, and proximity is what actually distinguishes the subject of a
// mirror selfie.
//
// WHY 1.6x. Two people standing side by side at similar depth differ in area by
// well under this, so that case — the one where a silent guess is both likely
// and infuriating — always asks. A background bystander is typically under half
// the subject's area and resolves silently.
//
// STEP 3 NEVER MERGES PEOPLE. Whatever the outcome, exactly one person's
// landmarks reach region derivation. There is no code path that unions two
// detections, and the ambiguous case returns candidates for the USER to pick
// between rather than a combined box.

import {
  MIRROR_PERSON_CONFIDENCE_THRESHOLD,
  MIRROR_PERSON_DOMINANCE_RATIO,
} from '../../types/mirrorExtraction';
import type { NormalizedBounds } from '../../types/mirrorExtraction';
import type { MirrorDetectedPerson } from './mirrorExtractionAdapter';

export type PrimaryPersonResolution =
  | { kind: 'resolved'; person: MirrorDetectedPerson; personCount: number }
  | { kind: 'none'; personCount: 0 }
  | { kind: 'ambiguous'; candidates: MirrorDetectedPerson[]; personCount: number };

function area(bounds: NormalizedBounds): number {
  return Math.max(0, bounds.width) * Math.max(0, bounds.height);
}

/**
 * The region candidates are compared BY — never `bounds`.
 *
 * On Android `bounds` is a full-body box for the posed subject and a face-
 * derived box for everyone else, so comparing bounds would hand the win to the
 * posed subject unconditionally and the ambiguity check would never fire. See
 * the rankingExtent note in mirrorExtractionAdapter.ts.
 */
function rankingArea(person: MirrorDetectedPerson): number {
  return area(person.rankingExtent ?? person.bounds);
}

/** Squared distance from the box centre to the image centre. Squared is enough
 *  for an ordering and avoids a pointless sqrt. */
export function centerDistanceSquared(bounds: NormalizedBounds): number {
  const cx = bounds.x + bounds.width / 2;
  const cy = bounds.y + bounds.height / 2;
  const dx = cx - 0.5;
  const dy = cy - 0.5;
  return dx * dx + dy * dy;
}

/**
 * Total order over detections. Every comparison is decided by a value the
 * detector supplied, so the same input always produces the same ordering on
 * both platforms — no reliance on the runtime's own emission order.
 */
export function compareCandidates(a: MirrorDetectedPerson, b: MirrorDetectedPerson): number {
  const areaDelta = rankingArea(b) - rankingArea(a);
  if (areaDelta !== 0) return areaDelta;
  const centerDelta =
    centerDistanceSquared(a.rankingExtent ?? a.bounds) -
    centerDistanceSquared(b.rankingExtent ?? b.bounds);
  if (centerDelta !== 0) return centerDelta;
  const confidenceDelta = b.confidence - a.confidence;
  if (confidenceDelta !== 0) return confidenceDelta;
  // Final positional tie-break so the order is total even for identical boxes.
  if (a.bounds.x !== b.bounds.x) return a.bounds.x - b.bounds.x;
  return a.bounds.y - b.bounds.y;
}

/**
 * Apply the rule.
 *
 * @param explicitChoiceIndex index into the ORDERED candidate list, supplied
 *        after the user has chosen. Bypasses the dominance test — it is the
 *        user's own answer to the ambiguity — but is still validated, so a
 *        stale index from a previous image cannot select a stranger.
 */
export function resolvePrimaryPerson(
  persons: MirrorDetectedPerson[],
  options: { explicitChoiceIndex?: number | null } = {},
): PrimaryPersonResolution {
  const usable = (Array.isArray(persons) ? persons : []).filter(
    (p) => p && p.confidence >= MIRROR_PERSON_CONFIDENCE_THRESHOLD,
  );

  if (usable.length === 0) return { kind: 'none', personCount: 0 };

  const ordered = [...usable].sort(compareCandidates);

  const choice = options?.explicitChoiceIndex;
  if (typeof choice === 'number' && Number.isInteger(choice)) {
    if (choice < 0 || choice >= ordered.length) {
      // An index that no longer addresses anything is not a selection.
      return { kind: 'ambiguous', candidates: ordered, personCount: ordered.length };
    }
    return { kind: 'resolved', person: ordered[choice], personCount: ordered.length };
  }

  if (ordered.length === 1) {
    return { kind: 'resolved', person: ordered[0], personCount: 1 };
  }

  const topArea = rankingArea(ordered[0]);
  const runnerUpArea = rankingArea(ordered[1]);

  // A zero-area runner-up cannot make anything ambiguous.
  if (runnerUpArea <= 0) {
    return { kind: 'resolved', person: ordered[0], personCount: ordered.length };
  }

  if (topArea >= runnerUpArea * MIRROR_PERSON_DOMINANCE_RATIO) {
    return { kind: 'resolved', person: ordered[0], personCount: ordered.length };
  }

  return { kind: 'ambiguous', candidates: ordered, personCount: ordered.length };
}

/**
 * Coarse bucket for telemetry. Never the raw count.
 *
 * `2_plus`, not `2+`: the telemetry scrub in services/closetTelemetry.ts
 * rejects `+`, and a rejected value is dropped silently rather than loudly.
 */
export function bucketPersonCount(count: number): '0' | '1' | '2_plus' {
  if (!(count > 0)) return '0';
  if (count === 1) return '1';
  return '2_plus';
}
