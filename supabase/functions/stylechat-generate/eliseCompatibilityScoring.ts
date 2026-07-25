/**
 * E-4 deterministic compatibility scoring.
 * Numeric scores are never taken from model output.
 */

import type {
  EliseCompatibilityScore,
  EliseFocusedItem,
  EliseRecommendationRole,
  EliseScoredCandidate,
  EliseWardrobeCandidate,
} from './eliseAdviceTypes.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';
import type { EliseAdviceIntent } from './eliseAdviceTypes.ts';

function clamp(n: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, n));
}

function overlapScore(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0.35;
  const setB = new Set(b.map((x) => x.toLowerCase()));
  let hits = 0;
  for (const item of a) {
    if (setB.has(item.toLowerCase())) hits += 1;
  }
  return clamp(hits / Math.max(a.length, 1));
}

function categoryRoleScore(
  focus: EliseWardrobeCandidate | null,
  candidate: EliseWardrobeCandidate,
  intent: EliseAdviceIntent,
): { score: number; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!focus?.category && !focus?.layeringRole) {
    warnings.push('low_confidence_focus_category');
    return { score: 0.4, reasons, warnings };
  }
  const focusRole = focus.layeringRole;
  const candRole = candidate.layeringRole;
  if (intent === 'shoe_pairing') {
    const ok = candRole === 'shoe' || /shoe|boot|sneaker|heel/i.test(candidate.category ?? '');
    if (ok) reasons.push('shoe_role_match');
    return { score: ok ? 0.95 : 0.1, reasons, warnings };
  }
  if (intent === 'accessory_pairing') {
    const ok = candRole === 'accessory';
    if (ok) reasons.push('accessory_role_match');
    return { score: ok ? 0.9 : 0.15, reasons, warnings };
  }
  if (intent === 'layering_advice') {
    if (focusRole && candRole && focusRole !== candRole) {
      reasons.push('layering_complement');
      return { score: 0.9, reasons, warnings };
    }
  }
  if (focusRole && candRole) {
    if (focusRole === candRole) {
      // Same role is useful for alternatives / redundancy checks.
      reasons.push('same_category_role');
      return {
        score: intent === 'find_owned_alternative' || intent === 'find_saved_alternative' ? 0.85 : 0.35,
        reasons,
        warnings,
      };
    }
    const complementary =
      (focusRole === 'base' && (candRole === 'bottom' || candRole === 'outer' || candRole === 'shoe')) ||
      (focusRole === 'one_piece' && (candRole === 'shoe' || candRole === 'outer' || candRole === 'accessory')) ||
      (focusRole === 'bottom' && (candRole === 'base' || candRole === 'outer' || candRole === 'shoe')) ||
      (focusRole === 'outer' && (candRole === 'base' || candRole === 'bottom'));
    if (complementary) {
      reasons.push('category_role_complement');
      return { score: 0.88, reasons, warnings };
    }
  }
  return { score: 0.45, reasons, warnings };
}

function colorHarmonyScore(
  focus: EliseWardrobeCandidate | null,
  candidate: EliseWardrobeCandidate,
): { score: number; reasons: string[]; warnings: string[] } {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!focus || (!focus.colors.length && !focus.colorFamilies.length)) {
    warnings.push('vague_color_metadata');
    return { score: 0.4, reasons, warnings };
  }
  if (!candidate.colors.length && !candidate.colorFamilies.length) {
    warnings.push('vague_candidate_color');
    return { score: 0.35, reasons, warnings };
  }
  const familyOverlap = overlapScore(focus.colorFamilies, candidate.colorFamilies);
  const directOverlap = overlapScore(focus.colors, candidate.colors);
  if (directOverlap > 0.5) {
    reasons.push('monochromatic_or_tonal');
    return { score: 0.82, reasons, warnings };
  }
  if (focus.colorFamilies.includes('neutral') || candidate.colorFamilies.includes('neutral')) {
    reasons.push('neutral_pairing');
    return { score: 0.8, reasons, warnings };
  }
  if (familyOverlap > 0) {
    reasons.push('analogous_family');
    return { score: 0.7, reasons, warnings };
  }
  // Cautious high-contrast without claiming exact complementarity.
  reasons.push('contrast_possible');
  return { score: 0.55, reasons, warnings };
}

