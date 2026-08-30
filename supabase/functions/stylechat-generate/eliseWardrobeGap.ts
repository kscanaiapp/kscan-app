/**
 * E-4 wardrobe-gap and purchase-advice reasoning (deterministic).
 */

import type {
  EliseAdviceIntent,
  EliseClosetCensus,
  EliseFocusedItem,
  ElisePurchaseAdvice,
  EliseScoredCandidate,
  EliseWardrobeGap,
  EliseAdviceLook,
} from './eliseAdviceTypes.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';
import {
  censusConfirmedAbsentCategories,
  censusConfirmsRoleAbsent,
  censusShowsRolePresent,
} from './eliseClosetCensus.ts';

/**
 * C2 section 28. Below this many authoritative items, a wardrobe-gap listing
 * stops being useful information and becomes an audit of the user's
 * deficiencies. The product goal is to style what is present, so a small Closet
 * gets at most ONE gap -- the one that actually blocks the requested job -- and
 * never a wall of "missing / missing / missing".
 */
const SMALL_CLOSET_ITEM_THRESHOLD = 8;
const SMALL_CLOSET_MAX_GAPS = 1;

/**
 * Roles that a conventional outfit genuinely needs, most-blocking first. When a
 * small Closet forces a single gap, it is drawn from the top of this list, so
 * the one thing surfaced is the one most likely to matter.
 */
const ROLE_PRIORITY = ['shoe', 'bottom', 'base', 'outer', 'accessory'];

const ROLE_GAPS: Array<{ code: string; role: string; categoryHint: string }> = [
  { code: 'missing_shoe', role: 'shoe', categoryHint: 'shoes' },
  { code: 'missing_layer', role: 'outer', categoryHint: 'outerwear' },
  { code: 'missing_bottom', role: 'bottom', categoryHint: 'bottoms' },
  { code: 'missing_base', role: 'base', categoryHint: 'tops' },
  { code: 'missing_accessory', role: 'accessory', categoryHint: 'accessories' },
  { code: 'missing_neutral', role: 'neutral', categoryHint: 'neutral piece' },
];

