// Build 35 Packing Intelligence -- known garment characteristics (pure).
//
// WHAT THIS IS. The trip planner has to answer questions the V1 model answered
// silently: can these sneakers stand in for those loafers at a formal event?
// Is this jacket a rain layer? How many times can a top honestly be worn?
// Answering them in code is what makes reuse, redundancy and gap claims
// checkable instead of believed.
//
// WHAT THIS IS NOT. It is not a second garment taxonomy. The layering role
// still comes from eliseFashionFeatures.inferLayeringRole and garment classes
// still come from eliseOutfitState.candidateGarmentClasses. This file reads
// the SAME Closet words those modules read and derives three narrow facts
// from them: a formality band, rain/warmth evidence, and a reuse cap.
//
// UNKNOWN STAYS UNKNOWN. A garment whose words say nothing about formality has
// a null band, and a null band can never satisfy a strict requirement -- it
// can only make the requirement "unconfirmed". The Closet stores no formality,
// season or waterproofing field, so every fact here is evidence-by-name, and
// absence of evidence is recorded as absence of evidence, never as "no".

import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import { candidateGarmentClasses, garmentClassOf } from './eliseOutfitState.ts';
import type { PackingActivity } from './packingContract.ts';

/**
 * The shared garment vocabulary. Compounds ("raincoat" is a coat, "sweatpants"
 * are pants) are resolved inside eliseOutfitState.garmentClassOf itself, so a
 * Closet item has the same classes in Packing as in Concierge. These names stay
 * so the Packing modules read unchanged.
 */
export function garmentClassOfWord(word: string): string | null {
  return garmentClassOf(word);
}

/** Garment classes a Closet item can honestly be called, compounds included. */
export function packingGarmentClassesOf(candidate: EliseWardrobeCandidate): string[] {
  return candidateGarmentClasses(candidate);
}

export type PackingFormalityBand = 'athletic' | 'casual' | 'smart' | 'formal';

const BAND_ORDER: PackingFormalityBand[] = ['athletic', 'casual', 'smart', 'formal'];

/**
 * Garment NOUNS that settle formality on their own. Checked before modifiers,
 * so "canvas loafers" is a loafer (smart), not canvas (casual). Multi-word
 * phrases come first because the scan returns the first hit.
 */
const NOUN_BANDS: Array<[RegExp, PackingFormalityBand]> = [
  [/\bdress\s+shoes?\b|\btuxedo\b|\bball\s*gown\b|\bgown\b|\bstiletto|\bcocktail\s+dress\b|\bsuit\b/, 'formal'],
  [/\bheels?\b|\bpumps?\b/, 'formal'],
  [/\brunning\s+shoes?\b|\btrack\s*(?:pants?|suit)\b|\bsports?\s+bra\b|\bgym\b|\bworkout\b|\bleggings?\b|\bjoggers?\b/, 'athletic'],
  [/\bdress\s+(?:shirt|trousers?|pants?)\b|\bloafers?\b|\boxfords?\b|\bbrogues?\b|\bderbys?\b|\bblazers?\b|\btrousers?\b|\bchinos?\b|\bblouses?\b|\bpencil\s+skirt\b|\btrench\b|\bpeacoat\b|\bmules?\b|\bballet\s+flats?\b|\bchelsea\s+boots?\b|\bcardigan\b|\bturtleneck\b/, 'smart'],
  [/\bsneakers?\b|\btrainers?\b|\bt-?shirts?\b|\btees?\b|\bhoodies?\b|\bsweatshirts?\b|\bjeans?\b|\bdenim\b|\bshorts\b|\bsandals?\b|\bflip[\s-]?flops?\b|\bslides\b|\btank\b|\bcargos?\b|\bchore\b|\bespadrilles?\b|\bbomber\b|\bparka\b|\banorak\b|\bwindbreaker\b|\bfleece\b|\bbeanie\b|\bbackpack\b|\bswim\w*\b|\bbikini\b/, 'casual'],
];

/** Modifiers consulted only when no noun settled the question. */
const MODIFIER_BANDS: Array<[RegExp, PackingFormalityBand]> = [
  [/\bsatin\b|\bsequin|\bvelvet\b|\bevening\b|\bcocktail\b|\btuxedo\b/, 'formal'],
  [/\bathletic\b|\bperformance\b|\brunning\b|\btraining\b|\bsport\b/, 'athletic'],
  [/\bsilk\b|\bcashmere\b|\btailored\b|\bpleated\b|\bpatent\b/, 'smart'],
  [/\bcanvas\b|\bjersey\b|\bgraphic\b|\bdistressed\b|\bterry\b/, 'casual'],
];

