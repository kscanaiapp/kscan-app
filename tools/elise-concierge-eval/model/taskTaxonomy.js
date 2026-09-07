'use strict';

/**
 * SUPPORTED TASK TAXONOMY — spec section 25.
 *
 * Derived from actual source, not invented: the `EliseAdviceIntent` union in
 * supabase/functions/stylechat-generate/eliseAdviceTypes.ts (verified by
 * reading that file directly — see authority/eliseSourceMap.json) and the
 * intent-classification patterns in eliseAdviceIntents.ts. Each task below is
 * PROVEN by that source file, not inferred from the Elise/Concierge feature
 * names.
 *
 * `intentSource` records the literal EliseAdviceIntent string this task maps
 * to. A spec-suggested task with no supported intent is marked NOT_APPLICABLE
 * rather than invented.
 */

const TASK_TAXONOMY_VERSION = 'TASK_TAXONOMY_V1';

const TASKS = [
  {
    id: 'build_outfit',
    label: 'Build an outfit',
    intentSource: 'build_outfit',
    status: 'PROVEN',
  },
  {
    id: 'style_owned_item',
    label: 'Style an owned/current item',
    intentSource: 'style_current_item',
    status: 'PROVEN',
  },
  {
    id: 'dress_for_occasion',
    label: 'Dress for an occasion',
    intentSource: 'occasion_fit',
    status: 'PROVEN',
  },
  {
    id: 'choose_between_options',
    label: 'Choose between options',
    intentSource: 'compare_items',
    status: 'PROVEN',
  },
  {
    id: 'owned_items_only_outfit',
    label: 'Owned-items-only outfit (no shopping)',
    intentSource: 'find_owned_alternative',
    status: 'PROVEN',
  },
  {
    id: 'recommend_purchase',
    label: 'Recommend a purchase',
    intentSource: 'purchase_advice',
    status: 'PROVEN',
  },
  {
    id: 'wardrobe_gap',
    label: 'Identify a wardrobe gap',
    intentSource: 'wardrobe_gap',
    status: 'PROVEN',
  },
  {
    id: 'provide_alternatives',
    label: 'Provide alternatives from saved items',
    intentSource: 'find_saved_alternative',
    status: 'PROVEN',
  },
  {
    id: 'color_pairing',
    label: 'Color pairing advice',
    intentSource: 'color_pairing',
    status: 'PROVEN',
  },
  {
    id: 'layering_advice',
    label: 'Layering advice',
    intentSource: 'layering_advice',
    status: 'PROVEN',
  },
  {
    id: 'shoe_pairing',
    label: 'Shoe pairing advice',
    intentSource: 'shoe_pairing',
    status: 'PROVEN',
  },
  {
    id: 'accessory_pairing',
    label: 'Accessory pairing advice',
    intentSource: 'accessory_pairing',
    status: 'PROVEN',
  },
  {
    id: 'seasonal_advice',
    label: 'Seasonal advice',
    intentSource: 'seasonal_advice',
    status: 'PROVEN',
  },
  {
    id: 'multi_look_generation',
    label: 'Generate multiple looks/ways to style',
    intentSource: 'multi_look_generation',
    status: 'PROVEN',
  },
  {
    id: 'general_style_advice',
    label: 'General style advice (no specific intent matched)',
    intentSource: 'general_style_advice',
    status: 'PROVEN',
  },
  // Spec-suggested tasks with NO corresponding EliseAdviceIntent found in
  // source. "Formalize/casualize an outfit" and "explain why an outfit
  // works" are not distinct classifier intents; the latter is a RESPONSE
  // QUALITY property, not an intent. Recorded honestly rather than invented.
  {
    id: 'formalize_or_casualize_outfit',
    label: 'Formalize or casualize an existing outfit',
    intentSource: null,
    status: 'NOT_APPLICABLE',
    note: 'No distinct EliseAdviceIntent classifies this; occasion_fit/style_current_item may partially cover it, but no dedicated intent was found in eliseAdviceIntents.ts.',
  },
  {
    id: 'explain_why_outfit_works',
    label: 'Explain why an outfit works',
    intentSource: null,
    status: 'NOT_APPLICABLE',
    note: 'This is an explanation-quality property expected of every response (see D08 UNFAITHFUL_EXPLANATION), not a distinct classifier intent.',
  },
];

const TASKS_BY_ID = Object.freeze(Object.fromEntries(TASKS.map((t) => [t.id, t])));

const SUPPORTED_TASKS = TASKS.filter((t) => t.status === 'PROVEN');

module.exports = {
  TASK_TAXONOMY_VERSION,
  TASKS: Object.freeze(TASKS),
  TASKS_BY_ID,
  SUPPORTED_TASKS: Object.freeze(SUPPORTED_TASKS),
};
