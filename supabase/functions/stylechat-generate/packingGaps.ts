// K+ Packing Intelligence V1 — wardrobe gaps (B4).
//
// A GAP IS AN UNMET REQUIREMENT, NOT A SALES OPPORTUNITY. The only thing that
// can create a gap here is: the trip needs X, and the traveller's authoritative
// Closet contains nothing that can be X. "We found a jacket online" is not a
// gap, and nothing in this file can reach a retailer, a catalogue, a price or a
// product. Packing V1 helps someone pack; it does not sell.
//
// DERIVED FROM THE CLOSET, NOT FROM THE SHORTLIST. The census below counts the
// whole usable owned set, not the bounded set the model saw. A role that exists
// in the Closet but lost its place to the shortlist bound is NOT missing, and
// reporting it as one would tell a traveller they lack a coat they own.
//
// TWO SOURCES, BOTH EVIDENCED:
//   - a required layering role the Closet cannot fill at all
//   - a weather condition the forecast actually stated, with nothing owned that
//     answers it. If weather is UNAVAILABLE, no weather gap can exist -- an
//     absent forecast is not evidence of rain.

import type { PackingWeatherProvenance } from './packingContract.ts';
import type { PackingLayeringRole } from './packingCandidates.ts';

export interface PackingGap {
  /** Stable, content-free code. Safe for telemetry. */
  code: string;
  /** What is missing, in the traveller's language. Never a product. */
  label: string;
  /** Why this is a gap for THIS trip. Never a purchase argument. */
  rationale: string;
}

const ROLE_GAP_LABELS: Partial<Record<PackingLayeringRole, { label: string; rationale: string }>> = {
  shoe: {
    label: 'Shoes',
    rationale: 'Your Closet has no footwear yet, so no look here is complete.',
  },
  bottom: {
    label: 'A bottom',
    rationale: 'Your Closet has no trousers, jeans, skirt or shorts to build around.',
  },
  base: {
    label: 'A top',
    rationale: 'Your Closet has no tops, so the looks have nothing to start from.',
  },
  outer: {
    label: 'An outer layer',
    rationale: 'This trip has occasions that usually want a jacket or coat, and your Closet has none.',
  },
  mid: {
    label: 'A mid layer',
    rationale: 'Something between a top and a jacket would cover the cooler parts of this trip.',
  },
  one_piece: {
    label: 'A dress or jumpsuit',
    rationale: 'The occasions you chose often lean on a single piece, and your Closet has none.',
  },
};

const RAIN_PATTERN = /\brain\b/i;
const SNOW_PATTERN = /\bsnow\b/i;
const COLD_PATTERN = /lows near (-?\d+)F/i;

export interface PackingGapInput {
  /** Roles the trip's own requirements asked for. */
  requiredRoles: PackingLayeringRole[];
  /** Every layering role present in the USABLE owned Closet, with counts. */
  closetRoleCensus: Record<string, number>;
  weather: { provenance: PackingWeatherProvenance; summary: string | null };
  /**
   * False when retrieval could not see the whole Closet. EVERY gap in this file
   * is an absence claim about the traveller's own wardrobe, so an incomplete
   * census produces no gaps at all rather than gaps that might be false.
   * Defaults to true so a caller that has genuinely counted everything is
   * unaffected.
   */
  censusComplete?: boolean;
  maxGaps?: number;
}

const DEFAULT_MAX_GAPS = 3;