function textOf(candidate: EliseWardrobeCandidate): { nouns: string; all: string } {
  const nouns = [candidate.category, candidate.subcategory, candidate.title]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  const all = `${nouns} ${candidate.materials.join(' ')} ${candidate.formality ?? ''}`.toLowerCase();
  return { nouns, all };
}

/** The formality band a Closet item's own words support, or null. */
export function formalityBandOf(candidate: EliseWardrobeCandidate): PackingFormalityBand | null {
  const explicit = candidate.formality?.toLowerCase() ?? '';
  if (/formal|black tie/.test(explicit)) return 'formal';
  if (/smart|business/.test(explicit)) return 'smart';
  if (/athletic|sport/.test(explicit)) return 'athletic';
  if (/casual/.test(explicit)) return 'casual';
  const { nouns, all } = textOf(candidate);
  for (const [pattern, band] of NOUN_BANDS) if (pattern.test(nouns)) return band;
  for (const [pattern, band] of MODIFIER_BANDS) if (pattern.test(all)) return band;
  return null;
}

export function bandDistance(a: PackingFormalityBand, b: PackingFormalityBand): number {
  return Math.abs(BAND_ORDER.indexOf(a) - BAND_ORDER.indexOf(b));
}

export type PackingFormalityShift = 'less_formal' | 'more_formal';

export interface PackingActivityRequirement {
  /** Bands that may NEVER dress this occasion. Items in them are removed. */
  disallowed: PackingFormalityBand[];
  /** Bands that suit it best, most suitable first. Selection signal only. */
  preferred: PackingFormalityBand[];
  /**
   * True when coverage must be PROVEN: a null band cannot count as covered,
   * only as unconfirmed. A formal event is strict; a sightseeing day is not.
   */
  strict: boolean;
}

/**
 * Occasion requirements. Hard disallowances are kept deliberately few: they
 * delete a model's choice, so each one must be something nobody would argue
 * with (running shoes at a formal event). Everything else is a preference.
 */
const ACTIVITY_REQUIREMENTS: Record<PackingActivity, PackingActivityRequirement> = {
  travel_day: { disallowed: [], preferred: ['casual', 'smart', 'athletic'], strict: false },
  casual_day: { disallowed: [], preferred: ['casual', 'smart', 'athletic'], strict: false },
  dinner: { disallowed: ['athletic'], preferred: ['smart', 'casual', 'formal'], strict: false },
  work: { disallowed: ['athletic'], preferred: ['smart', 'formal', 'casual'], strict: false },
  beach: { disallowed: ['formal'], preferred: ['casual', 'athletic'], strict: false },
  outdoors: { disallowed: ['formal'], preferred: ['casual', 'athletic'], strict: false },
  workout: { disallowed: ['formal', 'smart'], preferred: ['athletic', 'casual'], strict: false },
  formal_event: { disallowed: ['athletic', 'casual'], preferred: ['formal', 'smart'], strict: true },
  nightlife: { disallowed: ['athletic'], preferred: ['smart', 'casual', 'formal'], strict: false },
};

/**
 * The requirement for one slot, after any formality shift the traveller asked
 * for. A shift RELAXES or TIGHTENS preference; "make Friday casual" on a formal
 * event lifts that event's hard rule too, because the traveller explicitly
 * changed the requirement (packingRefinement records and acknowledges that).
 */
export function requirementFor(
  activity: PackingActivity,
  shift: PackingFormalityShift | null,
): PackingActivityRequirement {
  const base = ACTIVITY_REQUIREMENTS[activity];
  if (shift === 'less_formal') {
    return { disallowed: ['formal'], preferred: ['casual', 'athletic', 'smart'], strict: false };
  }
  if (shift === 'more_formal') {
    return {
      disallowed: base.disallowed.includes('athletic') ? ['athletic'] : [],
      preferred: ['smart', 'formal', 'casual'],
      strict: base.strict,
    };
  }
  return base;
}

// ── Weather evidence ─────────────────────────────────────────────────────────

const RAIN_EVIDENCE = /\brain|waterproof|water[\s-]?resistant|water[\s-]?repellent|\bshell\b|gore[\s-]?tex|anorak|windbreaker|parka|trench|\bmac\b|mackintosh|\bnylon\b|\bwax(?:ed)?\b|oilskin|poncho|softshell/;
const WARM_EVIDENCE = /\bwool|\bdown\b|puffer|fleece|parka|peacoat|cashmere|sherpa|quilted|insulated|shearling|thermal/;