function silhouetteScore(
  focus: EliseWardrobeCandidate | null,
  candidate: EliseWardrobeCandidate,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const a = focus?.proportionRole;
  const b = candidate.proportionRole;
  if (!a || !b) return { score: 0.45, reasons };
  if (a === 'volume' && b === 'streamlined') {
    reasons.push('volume_streamlined_balance');
    return { score: 0.88, reasons };
  }
  if (a === 'streamlined' && b === 'volume') {
    reasons.push('streamlined_volume_balance');
    return { score: 0.86, reasons };
  }
  if (a === 'cropped' && b === 'streamlined') {
    reasons.push('cropped_high_rise_balance');
    return { score: 0.8, reasons };
  }
  if (a === b) {
    reasons.push('similar_proportion');
    return { score: 0.5, reasons };
  }
  return { score: 0.6, reasons };
}

function ownershipPriorityScore(candidate: EliseWardrobeCandidate): number {
  switch (candidate.actorRelationship) {
    case 'owned':
      return 1;
    case 'saved':
      return 0.75;
    case 'scanned':
      return 0.55;
    case 'shared':
      return 0.45;
    case 'discovered':
      return 0.25;
    default:
      return 0.2;
  }
}

function redundancyPenalty(
  focus: EliseWardrobeCandidate | null,
  candidate: EliseWardrobeCandidate,
  intent: EliseAdviceIntent,
): { score: number; reasons: string[]; warnings: string[] } {
  // Higher dimension value = better (less redundant) for total score.
  // For alternative intents, similarity is rewarded elsewhere via categoryRole.
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (!focus) return { score: 0.7, reasons, warnings };
  const sameCat =
    focus.category &&
    candidate.category &&
    focus.category.toLowerCase() === candidate.category.toLowerCase();
  const colorNear = overlapScore(focus.colors, candidate.colors) > 0.6;
  if (sameCat && colorNear) {
    if (intent === 'find_owned_alternative' || intent === 'find_saved_alternative' || intent === 'purchase_advice') {
      reasons.push('near_duplicate_alternative');
      return { score: 0.2, reasons, warnings }; // high redundancy → low (penalty dimension)
    }
    warnings.push('possible_redundancy');
    return { score: 0.25, reasons, warnings };
  }
  return { score: 0.85, reasons, warnings };
}

