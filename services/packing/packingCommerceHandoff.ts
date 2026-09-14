/**
 * Packing -> Commerce handoff (Build 36 activation).
 *
 * ONE DIRECTION, AND ONLY FROM A CONFIRMED GAP. Packing decides what is
 * missing; this turns a gap Packing already CONFIRMED into a shopping request
 * on the surface that already knows how to run one. Nothing here writes a gap,
 * upgrades a certainty, or reports a Commerce outcome back — the module
 * exports no function that accepts a product or a result.
 *
 * WHY A HANDOFF RATHER THAN A NEW RESULTS SCREEN. The activated Elise journey
 * already fetches real candidates, applies #409 ranking, and renders through
 * `ProductShelf` with Shop/Save/Watch gating intact. A second Commerce results
 * UI inside Packing would be a third place those rules could drift
 * (activation brief section 21).
 */

export interface PackingGapForHandoff {
  gapCode?: unknown;
  label?: unknown;
  /** Packing's own word. Read, never decided here. */
  certainty?: unknown;
}

export interface PackingCommerceHandoff {
  source: 'packing-gap';
  /** The message that will be put to Elise. Plain customer language. */
  query: string;
  category: string | null;
  gapCode: string;
}

/**
 * Gap code -> the category a search should start from.
 *
 * Keyed off Packing's OWN stable codes, never free text, so a reworded gap
 * rationale cannot change what gets searched for.
 */
const GAP_CATEGORY: Readonly<Record<string, string>> = {
  missing_role_shoe: 'shoes',
  missing_formal_footwear: 'shoes',
  missing_role_outer: 'jacket',
  missing_weather_layer: 'jacket',
  missing_warm_layer: 'jacket',
  missing_role_bottom: 'trousers',
  missing_role_base: 'top',
  missing_role_mid: 'top',
  missing_role_one_piece: 'dress',
  missing_formal_outfit: 'dress',
};

/**
 * Can this gap become a shopping request at all?
 *
 * CONFIRMED only, mirroring `derivePackingExternalSuggestions` rather than
 * inventing a second rule. An unconfirmed gap is Packing saying "I can't tell"
 * — turning that into a search would spend the customer's attention on an
 * absence nobody proved.
 */
export function gapIsShoppable(gap: PackingGapForHandoff | null | undefined): boolean {
  return Boolean(gap) && gap!.certainty === 'confirmed' && typeof gap!.gapCode === 'string' && Boolean(gap!.gapCode);
}

/**
 * Build the handoff for one confirmed gap, or null.
 *
 * The query is written in the customer's words and carries no ids, no trip
 * data and no wardrobe detail: it is a shopping request, and everything else
 * the activated journey needs it assembles itself, actor-scoped, on the way.
 */
export function buildPackingCommerceHandoff(
  gap: PackingGapForHandoff | null | undefined,
): PackingCommerceHandoff | null {
  if (!gapIsShoppable(gap)) return null;
  const gapCode = String(gap!.gapCode);
  const label = typeof gap!.label === 'string' ? gap!.label.trim().slice(0, 80) : '';
  if (!label) return null;
  const category = GAP_CATEGORY[gapCode] ?? null;
  const subject = category ?? label.toLowerCase();
  return {
    source: 'packing-gap',
    query: `Find me ${/^[aeiou]/i.test(subject) ? 'an' : 'a'} ${subject} for my trip.`,
    category,
    gapCode,
  };
}