/** True only when the item's own words indicate it handles rain. */
export function hasRainEvidence(candidate: EliseWardrobeCandidate): boolean {
  return RAIN_EVIDENCE.test(textOf(candidate).all);
}

/** True only when the item's own words indicate warmth. */
export function hasWarmthEvidence(candidate: EliseWardrobeCandidate): boolean {
  return WARM_EVIDENCE.test(textOf(candidate).all);
}

// ── Reuse (ADD-07) ───────────────────────────────────────────────────────────

/**
 * Wears per item before laundry, by layering role. PLANNING DEFAULTS, not
 * fashion law: explicit traveller instructions override them (see
 * reuseCapFor). Worn-against-skin pieces are single-use; pieces that sit over
 * other clothing carry a trip.
 */
export const PACKING_REUSE_CAPS: Record<string, number> = {
  base: 1,
  one_piece: 1,
  bottom: 3,
  mid: 3,
  outer: 99,
  shoe: 99,
  accessory: 99,
};

/** Unroled items are treated like tops: the conservative, hygienic default. */
const UNROLED_CAP = 1;

export function reuseCapFor(
  role: string | null,
  overrides: { noRepeatRoles: string[]; rewearRoles: string[] },
): number {
  const key = role ?? '';
  if (overrides.noRepeatRoles.includes(key)) return 1;
  const base = PACKING_REUSE_CAPS[key] ?? UNROLED_CAP;
  if (overrides.rewearRoles.includes(key)) return Math.max(base, 2);
  return base;
}

// ── Colour and preference signals ────────────────────────────────────────────

/**
 * Colour compatibility for swapping one packed piece for another. Conservative
 * on purpose: neutrals go with anything, otherwise the two must share a family,
 * and two items with no colour facts at all are only interchangeable when
 * neither says anything (unknown is never promoted to "matches").
 */
export function colorsCompatible(
  replacement: EliseWardrobeCandidate,
  original: EliseWardrobeCandidate,
): boolean {
  const r = replacement.colorFamilies;
  const o = original.colorFamilies;
  if (r.includes('neutral')) return true;
  if (r.length === 0 && o.length === 0) return true;
  return r.some((family) => o.includes(family));
}

/** Same garment class ("blazer" and "blazer"), from the shared vocabulary. */
export function sameGarmentClass(a: EliseWardrobeCandidate, b: EliseWardrobeCandidate): boolean {
  const classes = packingGarmentClassesOf(a);
  if (classes.length === 0) return false;
  const other = packingGarmentClassesOf(b);
  return classes.some((cls) => other.includes(cls));
}

export interface PackingColorPreference {
  /** Families asked for ('neutral', 'warm', 'cool', 'earth'). */
  families: string[];
  /** Specific colour words asked for ('red'). */
  tokens: string[];
}

const BRIGHT_FAMILIES = ['warm', 'cool'];

/**
 * An EXPLICIT colour instruction from the traveller, or null. Literal: "bright"
 * or "colourful" asks for warm/cool families, "neutral" for neutrals, and named
 * colours are carried as-is.
 */
export function readColorPreference(
  text: string,
  colorTokens: (values: readonly string[]) => string[],
): PackingColorPreference | null {
  const lower = text.toLowerCase();
  const families: string[] = [];
  if (/\bbright|colou?rful|\bbold colou?rs?|\bpop of colou?r|\bmore colou?r|\bvibrant/.test(lower)) {
    families.push(...BRIGHT_FAMILIES);
  }
  if (/\bneutrals?\b|\bmuted\b|\bmonochrome\b/.test(lower)) families.push('neutral');
  const tokens = /\b(?:wear|in|use|prefer|want|colou?r)\b/.test(lower) ? colorTokens([lower]) : [];
  if (families.length === 0 && tokens.length === 0) return null;
  return { families: [...new Set(families)], tokens };
}

export function matchesColorPreference(
  candidate: EliseWardrobeCandidate,
  preference: PackingColorPreference | null,
): boolean {
  if (!preference) return false;
  if (candidate.colorFamilies.some((family) => preference.families.includes(family))) return true;
  const colors = candidate.colors.join(' ').toLowerCase();
  return preference.tokens.some((token) => colors.includes(token));
}