export function scoreWardrobeCompatibility(input: {
  focus: EliseWardrobeCandidate | null;
  candidate: EliseWardrobeCandidate;
  intent: EliseAdviceIntent;
  occasionTokens?: string[];
  seasonTokens?: string[];
  signatureStyleTokens?: string[];
}): EliseCompatibilityScore {
  const { focus, candidate, intent } = input;
  const cat = categoryRoleScore(focus, candidate, intent);
  const color = colorHarmonyScore(focus, candidate);
  const sil = silhouetteScore(focus, candidate);
  const material = {
    score: overlapScore(focus?.materials ?? [], candidate.materials) || 0.4,
    reasons: [] as string[],
  };
  if (material.score > 0.5) material.reasons.push('material_affinity');

  let formality = 0.45;
  const formalityReasons: string[] = [];
  if (focus?.formality && candidate.formality) {
    formality =
      focus.formality.toLowerCase() === candidate.formality.toLowerCase() ? 0.9 : 0.4;
    if (formality > 0.7) formalityReasons.push('formality_aligned');
  }

  let season = 0.45;
  const seasonReasons: string[] = [];
  if (input.seasonTokens?.length && candidate.seasons.length) {
    season = Math.max(0.4, overlapScore(input.seasonTokens, candidate.seasons));
    if (season > 0.6) seasonReasons.push('season_aligned');
  } else if (focus?.seasons.length) {
    season = Math.max(0.4, overlapScore(focus.seasons, candidate.seasons));
  }

  let occasion = 0.45;
  const occasionReasons: string[] = [];
  if (input.occasionTokens?.length) {
    occasion = Math.max(
      0.35,
      overlapScore(input.occasionTokens, [
        ...candidate.occasions,
        ...candidate.styleAttributes,
        candidate.formality ?? '',
      ].filter(Boolean)),
    );
    if (occasion > 0.6) occasionReasons.push('occasion_aligned');
  }

  let signatureStyle = 0.45;
  const sigReasons: string[] = [];
  if (input.signatureStyleTokens?.length) {
    signatureStyle = Math.max(
      0.35,
      overlapScore(input.signatureStyleTokens, [
        ...candidate.styleAttributes,
        ...candidate.colors,
        candidate.silhouette ?? '',
        candidate.formality ?? '',
      ].filter(Boolean)),
    );
    if (signatureStyle > 0.55) sigReasons.push('signature_style_affinity');
  }

  const ownership = ownershipPriorityScore(candidate);
  const redundancy = redundancyPenalty(focus, candidate, intent);

  const dimensions = {
    categoryRole: cat.score,
    colorHarmony: color.score,
    silhouetteBalance: sil.score,
    materialTexture: material.score,
    formality,
    season,
    occasion,
    signatureStyle,
    ownershipPriority: ownership,
    redundancyPenalty: redundancy.score,
  };

  const total = clamp(
    dimensions.categoryRole * 0.18 +
      dimensions.colorHarmony * 0.14 +
      dimensions.silhouetteBalance * 0.1 +
      dimensions.materialTexture * 0.08 +
      dimensions.formality * 0.08 +
      dimensions.season * 0.06 +
      dimensions.occasion * 0.1 +
      dimensions.signatureStyle * 0.08 +
      dimensions.ownershipPriority * 0.14 +
      dimensions.redundancyPenalty * 0.04,
  );

  const reasons = [
    ...cat.reasons,
    ...color.reasons,
    ...sil.reasons,
    ...material.reasons,
    ...formalityReasons,
    ...seasonReasons,
    ...occasionReasons,
    ...sigReasons,
    ...redundancy.reasons,
  ].slice(0, ELISE_ADVICE_LIMITS.maxReasonCodes);

  const warnings = [...cat.warnings, ...color.warnings, ...redundancy.warnings].slice(
    0,
    ELISE_ADVICE_LIMITS.maxReasonCodes,
  );

  return {
    total: Math.round(total * 1000) / 1000,
    dimensions,
    reasons,
    warnings,
  };
}

export function assignRecommendationRole(
  intent: EliseAdviceIntent,
  candidate: EliseWardrobeCandidate,
  index: number,
): EliseRecommendationRole {
  if (intent === 'shoe_pairing' || candidate.layeringRole === 'shoe') return 'shoe';
  if (intent === 'accessory_pairing' || candidate.layeringRole === 'accessory') return 'accessory';
  if (intent === 'layering_advice' || candidate.layeringRole === 'outer' || candidate.layeringRole === 'mid') {
    return 'layer';
  }
  if (intent === 'find_owned_alternative' || intent === 'find_saved_alternative') return 'substitute';
  if (intent === 'wardrobe_gap') return index === 0 ? 'primary' : 'gap';
  return index === 0 ? 'primary' : 'alternative';
}

export function rankAndBoundCandidates(input: {
  focus: EliseFocusedItem;
  candidates: EliseWardrobeCandidate[];
  intent: EliseAdviceIntent;
  occasionTokens?: string[];
  seasonTokens?: string[];
  signatureStyleTokens?: string[];
  limit?: number;
}): EliseScoredCandidate[] {
  const limit = input.limit ?? ELISE_ADVICE_LIMITS.groundedShortlist;
  const focusCandidate = input.focus.candidate;
  const scored = input.candidates
    .filter((c) => c.candidateId !== focusCandidate?.candidateId)
    .map((candidate) => {
      const score = scoreWardrobeCompatibility({
        focus: focusCandidate,
        candidate,
        intent: input.intent,
        occasionTokens: input.occasionTokens,
        seasonTokens: input.seasonTokens,
        signatureStyleTokens: input.signatureStyleTokens,
      });
      return { candidate, score, recommendationRole: 'alternative' as EliseRecommendationRole };
    })
    .sort((a, b) => b.score.total - a.score.total)
    .slice(0, limit);

  return scored.map((row, index) => ({
    ...row,
    recommendationRole: assignRecommendationRole(input.intent, row.candidate, index),
  }));
}
