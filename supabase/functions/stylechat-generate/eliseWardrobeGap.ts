/**
 * E-4 wardrobe-gap and purchase-advice reasoning (deterministic).
 */

import type {
  EliseAdviceIntent,
  EliseFocusedItem,
  ElisePurchaseAdvice,
  EliseScoredCandidate,
  EliseWardrobeGap,
  EliseAdviceLook,
} from './eliseAdviceTypes.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';

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
}): EliseWardrobeGap {
  const roles = new Set(
    input.shortlist
      .map((s) => s.candidate.layeringRole)
      .filter((r): r is string => Boolean(r)),
  );
  if (input.focus.candidate?.layeringRole) {
    roles.add(input.focus.candidate.layeringRole);
  }

  const gapCodes: string[] = [];
  const categories: string[] = [];
  for (const gap of ROLE_GAPS) {
    if (gap.role === 'neutral') {
      const hasNeutral = input.shortlist.some((s) =>
        s.candidate.colorFamilies.includes('neutral'),
      );
      if (!hasNeutral && input.inventoryCount > 0) {
        gapCodes.push(gap.code);
        categories.push(gap.categoryHint);
      }
      continue;
    }
    if (!roles.has(gap.role)) {
      gapCodes.push(gap.code);
      categories.push(gap.categoryHint);
    }
  }

  const notes: string[] = [];
  const partialInventory =
    Boolean(input.partialFailure) || input.inventoryCount < 3;
  if (partialInventory) {
    notes.push('partial_inventory_available');
  }
  notes.push('gap_scoped_to_authorized_candidates');

  return {
    gapCodes: gapCodes.slice(0, 6),
    categories: categories.slice(0, 6),
    partialInventory,
    notes,
  };
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

export function buildMultiLooks(input: {
  intent: EliseAdviceIntent;
  shortlist: EliseScoredCandidate[];
  wardrobeGap: EliseWardrobeGap | null;
}): EliseAdviceLook[] | null {
  if (input.intent !== 'multi_look_generation' && input.intent !== 'build_outfit') {
    return null;
  }
  if (!input.shortlist.length) return [];

  const labels = ['casual', 'elevated', 'signature_aligned'] as const;
  const looks: EliseAdviceLook[] = [];
  const used = new Set<string>();

  for (let i = 0; i < Math.min(ELISE_ADVICE_LIMITS.multiLookCount, labels.length); i += 1) {
    const picks: string[] = [];
    for (const scored of input.shortlist) {
      if (used.has(scored.candidate.candidateId) && i > 0) continue;
      if (picks.length >= 3) break;
      // Prefer owned first within each look.
      if (
        scored.candidate.actorRelationship === 'owned' ||
        picks.length > 0 ||
        i === labels.length - 1
      ) {
        picks.push(scored.candidate.candidateId);
        used.add(scored.candidate.candidateId);
      }
    }
    // Fill remaining slots without inventing IDs.
    for (const scored of input.shortlist) {
      if (picks.length >= 3) break;
      if (!picks.includes(scored.candidate.candidateId)) {
        picks.push(scored.candidate.candidateId);
      }
    }
    looks.push({
      lookId: `look_${i + 1}`,
      label: labels[i],
      candidateIds: picks.slice(0, 3),
      missingPieceCodes: (input.wardrobeGap?.gapCodes ?? []).slice(0, 2),
    });
  }

  return looks.slice(0, ELISE_ADVICE_LIMITS.multiLookCount);
}