export function derivePackingGaps(input: PackingGapInput): PackingGap[] {
  const gaps: PackingGap[] = [];
  const maxGaps = input.maxGaps ?? DEFAULT_MAX_GAPS;
  // "I did not see all of your Closet" is not "you do not own one". A partial
  // census can prove PRESENCE (a counted item is really owned) but never
  // ABSENCE, and every gap below is an absence claim.
  if (input.censusComplete === false) return [];
  const owns = (role: string): boolean => (input.closetRoleCensus[role] ?? 0) > 0;

  for (const role of input.requiredRoles) {
    if (gaps.length >= maxGaps) break;
    if (owns(role)) continue;
    // one_piece is an ALTERNATIVE to base+bottom, never independently required:
    // a traveller with tops and trousers is not missing a dress.
    if (role === 'one_piece' && owns('base') && owns('bottom')) continue;
    // Likewise a mid layer is optional when outerwear exists.
    if (role === 'mid' && owns('outer')) continue;
    const copy = ROLE_GAP_LABELS[role];
    if (!copy) continue;
    gaps.push({ code: `missing_role_${role}`, label: copy.label, rationale: copy.rationale });
  }

  // Weather gaps require a forecast that ACTUALLY SAID something. An
  // UNAVAILABLE provenance carries no claim about conditions, so it can never
  // produce a gap -- "I do not know the weather" is not "it will rain".
  const summary = input.weather.provenance === 'UNAVAILABLE' ? null : input.weather.summary;
  if (summary && gaps.length < maxGaps) {
    if ((RAIN_PATTERN.test(summary) || SNOW_PATTERN.test(summary)) && !owns('outer')) {
      gaps.push({
        code: 'missing_weather_layer',
        label: SNOW_PATTERN.test(summary) ? 'A warm outer layer' : 'A light rain layer',
        rationale: `The forecast for these dates includes ${
          SNOW_PATTERN.test(summary) ? 'snow' : 'rain'
        }, and your Closet has no outerwear.`,
      });
    }
    const coldMatch = summary.match(COLD_PATTERN);
    const low = coldMatch ? Number.parseInt(coldMatch[1], 10) : NaN;
    if (
      gaps.length < maxGaps &&
      Number.isFinite(low) &&
      low <= 45 &&
      !owns('outer') &&
      !owns('mid') &&
      !gaps.some((gap) => gap.code === 'missing_weather_layer')
    ) {
      gaps.push({
        code: 'missing_warm_layer',
        label: 'A warm layer',
        rationale: `Lows near ${low}F are forecast, and your Closet has nothing warmer than a top.`,
      });
    }
  }

  return gaps.slice(0, maxGaps);
}

// ── Build 35: coverage-grounded gaps ─────────────────────────────────────────
//
// V1 gaps asked "does the Closet have a role at all?". Two false answers came
// out of that: a cotton chore jacket counted as rain cover because it is an
// outer layer, and a formal event with only sneakers in the Closet produced no
// gap because shoes exist. Build 35 gaps are graded against the PLAN's actual
// slot coverage and the items' own words:
//
//   confirmed    -- the census is complete and every relevant owned item's
//                   facts show it cannot meet the requirement (or none exist)
//   unconfirmed  -- items exist but their facts are silent; the gap is stated
//                   as "I can't confirm", never as "you don't have"
//
// An incomplete census still produces NO gap at all: a partial census cannot
// prove absence, and "unconfirmed" is not a licence to guess about items the
// retrieval never saw.

export interface PackingGapV2 extends PackingGap {
  certainty: 'confirmed' | 'unconfirmed';
  source: 'role' | 'occasion' | 'weather';
  /** Slots the gap affects. Empty for trip-wide gaps. */
  slotIds: string[];
}

/**
 * Category-level idea for a CONFIRMED gap, shown only when shopping is
 * permitted. It has no item id, no product, no price and no link, and its
 * relationship is fixed to `external` -- it can never render as owned.
 */
export interface PackingExternalSuggestion {
  gapCode: string;
  label: string;
  relationship: 'external';
}

interface CoverageItem {
  layeringRole: string | null;
  band: string | null;
  rainEvidence: boolean;
  warmthEvidence: boolean;
}

export interface PackingCoverageGapInput {
  censusComplete: boolean;
  closetRoleCensus: Record<string, number>;
  requiredRoles: PackingLayeringRole[];
  /** The whole usable owned Closet, reduced to the facts gaps may use. */
  closetItems: CoverageItem[];
  slots: Array<{ slotId: string; activity: string; coverage: string; missing: string[]; strict: boolean }>;
  forecastSummary: string | null;
  /** Conditions the traveller stated. */
  statedConditions: string[];
  maxGaps?: number;
}