export function analyzeWardrobeGap(input: {
  focus: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  inventoryCount: number;
  partialFailure?: boolean;
  /**
   * C2 sections 26/27. The deterministic Closet census, when one was available.
   *
   * Its presence changes what a gap MEANS. Without it, a gap says only "this
   * role is missing from the shortlist I looked at". With an exhaustive census
   * it can say "this role is missing from the Closet" -- and only then.
   */
  census?: EliseClosetCensus | null;
  /**
   * Concierge capability. Off -> this function behaves exactly as it did before
   * Concierge, so a flag-off request produces the pre-existing payload.
   */
  conciergeV1?: boolean;
}): EliseWardrobeGap {
  const roles = new Set(
    input.shortlist
      .map((s) => s.candidate.layeringRole)
      .filter((r): r is string => Boolean(r)),
  );
  if (input.focus.candidate?.layeringRole) {
    roles.add(input.focus.candidate.layeringRole);
  }

  const census = input.conciergeV1 ? (input.census ?? null) : null;

  const gapCodes: string[] = [];
  const categories: string[] = [];
  /**
   * AUDIT-CON-002. Per-code provenance, positionally aligned with `gapCodes`.
   *
   * `evidenceIsExhaustive` is a SINGLE boolean that the prompt reads as "you may
   * state plainly that they do not have the listed pieces" and the UI renders as
   * "Your Closet doesn't have ... yet." It is therefore a licence over the whole
   * emitted set, and it can only be granted if EVERY code in that set was
   * actually proven by the census. Tracking provenance per code is what stops a
   * shortlist-derived finding riding out on a census-derived licence.
   */
  const censusProven: boolean[] = [];
  for (const gap of ROLE_GAPS) {
    if (gap.role === 'neutral') {
      const hasNeutral = input.shortlist.some((s) =>
        s.candidate.colorFamilies.includes('neutral'),
      );
      if (!hasNeutral && input.inventoryCount > 0) {
        gapCodes.push(gap.code);
        categories.push(gap.categoryHint);
        // The neutral check reads colour families off the BOUNDED shortlist and
        // never consults the census, so it can only ever be a statement about
        // the pieces reviewed. It is never census-proven.
        censusProven.push(false);
      }
      continue;
    }
    if (roles.has(gap.role)) continue;

    // THE SHORTLIST/CLOSET DISTINCTION (section 26).
    //
    // Absent from the shortlist is where a gap STARTS being suspected. When an
    // exhaustive census is available it is also where the suspicion gets
    // checked: if the census counted items in this role, the role exists in the
    // Closet and simply did not rank -- that is a ranking outcome, not a gap,
    // and reporting it as one is precisely the false claim section 26 names.
    if (census?.exhaustive && censusShowsRolePresent(census, gap.role)) {
      continue;
    }

    gapCodes.push(gap.code);
    categories.push(gap.categoryHint);
    // Suspected is not proven. The gap is reported either way, but only a
    // census that PROVED the absence lets it be spoken as a fact.
    censusProven.push(censusConfirmsRoleAbsent(census, gap.role));
  }

  const notes: string[] = [];
  const partialInventory =
    Boolean(input.partialFailure) || input.inventoryCount < 3;
  if (partialInventory) {
    notes.push('partial_inventory_available');
  }
  notes.push('gap_scoped_to_authorized_candidates');

  let boundedCodes = gapCodes;
  let boundedCategories = categories;
  let boundedProven = censusProven;

  if (input.conciergeV1) {
    // SMALL-CLOSET RESTRAINT (section 28).
    //
    // A three-item Closet is missing almost every role by definition. Listing
    // them all turns a styling answer into a deficiency audit, which is the
    // opposite of the product goal -- so a small Closet surfaces at most one
    // gap, chosen by how much it actually blocks a conventional outfit.
    const closetSize = census?.exhaustive ? census.totalItems : input.inventoryCount;
    if (closetSize > 0 && closetSize < SMALL_CLOSET_ITEM_THRESHOLD) {
      const ordered = gapCodes
        .map((code, index) => ({
          code,
          category: categories[index],
          proven: censusProven[index] ?? false,
          index,
        }))
        .sort((a, b) => {
          const roleA = ROLE_GAPS.find((g) => g.code === a.code)?.role ?? '';
          const roleB = ROLE_GAPS.find((g) => g.code === b.code)?.role ?? '';
          const rankA = ROLE_PRIORITY.indexOf(roleA);
          const rankB = ROLE_PRIORITY.indexOf(roleB);
          return (
            (rankA === -1 ? ROLE_PRIORITY.length : rankA) -
            (rankB === -1 ? ROLE_PRIORITY.length : rankB)
          );
        })
        .slice(0, SMALL_CLOSET_MAX_GAPS);
      boundedCodes = ordered.map((entry) => entry.code);
      boundedCategories = ordered.map((entry) => entry.category);
      boundedProven = ordered.map((entry) => entry.proven);
      notes.push('small_closet_gap_restraint');
    }
  }

  const gap: EliseWardrobeGap = {
    gapCodes: boundedCodes.slice(0, 6),
    categories: boundedCategories.slice(0, 6),
    partialInventory,
    notes,
  };

  if (input.conciergeV1) {
    // The single field every downstream consumer -- prompt, UI and prose guard
    // -- reads before choosing between "you don't own a jacket" and "from what
    // I can see in your Closet". Non-exhaustive evidence can never set it true.
    //
    // AUDIT-CON-002: and only when every SURVIVING gap code was census-proven.
    // `.every` over an empty set is true, which is correct: a set with no claims
    // in it needs no licence, and the flag is inert.
    gap.evidenceIsExhaustive =
      Boolean(census?.exhaustive) &&
      !partialInventory &&
      gap.gapCodes.every((_code, index) => boundedProven[index] === true);
    gap.confirmedAbsentCategories = gap.evidenceIsExhaustive
      ? censusConfirmedAbsentCategories(census, gap.categories)
      : [];
    if (gap.evidenceIsExhaustive) {
      notes.push('gap_confirmed_against_full_closet_census');
    } else {
      notes.push('gap_evidence_bounded_scope_language_required');
    }
  }

  return gap;
}

export function buildPurchaseAdvice(input: {
  intent: EliseAdviceIntent;
  focus: EliseFocusedItem;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
}): ElisePurchaseAdvice | null {
  if (input.intent !== 'purchase_advice' && input.intent !== 'wardrobe_gap') {
    return null;
  }

  const ownedNearDup = input.shortlist.find(
    (s) =>
      s.candidate.actorRelationship === 'owned' &&
      s.score.reasons.includes('near_duplicate_alternative'),
  );
  const savedNearDup = input.shortlist.find(
    (s) =>
      s.candidate.actorRelationship === 'saved' &&
      s.score.reasons.includes('near_duplicate_alternative'),
  );

  if (ownedNearDup) {
    return {
      verdict: 'skip',
      confidence: 0.82,
      reasons: ['owned_near_duplicate', 'no_false_urgency'],
    };
  }
  if (savedNearDup) {
    return {
      verdict: 'skip',
      confidence: 0.74,
      reasons: ['saved_near_duplicate', 'no_false_urgency'],
    };
  }

  if (!input.focus.candidate) {
    return {
      verdict: 'consider',
      confidence: 0.35,
      reasons: ['insufficient_focus_evidence'],
    };
  }

  const gapCount = input.wardrobeGap?.gapCodes.length ?? 0;
  const lowConfidence =
    input.focus.candidate.confidence != null && input.focus.candidate.confidence < 0.4;

  if (lowConfidence) {
    return {
      verdict: 'consider',
      confidence: 0.4,
      reasons: ['low_confidence_metadata', 'insufficient_evidence'],
    };
  }

  if (gapCount >= 2) {
    return {
      verdict: 'buy',
      confidence: 0.68,
      reasons: ['fills_wardrobe_gap', 'retailer_neutral'],
    };
  }

  if (gapCount === 1) {
    return {
      verdict: 'consider',
      confidence: 0.58,
      reasons: ['narrow_or_occasional_utility', 'retailer_neutral'],
    };
  }

  // Strong owned complements exist → item may still be a replace/upgrade if formality differs.
  const ownedPrimary = input.shortlist.find((s) => s.candidate.actorRelationship === 'owned');
  if (ownedPrimary && ownedPrimary.score.total > 0.75) {
    return {
      verdict: 'replace',
      confidence: 0.55,
      reasons: ['possible_role_upgrade', 'owned_complements_exist'],
    };
  }

  return {
    verdict: 'consider',
    confidence: 0.5,
    reasons: ['balanced_utility', 'retailer_neutral'],
  };
}

