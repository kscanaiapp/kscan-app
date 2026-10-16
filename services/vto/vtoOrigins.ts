// The ONE place that maps VTO launch vocabulary onto the bounded entry-point
// taxonomy used for conversion analytics.
//
// Two vocabularies already exist and neither is replaced:
//   - `origin`  (types/vto.ts VTO_ORIGINS)  what a launch was handed by its caller.
//   - `surface` (vtoDiscovery.ts VTO_AWARENESS_SURFACES)  where an awareness
//     cue or a try-on control was shown.
// Behaviour never depends on this file. It only answers "which entry point is
// this?" so every funnel step -- impression, tap, launch, success, supported
// continuation -- carries the same single `entry_point` value and the five
// entry points can be compared like for like.
//
// MAPPING (origin and surface in, entry point out; first matching row wins)
//   origin elise                               -> elise
//   origin closet_item                         -> closet
//   origin scan_result                         -> visual_search
//   origin commerce_product + surface scan_result      -> visual_search
//   origin commerce_product + surface product|commerce -> product_card
//   origin commerce_product + no/other surface         -> product_card
//   no origin + surface home                   -> home_studio
//   no origin + surface scan_result            -> visual_search
//   no origin + surface product|commerce       -> product_card
//   dressing_room, dev_harness, coachmark, kplus_step6, anything else -> null
//
// null means "not an entry point": a Dressing Room resume is a continuation,
// the coachmark is an awareness cue whose tap launches under its own origin,
// kplus_step6 is a membership pitch, and the dev harness is not customer
// traffic. Unattributed is reported as absent, never forced into a bucket.
//
// `watch_notification` is deliberately NOT in the taxonomy: no real authorized
// entry point exists for it. Add it only together with that entry point.
//
// Import-free on purpose (like vtoDiscovery.ts) so the telemetry sink can use
// it without acquiring dependencies. __tests__/vtoEntryPointTaxonomy.test.js
// pins the origin/surface literals below to their canonical lists.

export const VTO_ENTRY_POINTS = [
  'home_studio',
  'elise',
  'visual_search',
  'closet',
  'product_card',
] as const;

export type VtoEntryPoint = (typeof VTO_ENTRY_POINTS)[number];

export interface VtoEntryPointInput {
  origin?: unknown;
  surface?: unknown;
}

export function resolveVtoEntryPoint(input: VtoEntryPointInput): VtoEntryPoint | null {
  const origin = typeof input?.origin === 'string' ? input.origin : null;
  const surface = typeof input?.surface === 'string' ? input.surface : null;

  if (origin === 'elise') return 'elise';
  if (origin === 'closet_item') return 'closet';
  if (origin === 'scan_result') return 'visual_search';
  if (origin === 'commerce_product') {
    return surface === 'scan_result' ? 'visual_search' : 'product_card';
  }
  if (origin !== null) return null; // dressing_room, dev_harness, unknown

  if (surface === 'home') return 'home_studio';
  if (surface === 'scan_result') return 'visual_search';
  if (surface === 'product' || surface === 'commerce') return 'product_card';
  return null;
}