const EXTERNAL_LABELS: Record<string, string> = {
  missing_formal_footwear: 'Dressy shoes for the formal event',
  missing_formal_outfit: 'A dressy outfit for the formal event',
  missing_weather_layer: 'A packable rain jacket',
  missing_warm_layer: 'A warm layer',
  missing_role_shoe: 'A versatile pair of shoes',
  missing_role_outer: 'A light jacket',
};

export function derivePackingCoverageGaps(input: PackingCoverageGapInput): PackingGapV2[] {
  if (!input.censusComplete) return [];
  const maxGaps = input.maxGaps ?? 4;
  const gaps: PackingGapV2[] = [];
  const push = (gap: PackingGapV2) => {
    if (gaps.length < maxGaps && !gaps.some((existing) => existing.code === gap.code)) gaps.push(gap);
  };

  for (const gap of derivePackingGaps({
    requiredRoles: input.requiredRoles,
    closetRoleCensus: input.closetRoleCensus,
    weather: { provenance: 'UNAVAILABLE', summary: null },
    censusComplete: true,
  })) {
    push({ ...gap, certainty: 'confirmed', source: 'role', slotIds: [] });
  }

  // Occasions graded against the plan: a strict slot (formal event) that the
  // planner could not cover, or could only cover with pieces whose formality
  // the Closet does not state.
  const strictSlots = input.slots.filter((slot) => slot.strict && slot.coverage !== 'covered');
  if (strictSlots.length > 0) {
    const shoes = input.closetItems.filter((item) => item.layeringRole === 'shoe');
    const dressyShoe = shoes.some((item) => item.band === 'smart' || item.band === 'formal');
    const unknownShoe = shoes.some((item) => item.band === null);
    const slotIds = strictSlots.map((slot) => slot.slotId);
    if (shoes.length > 0 && !dressyShoe) {
      push({
        code: unknownShoe ? 'unconfirmed_formal_footwear' : 'missing_formal_footwear',
        label: 'Dressy shoes',
        rationale: unknownShoe
          ? "I couldn't confirm any of your shoes are dressy enough for the formal event."
          : 'The shoes in your Closet are casual, so nothing covers the formal event.',
        certainty: unknownShoe ? 'unconfirmed' : 'confirmed',
        source: 'occasion',
        slotIds,
      });
    }
    const mains = input.closetItems.filter((item) =>
      ['base', 'bottom', 'one_piece'].includes(item.layeringRole ?? '')
    );
    const dressyMain = mains.some((item) => item.band === 'smart' || item.band === 'formal');
    const unknownMain = mains.some((item) => item.band === null);
    if (mains.length > 0 && !dressyMain) {
      push({
        code: unknownMain ? 'unconfirmed_formal_outfit' : 'missing_formal_outfit',
        label: 'A dressy outfit',
        rationale: unknownMain
          ? "I couldn't confirm anything in your Closet is formal enough for the event."
          : 'Your Closet reads as casual, so nothing is dressy enough for the formal event.',
        certainty: unknownMain ? 'unconfirmed' : 'confirmed',
        source: 'occasion',
        slotIds,
      });
    }
  }

  // Weather: a forecast that SAID rain/snow/cold, or a condition the traveller
  // stated. Never the device's own weather -- nothing here receives it.
  const summary = input.forecastSummary ?? '';
  const wet =
    RAIN_PATTERN.test(summary) || SNOW_PATTERN.test(summary) ||
    input.statedConditions.includes('rain') || input.statedConditions.includes('snow');
  const snowy = SNOW_PATTERN.test(summary) || input.statedConditions.includes('snow');
  const lowMatch = summary.match(COLD_PATTERN);
  const low = lowMatch ? Number.parseInt(lowMatch[1], 10) : NaN;
  const cold = (Number.isFinite(low) && low <= 45) || input.statedConditions.includes('cold') || snowy;
  const said = input.forecastSummary ? 'The forecast for these dates includes' : 'You mentioned';
  const outers = input.closetItems.filter((item) => item.layeringRole === 'outer');

  if (wet) {
    const what = snowy ? 'snow' : 'rain';
    if (outers.length === 0) {
      push({
        code: 'missing_weather_layer',
        label: snowy ? 'A warm outer layer' : 'A light rain layer',
        rationale: `${said} ${what}, and your Closet has no outerwear.`,
        certainty: 'confirmed',
        source: 'weather',
        slotIds: [],
      });
    } else if (!outers.some((item) => (snowy ? item.warmthEvidence : item.rainEvidence))) {
      push({
        code: 'unconfirmed_weather_layer',
        label: snowy ? 'A warm outer layer' : 'A rain-capable layer',
        rationale: `${said} ${what}. You have outer layers, but I can't tell whether any of them handle ${what}.`,
        certainty: 'unconfirmed',
        source: 'weather',
        slotIds: [],
      });
    }
  }
  if (cold && !snowy) {
    const layers = input.closetItems.filter((item) => item.layeringRole === 'outer' || item.layeringRole === 'mid');
    if (layers.length === 0) {
      push({
        code: 'missing_warm_layer',
        label: 'A warm layer',
        rationale: `${input.forecastSummary ? 'Cold weather is forecast' : 'You mentioned cold weather'}, and your Closet has nothing warmer than a top.`,
        certainty: 'confirmed',
        source: 'weather',
        slotIds: [],
      });
    } else if (!layers.some((item) => item.warmthEvidence)) {
      push({
        code: 'unconfirmed_warm_layer',
        label: 'A warm layer',
        rationale: `${input.forecastSummary ? 'Cold weather is forecast' : 'You mentioned cold weather'}. You have layers, but I can't tell how warm they are.`,
        certainty: 'unconfirmed',
        source: 'weather',
        slotIds: [],
      });
    }
  }

  // One absence, one gap: "no outerwear" and "no rain layer" describe the same
  // missing piece, and the weather one says why this trip needs it.
  if (gaps.some((gap) => gap.code === 'missing_weather_layer')) {
    return gaps.filter((gap) => gap.code !== 'missing_role_outer');
  }
  return gaps;
}

