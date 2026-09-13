/**
 * Packing → Commerce bridge (Build 35).
 *
 * ONE DIRECTION ONLY. Packing decides what is missing from a wardrobe; this
 * turns a gap Packing already CONFIRMED into grounded shopping intent. Nothing
 * here writes a gap, upgrades a certainty, or reports a Commerce outcome back
 * to Packing: gap determination is wardrobe/trip evidence, and a shopping
 * result is not wardrobe evidence.
 *
 * THE FIREWALL, CONCRETELY.
 *   - `certainty` is copied verbatim from `PackingGapV2` and never recomputed.
 *   - An UNCONFIRMED gap produces a context-only intent: it can explain why a
 *     listing is being shown, but it contributes ZERO ranking weight (see
 *     `scoreContextualFit`) and can never be described as a proven absence.
 *   - There is no return path. This module exports no function that takes a
 *     Commerce result, by construction.
 *
 * It also does not invent a gap seam. `PackingGapV2` and
 * `PackingExternalSuggestion` are the contract Packing (#407) already
 * publishes; this reads them as they are.
 */

import type { IntentContribution, GapRelationship } from './commerceShoppingIntent.ts';

/** The subset of Packing's own `PackingGapV2` this bridge reads. */
export interface PackingGapInputForCommerce {
  code: string;
  label: string;
  certainty: 'confirmed' | 'unconfirmed';
  source: 'role' | 'occasion' | 'weather';
}

/**
 * Functional requirements a gap code genuinely implies.
 *
 * Keyed off Packing's OWN stable gap codes, not off free text, so a reworded
 * rationale cannot change what Commerce searches for. A code with no entry
 * yields no requirement rather than a guess.
 */
const GAP_FUNCTIONAL_REQUIREMENTS: Readonly<Record<string, readonly string[]>> = {
  missing_weather_layer: ['waterproof', 'packable'],
  unconfirmed_weather_layer: ['waterproof'],
  missing_warm_layer: ['warm'],
  unconfirmed_warm_layer: ['warm'],
};

/** Category hints, again keyed off the stable code. */
const GAP_CATEGORY: Readonly<Record<string, string>> = {
  missing_role_shoe: 'footwear',
  missing_formal_footwear: 'footwear',
  unconfirmed_formal_footwear: 'footwear',
  missing_role_outer: 'outerwear',
  missing_weather_layer: 'outerwear',
  unconfirmed_weather_layer: 'outerwear',
  missing_warm_layer: 'outerwear',
  unconfirmed_warm_layer: 'outerwear',
  missing_role_bottom: 'pants',
  missing_role_base: 'top',
  missing_role_mid: 'top',
  missing_role_one_piece: 'dress',
  missing_formal_outfit: 'dress',
  unconfirmed_formal_outfit: 'dress',
};

/** Occasion, only for the gaps whose SOURCE is an occasion. */
const GAP_OCCASION: Readonly<Record<string, string>> = {
  missing_formal_footwear: 'formal',
  unconfirmed_formal_footwear: 'formal',
  missing_formal_outfit: 'formal',
  unconfirmed_formal_outfit: 'formal',
};

/**
 * Build the Commerce contribution for one Packing gap.
 *
 * Returns null for a gap Packing did not state in a shape this can trust.
 * The returned contribution always carries the gap's OWN certainty, so a
 * downstream reader can never mistake a hedge for a fact.
 */
export function contributionFromPackingGap(
  gap: PackingGapInputForCommerce | null | undefined,
): IntentContribution | null {
  if (!gap || typeof gap !== 'object') return null;
  const code = typeof gap.code === 'string' ? gap.code.trim().slice(0, 60) : '';
  const label = typeof gap.label === 'string' ? gap.label.trim().slice(0, 80) : '';
  if (!code || !label) return null;
  if (gap.certainty !== 'confirmed' && gap.certainty !== 'unconfirmed') return null;

  const relationship: GapRelationship = { gapCode: code, label, certainty: gap.certainty };
  const contribution: IntentContribution = {
    provenance: 'PACKING',
    gapRelationship: relationship,
  };

  // ONLY a CONFIRMED gap becomes grounded shopping intent.
  //
  // An unconfirmed gap returns the relationship and nothing else: no category,
  // no occasion, no functional requirement. Those fields all carry ranking
  // weight, and letting an unproven absence move a single candidate is exactly
  // how "I could not confirm you have a rain layer" quietly becomes "you do
  // not have one". The hedge stays a hedge, available to EXPLAIN a result and
  // unable to CHOOSE one.
  if (gap.certainty !== 'confirmed') return contribution;

  const category = GAP_CATEGORY[code];
  if (category) contribution.category = category;
  const occasion = GAP_OCCASION[code];
  if (occasion) contribution.occasion = occasion;
  const functional = GAP_FUNCTIONAL_REQUIREMENTS[code];
  if (functional?.length) contribution.functionalRequirements = [...functional];

  return contribution;
}

/**
 * Which gaps may become a shopping request at all.
 *
 * Mirrors `derivePackingExternalSuggestions`' existing rule rather than
 * inventing a second one: only CONFIRMED gaps are shoppable. An unconfirmed
 * gap stays in the plan as a hedge; it does not become a search.
 */
export function shoppableGaps(
  gaps: readonly PackingGapInputForCommerce[] | null | undefined,
): PackingGapInputForCommerce[] {
  if (!Array.isArray(gaps)) return [];
  return gaps.filter((g) => g && g.certainty === 'confirmed');
}

/**
 * True when a claim about this gap may be stated as fact.
 *
 * The single predicate every Commerce surface must consult before wording a
 * gap. It reads `certainty` and nothing else — in particular it does not read
 * how many products were found, which is the exact substitution the firewall
 * exists to prevent.
 */
export function gapMayBeStatedAsFact(gap: PackingGapInputForCommerce | null | undefined): boolean {
  return gap?.certainty === 'confirmed';
}