/**
 * C2 section 29 -- roles that may appear at most ONCE in a single look.
 *
 * Deterministic code is not the stylist here. It supplies structural
 * guardrails only: three tops is not a look, and two pairs of shoes is not a
 * look, regardless of how well they scored. Everything above that floor --
 * which top, which trouser, whether the combination is any good -- stays with
 * the reasoning layer.
 */
const SINGLE_OCCUPANCY_ROLES = new Set(['base', 'mid', 'outer', 'bottom', 'shoe', 'one_piece']);

/**
 * Roles that cannot coexist: a one-piece already occupies the top and bottom of
 * the body, so pairing it with either is not a wearable outfit.
 */
const ROLE_CONFLICTS: Record<string, string[]> = {
  one_piece: ['base', 'bottom'],
  base: ['one_piece'],
  bottom: ['one_piece'],
};

function looksStructurallyValid(
  picked: EliseScoredCandidate[],
  candidate: EliseScoredCandidate,
): boolean {
  const role = candidate.candidate.layeringRole;
  // An item whose role we do not know cannot be proven invalid, and refusing it
  // would silently drop most of a Closet whose taxonomy is thin (section 24 --
  // these axes are a known Phase A data limitation). Unknown roles pass.
  if (!role) return true;

  const takenRoles = picked
    .map((entry) => entry.candidate.layeringRole)
    .filter((value): value is string => Boolean(value));

  if (SINGLE_OCCUPANCY_ROLES.has(role) && takenRoles.includes(role)) return false;

  const conflicts = ROLE_CONFLICTS[role] ?? [];
  if (conflicts.some((conflicting) => takenRoles.includes(conflicting))) return false;

  return true;
}

export function buildMultiLooks(input: {
  intent: EliseAdviceIntent;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
  /** Concierge capability. Off -> pre-Concierge behaviour, unchanged. */
  conciergeV1?: boolean;
}): EliseAdviceLook[] | null {
  if (input.intent !== 'multi_look_generation' && input.intent !== 'build_outfit') {
    return null;
  }
  if (!input.shortlist.length) return [];

  const labels = ['casual', 'elevated', 'signature_aligned'] as const;
  const looks: EliseAdviceLook[] = [];
  const used = new Set<string>();

  for (let i = 0; i < Math.min(ELISE_ADVICE_LIMITS.multiLookCount, labels.length); i += 1) {
    const picked: EliseScoredCandidate[] = [];
    for (const scored of input.shortlist) {
      if (used.has(scored.candidate.candidateId) && i > 0) continue;
      if (picked.length >= 3) break;
      if (input.conciergeV1 && !looksStructurallyValid(picked, scored)) continue;
      // Prefer owned first within each look.
      if (
        scored.candidate.actorRelationship === 'owned' ||
        picked.length > 0 ||
        i === labels.length - 1
      ) {
        picked.push(scored);
        used.add(scored.candidate.candidateId);
      }
    }
    // Fill remaining slots without inventing IDs. A slot that cannot be filled
    // from real evidence stays empty: section 29 is explicit that a Closet
    // which cannot make a conventional outfit must be used honestly rather than
    // padded with a piece the user does not have.
    for (const scored of input.shortlist) {
      if (picked.length >= 3) break;
      if (picked.some((entry) => entry.candidate.candidateId === scored.candidate.candidateId)) {
        continue;
      }
      if (input.conciergeV1 && !looksStructurallyValid(picked, scored)) continue;
      picked.push(scored);
    }

    // A look of one item is not a look. Emitting it as one would present a
    // ranking artefact as a styling decision, so it is dropped rather than
    // padded -- the earlier looks already carry the real recommendation.
    if (input.conciergeV1 && picked.length < 2 && i > 0) continue;

    looks.push({
      lookId: `look_${i + 1}`,
      label: labels[i],
      candidateIds: picked.slice(0, 3).map((entry) => entry.candidate.candidateId),
      missingPieceCodes: (input.wardrobeGap?.gapCodes ?? []).slice(0, 2),
    });
  }

  return looks.slice(0, ELISE_ADVICE_LIMITS.multiLookCount);
}