/**
 * External ideas for CONFIRMED gaps only, and only when the traveller asked to
 * shop and did not ask for Closet-only packing. Missing data is never converted
 * into a shopping recommendation (section 10).
 */
export function derivePackingExternalSuggestions(input: {
  gaps: PackingGapV2[];
  allowShopping: boolean;
  ownedOnly: boolean;
}): PackingExternalSuggestion[] {
  if (!input.allowShopping || input.ownedOnly) return [];
  const suggestions: PackingExternalSuggestion[] = [];
  for (const gap of input.gaps) {
    if (gap.certainty !== 'confirmed') continue;
    const label = EXTERNAL_LABELS[gap.code];
    if (!label) continue;
    suggestions.push({ gapCode: gap.code, label, relationship: 'external' });
  }
  return suggestions;
}

/**
 * Trust signals derived from the plan and the Closet census -- never from the
 * model. Only two are produced, and both are checkable facts:
 *   - "Your only X"    : the census says this role appears exactly once
 *   - "Works across N" : computed from the rendered outfits (packingValidation)
 * Anything the model would have to be believed about is not a trust signal.
 */
export function deriveScarcitySignal(
  layeringRole: string | null,
  closetRoleCensus: Record<string, number>,
  censusComplete = true,
): string | null {
  if (!layeringRole) return null;
  // "Your only pair of shoes" is a COUNT claim, and a partial census cannot
  // count. Saying it over an incomplete Closet would tell someone who owns ten
  // pairs that they own one.
  if (!censusComplete) return null;
  if ((closetRoleCensus[layeringRole] ?? 0) !== 1) return null;
  switch (layeringRole) {
    case 'outer':
      return 'Your only outer layer';
    case 'mid':
      return 'Your only mid layer';
    case 'shoe':
      return 'Your only pair of shoes';
    case 'one_piece':
      return 'Your only dress';
    case 'bottom':
      return 'Your only bottom';
    default:
      return null;
  }
}
