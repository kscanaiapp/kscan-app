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
