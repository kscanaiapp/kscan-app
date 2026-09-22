// Build 35 Packing Intelligence -- reading a refinement (pure, no model).
//
// "Make Friday more casual." "Keep Saturday." "Don't pack the blazer."
// "Actually, bring the loafers back." Each of these names a PART of the plan
// and an OPERATION on it. Reading both deterministically is what lets a
// refinement stay local: Friday changes, Monday does not, and the loafers are
// restored rather than the trip being regenerated from a pile of sentences.
//
// ONE REFINEMENT VOCABULARY. Garment words resolve through
// eliseOutfitState.garmentClassOf and formality/ownership phrasing through
// eliseOutfitState.readRefinementDirectives -- the Concierge V2 tables. Packing
// adds only what a TRIP has and a single look does not: days, occasions, pins,
// restores, repeats, laundry, luggage questions.
//
// AMBIGUITY IS NEVER RESOLVED BY GUESSING (ADD-14). "The blazer" with two
// blazers in the plan returns a clarification, and nothing changes until the
// traveller picks one. Removing the wrong garment is worse than removing none.
//
// Literal pattern matching on purpose, like the Concierge guard: a clever parser
// that is occasionally wrong silently drops a customer's instruction; a blunt one
// whose behaviour can be read off these tables does not. Anything unrecognised
// is still honoured -- it goes to the model as a note for the targeted slots.

import type { EliseWardrobeCandidate } from './eliseAdviceTypes.ts';
import { colorTokensOf } from './eliseFashionFeatures.ts';
import { layeringRoleOfWord, readRefinementDirectives } from './eliseOutfitState.ts';
import { readStatedConditions, type PackingActivity, type PackingCondition } from './packingContract.ts';
import {
  garmentClassOfWord as garmentClassOf,
  packingGarmentClassesOf as candidateGarmentClasses,
  readColorPreference,
  type PackingColorPreference,
} from './packingGarmentFacts.ts';
import { dayLabel, weekdayOf } from './packingSchedule.ts';

export type PackingRefinementOp =
  | { kind: 'reject_item'; itemId: string; reason?: 'not_owned' }
  | { kind: 'reject_class'; garmentClass: string }
  | { kind: 'restore_item'; itemId: string }
  | { kind: 'restore_class'; garmentClass: string }
  | { kind: 'include_item'; itemId: string }
  | { kind: 'pin_slots'; slotIds: string[] }
  | { kind: 'unpin_slots'; slotIds: string[] }
  | { kind: 'pin_item'; itemId: string }
  | { kind: 'formality'; slotIds: string[] | null; direction: 'less_formal' | 'more_formal' }
  | { kind: 'prefer_class'; slotIds: string[] | null; garmentClass: string }
  | { kind: 'no_repeat'; role: string }
  | { kind: 'rewear_ok'; role: string }
  | { kind: 'alternative'; slotIds: string[] | null }
  | { kind: 'color'; slotIds: string[] | null; preference: PackingColorPreference }
  | { kind: 'condition'; condition: PackingCondition }
  | { kind: 'laundry'; available: boolean }
  | { kind: 'owned_only' }
  | { kind: 'allow_shopping' }
  | { kind: 'pack_light' }
  | { kind: 'free_text'; slotIds: string[] | null; note: string }
  // Build 35 refinement quality. Each names the smallest scope it acts on.
  /** "Different shoes", "change Friday's shoes": swap the named role, nothing else. */
  | { kind: 'replace_role'; role: string; slotIds: string[] | null; itemIds: string[] }
  /** "Only two pairs of shoes", "one jacket only", "fewer shoes". */
  | { kind: 'max_role'; role: string; max: number }
  /** "Carry-on only" -- a constraint, unlike "will this fit in a carry-on?". */
  | { kind: 'carry_on_only' }
  /** "Not black", "nothing black". Only items whose recorded colour says so. */
  | { kind: 'exclude_color'; color: string }
  /** "No leather", "no wool". Only items whose own words say so. */
  | { kind: 'exclude_material'; material: string }
  /** "Warmer", "it's colder than expected", "lighter layers". */
  | { kind: 'warmth'; slotIds: string[] | null; direction: 'warmer' | 'lighter' }
  /** "Why did you pack two blazers?" -- answered from the plan, never a change. */
  | { kind: 'explain'; itemIds: string[]; noun: string };

export interface PackingClarificationOption {
  kind: 'item' | 'day';
  /** An item id or an ISO date. */
  value: string;
  label: string;
}

export interface PackingClarification {
  question: string;
  options: PackingClarificationOption[];
}

export interface PackingRefinementInterpretation {
  ops: PackingRefinementOp[];
  clarification: PackingClarification | null;
  carryOnQuestion: boolean;
  /** Garment phrases the traveller asked to pack that their Closet does not hold. */
  notInCloset: string[];
  /** Phrases that named a garment this plan does not contain. */
  notInPlan: string[];
  /** Restores that named something never rejected. */
  notRejected: string[];
  /** "Take that out" with no structured selection: which piece is not knowable. */
  needsReference: boolean;
  /** "Go back" when nothing was removed that could be brought back. */
  nothingToRestore: boolean;
}

export interface PackingRefinementContext {
  message: string;
  resolvedItemId: string | null;
  resolvedDate: string | null;
  slots: Array<{ slotId: string; date: string; activity: PackingActivity; itemIds: string[] }>;
  /** Every date of the trip, including later days that repeat an earlier look. */
  tripDates?: string[];
  /** Later days and the planned slots whose looks they re-wear. */
  repeatDays?: Array<{ date: string; slotIds: string[] }>;
  /** This actor's authorized owned Closet. */
  candidates: Map<string, EliseWardrobeCandidate>;
  rejectedItemIds: string[];
  rejectedClasses: string[];
}

const WEEKDAY_WORDS: Record<string, string> = {
  monday: 'Monday', mon: 'Monday',
  tuesday: 'Tuesday', tue: 'Tuesday', tues: 'Tuesday',
  wednesday: 'Wednesday', wed: 'Wednesday',
  thursday: 'Thursday', thu: 'Thursday', thurs: 'Thursday',
  friday: 'Friday', fri: 'Friday',
  saturday: 'Saturday', sat: 'Saturday',
  sunday: 'Sunday', sun: 'Sunday',
};

const ACTIVITY_WORDS: Array<[RegExp, PackingActivity]> = [
  [/\bformal\s+(?:event|dinner|night|party)\b|\bgala\b|\bwedding\b|\bblack[\s-]tie\b/, 'formal_event'],
  [/\bdinners?\b|\bsuppers?\b/, 'dinner'],
  [/\bwork\b|\bmeetings?\b|\bconference\b|\boffice\b/, 'work'],
  [/\bbeach\b|\bpool\b/, 'beach'],
  [/\bhik(?:e|ing)\b|\boutdoors?\b|\btrail\b/, 'outdoors'],
  [/\bgym\b|\bworkout\b|\brun\b|\bexercise\b/, 'workout'],
  [/\bnight\s*out\b|\bnightlife\b|\bdrinks\b|\bclub\b|\bbar\b/, 'nightlife'],
  [/\btravel(?:ling)?\b|\bflight\b|\bplane\b|\btrain\b|\bairport\b/, 'travel_day'],
  [/\bsightseeing\b|\bdaytime\b|\bday\s*look\b|\bexploring\b/, 'casual_day'],
];

// One space-separated string, not an array of quoted words: the governed Edge
// manifest scanner reads a quoted preposition followed by another quoted word
// as an import specifier (the B34-DEF-001 false-positive class). Same fix PR
// #405 applied to its own phrase table.
const STOP = new Set(
  (
    'the a an my me i it this that and or but for to of on in at with without ' +
    'dont do not no pack bring take wear use keep please just back actually instead leave home ' +
    'behind make more less want can we you your one any all day look outfit trip again put add ' +
    'include remove drop skip ditch'
  ).split(' '),
);

const CARRY_ON = /\bcarry[\s-]?on\b|\bhand\s+luggage\b|\bcabin\s+bag\b|\bfit\s+(?:in|into)\s+(?:a|my|one|the)\s+(?:bag|suitcase|backpack|weekender)\b|\bhow\s+(?:big|much)\s+(?:a\s+)?(?:bag|suitcase)\b/i;
const SHOP = /\bwhat\s+should\s+i\s+buy\b|\b(?:buy|shop|shopping|purchase)\b/i;
const NO_SHOP = /\bno\s+shopping\b|\bwithout\s+buying\b|\bdon'?t\s+(?:want\s+to\s+)?(?:buy|shop)\b|\bnothing\s+new\b|\bnot\s+buying\b/i;
const OWNED_ONLY = /\b(?:only|just)\b[^.,]*\b(?:my|what\s+i\s+(?:own|have))\s*(?:own\s+)?(?:closet|wardrobe|clothes)?\b|\bcloset\s+only\b|\bown(?:ed)?\s+only\b|\bnothing\s+i\s+don'?t\s+own\b/i;
const DETERMINERS = new Set(['the', 'my', 'those', 'these', 'that', 'this', 'your', 'our']);
const QUANTIFIERS = new Set(['any', 'all', 'no']);
const LAUNDRY_NO = /\bno\s+laundry\b|\bwithout\s+laundry\b|\bcan'?t\s+(?:do\s+)?(?:laundry|wash)\b|\bno\s+wash(?:ing|er)?\b/i;
const LAUNDRY_YES = /\bcan\s+(?:do\s+)?(?:laundry|wash)\b|\blaundry\s+(?:is\s+)?available\b|\bthere'?s\s+a\s+wash(?:er|ing machine)\b|\bhave\s+laundry\b/i;
const PIN = /\bkeep\b[^.]*\b(?:exactly|as\s+(?:it|they)\s+(?:is|are)|as\s+is|the\s+same|unchanged)\b|\bdon'?t\s+(?:change|touch)\b|\bleave\b[^.]*\b(?:as\s+(?:it|they)\s+(?:is|are)|alone|unchanged)\b|\block\b/i;
const UNPIN = /\b(?:you\s+can|feel\s+free\s+to|ok(?:ay)?\s+to)\s+change\b|\bunlock\b|\bunpin\b/i;
const KEEP = /\bkeep\b|\bstick\s+with\b/i;
const RESTORE = /\b(?:bring|put|add)\b[^.]*\bback\b|\bactually\s+(?:bring|pack|include|keep)\b|\bundo\b|\bchanged\s+my\s+mind\b|\breinstate\b|\brestore\b|\bgo\s+back\b/i;
const INCLUDE = /\b(?:pack|bring|add|include|take)\b/i;
const REMOVE = /\b(?:don'?t|do\s+not|no|not|without|skip|remove|drop|lose|ditch|exclude|leave\s+out)\b|\bleave\b[^.]*\b(?:home|behind)\b/i;
const PREFER = /\buse\b|\bwear\b|\bswap\b|\binstead\b|\bswitch\s+to\b|\bgo\s+with\b|\bprefer\b/i;
const LESS_FORMAL = /\bmore\s+casual\b|\bless\s+(?:formal|dressy)\b|\bdress\s+(?:it\s+)?down\b|\bmore\s+relaxed\b|\bmake\b[^.]*\bcasual\b/i;
const MORE_FORMAL = /\bdressier\b|\bmore\s+(?:formal|dressy|polished)\b|\bdress\s+(?:it\s+)?up\b|\bsmarter\b|\bfancier\b|\bmake\b[^.]*\bformal\b/i;
const NO_REPEAT = /\b(?:don'?t|do\s+not|no|not|never)\b[^.]*\b(?:repeat|re-?wear|same)\b|\bwear\b[^.]*\bonce\b/i;
const REWEAR_OK = /\b(?:don'?t\s+mind|fine|happy|ok(?:ay)?|can)\b[^.]*\b(?:repeat|re-?wear|wear\b[^.]*\b(?:twice|again))\b/i;
const ALTERNATIVE = /\banother\b|\bdifferent\b|\bsomething\s+else\b|\btry\s+again\b|\bnew\s+(?:look|outfit)\b|\bchange\s+(?:the|my)?\s*(?:look|outfit)\b/i;
const PACK_LIGHT = /\bpack\s+light(?:er)?\b|\btravel\s+light\b|\bfewer\s+(?:things|pieces|items|clothes)\b|\bless\s+stuff\b/i;

// ── Build 35 refinement quality ─────────────────────────────────────────────
// A question about the plan is answered from the plan; it is never a change.
const EXPLAIN = /^\s*why\b|\bwhy\s+(?:did|do|does|is|are|would|the)\b|\bexplain\b|\bwhat'?s\s+the\s+(?:point|reason)\b/i;
// "Keep everything except Saturday": the named day is the one that CHANGES.
const EXCEPT = /\b(?:except|apart\s+from|other\s+than)\b|\b(?:everything|all)\s+but\b|\bonly\s+(?:change|redo|replace)\b/i;
// A constraint on the luggage, as opposed to CARRY_ON's question about it.
const CARRY_ON_ONLY = /\bcarry[\s-]?on\s+(?:bag\s+|luggage\s+|suitcase\s+)?only\b|\b(?:only|just)\s+(?:(?:taking|bringing|have|packing)\s+)?(?:a\s+|one\s+)?carry[\s-]?on\b|\bhand\s+luggage\s+only\b|\bno\s+checked\s+(?:bag|luggage)\b/i;
const COUNT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, a: 1, single: 1, '1': 1, '2': 2, '3': 3, '4': 4 };
// "only two pairs of shoes", "just one jacket", "max 2 shoes", "no more than two pairs"
const MAX_COUNT = /\b(?:only|just|max(?:imum)?|at\s+most|no\s+more\s+than|limit(?:\s+it)?\s+to|up\s+to)\s+(one|two|three|four|a|single|[1-4])\s+(?:pairs?\s+of\s+)?([a-z]+)/i;
// "two pairs of shoes max", "one jacket only"
const COUNT_ONLY = /\b(one|two|three|four|single|[1-4])\s+(?:pairs?\s+of\s+)?([a-z]+)\s+(?:only|max(?:imum)?|tops?)\b/i;
const FEWER = /\b(?:fewer|less)\s+(?:pairs?\s+of\s+)?([a-z]+)/i;
// "different shoes", "change Friday's shoes", "swap the jacket", "another top".
const REPLACE_ROLE = /\b(?:different|other|another|new|swap|switch|change|replace)\b/i;
// "swap the loafers for sneakers": what comes after for/with is what is wanted.
const SWAP_FOR = /\b(?:swap|switch|replace|change|trade)\b(.*?)\b(?:for|with|to)\b(.*)$/i;
// Changing a named day or occasion as a whole ("replace Saturday", "change dinner").
const CHANGE_SLOT = /\b(?:change|replace|redo|rework|swap\s+out|switch\s+up)\b/i;
const NEGATOR = /\b(?:no|not|nothing|without|avoid|skip|don'?t\s+(?:want|pack|bring|use))\b/i;
const PRONOUN = /\b(?:that|it|this|that\s+one|this\s+one|those|them)\b/i;
const NOT_OWNED = /\b(?:don'?t|do\s+not)\s+(?:own|have)\b[^.]*\b(?:anymore|any\s+more|now)\b|\bno\s+longer\s+(?:own|have)\b|\bgave\b[^.]*\baway\b|\bgot\s+rid\s+of\b|\bsold\b/i;
const WARMER = /\bwarmer\b|\bcolder\s+than\b|\bcolder\b|\bneed\s+(?:something\s+)?warm\b|\bmore\s+layers?\b/i;
const LIGHTER_LAYERS = /\blighter(?:\s+(?:layers?|jacket|coat|outer\s*(?:layer|wear)?))?\s*$|\blighter\s+(?:layers?|jacket|coat|outer)\b|\bcooler\b|\bwarmer\s+than\s+expected\b|\bfewer\s+layers\b/i;

const FILLER = new Set('actually ok okay also so well oh hmm yes yeah please hey right and then now'.split(' '));

function splitClauses(message: string): string[] {
  return message
    .split(/[.;!?]+|,?\s+but\s+|,\s*(?:and|then)\s+|\s+and\s+(?=(?:keep|don'?t|do\s+not|make|use|give|bring|pack|leave|no|remove|swap|actually)\b)|,\s*(?=(?:change|replace|swap|switch|make|keep|use|give|bring|pack|leave|remove|drop|don'?t|no)\b)/i)
    .map((clause) => clause.trim())
    // "Actually, bring the loafers back" splits off a bare "Actually"; a clause
    // of nothing but filler carries no instruction and must not become a note
    // that restyles the whole trip.
    .filter((clause) => clause && !words(clause).every((word) => FILLER.has(word)));
}

function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9']+/).map((word) => word.replace(/'/g, '')).filter(Boolean);
}

/** Garment classes a clause names, each with whether it was named in the plural. */
function namedClasses(clause: string): Array<{ garmentClass: string; plural: boolean; word: string }> {
  const out: Array<{ garmentClass: string; plural: boolean; word: string }> = [];
  for (const word of words(clause)) {
    const garmentClass = garmentClassOf(word);
    if (!garmentClass || out.some((entry) => entry.garmentClass === garmentClass)) continue;
    // "trousers", "jeans" and "shorts" are plural in form and singular in use.
    const pairNoun = /^(?:trousers|pants|jeans|shorts|chinos|leggings|sunglasses)$/.test(word);
    out.push({ garmentClass, plural: word.endsWith('s') && !pairNoun, word });
  }
  return out;
}

export function interpretPackingRefinement(context: PackingRefinementContext): PackingRefinementInterpretation {
  const result: PackingRefinementInterpretation = {
    ops: [],
    clarification: null,
    carryOnQuestion: false,
    notInCloset: [],
    notInPlan: [],
    notRejected: [],
    needsReference: false,
    nothingToRestore: false,
  };
  const message = context.message.trim();
  if (!message) return result;

  const allDates = context.tripDates && context.tripDates.length > 0
    ? context.tripDates
    : [...new Set(context.slots.map((slot) => slot.date))];
  const repeatSlotIds = (dates: string[]) =>
    (context.repeatDays ?? []).filter((day) => dates.includes(day.date)).flatMap((day) => day.slotIds);
  const planItemIds = [...new Set(context.slots.flatMap((slot) => slot.itemIds))];
  const titleOf = (id: string) => {
    const candidate = context.candidates.get(id);
    return candidate?.title ?? candidate?.category ?? 'that piece';
  };

  // ── Targets: which days / occasions does the message name? ────────────────
  // `inherited` carries a day named earlier in the SAME message: in "keep
  // Friday daytime, change dinner" the dinner is Friday's, not every dinner.
  const resolveTargets = (
    clause: string,
    inherited: string[] | null,
  ): { slotIds: string[] | null; ambiguousWeekday: string | null; dates: string[] | null } => {
    const lower = clause.toLowerCase();
    let dates: string[] | null = null;
    let ambiguousWeekday: string | null = null;
    for (const word of words(lower)) {
      const weekday = WEEKDAY_WORDS[word] ?? WEEKDAY_WORDS[word.replace(/s$/, '')];
      if (!weekday) continue;
      const matching = allDates.filter((date) => weekdayOf(date) === weekday);
      if (matching.length > 1) {
        if (context.resolvedDate && matching.includes(context.resolvedDate)) dates = [context.resolvedDate];
        else ambiguousWeekday = weekday;
      } else {
        dates = [...(dates ?? []), ...matching];
      }
    }
    const dayNumber = lower.match(/\bday\s+(\d{1,2})\b/);
    if (dayNumber) {
      const date = allDates[Number.parseInt(dayNumber[1], 10) - 1];
      if (date) dates = [...(dates ?? []), date];
    }
    if (/\bfirst\s+day\b/.test(lower) && allDates[0]) dates = [...(dates ?? []), allDates[0]];
    if (/\blast\s+day\b/.test(lower) && allDates.length) dates = [...(dates ?? []), allDates[allDates.length - 1]];

    const activities: PackingActivity[] = [];
    for (const [pattern, activity] of ACTIVITY_WORDS) {
      if (pattern.test(lower) && !activities.includes(activity)) activities.push(activity);
    }
    const ownDates = dates;
    if (!dates && activities.length > 0 && inherited) dates = inherited;
    if (!dates && activities.length === 0) return { slotIds: null, ambiguousWeekday, dates: ownDates };
    // A later day that re-wears an earlier look is changed by changing that look.
    const viaRepeat = dates ? repeatSlotIds(dates) : [];
    const slotIds = context.slots
      .filter((slot) => (!dates || dates.includes(slot.date) || viaRepeat.includes(slot.slotId)))
      .filter((slot) => activities.length === 0 || activities.includes(slot.activity) ||
        // "formal dinner" on a day whose slot is a formal event
        (activities.includes('dinner') && slot.activity === 'formal_event' && dates !== null))
      .map((slot) => slot.slotId);
    return { slotIds, ambiguousWeekday, dates: ownDates };
  };

  // ── Garment references against the plan and the Closet ────────────────────
  const matchPlanItems = (clause: string, garmentClass: string | null, within = planItemIds): string[] => {
    const colors = colorTokensOf([clause.toLowerCase()]);
    const pool = within.filter((id) => {
      const candidate = context.candidates.get(id);
      if (!candidate) return false;
      if (garmentClass && !candidateGarmentClasses(candidate).includes(garmentClass)) return false;
      if (colors.length > 0) {
        const own = candidate.colors.join(' ').toLowerCase();
        if (!colors.some((color) => own.includes(color))) return false;
      }
      return true;
    });
    if (garmentClass || colors.length > 0) return pool;
    // No garment word: fall back to the item's own words (a brand, a title).
    const tokens = words(clause).filter((word) => word.length > 2 && !STOP.has(word));
    if (tokens.length === 0) return [];
    const scored = within.map((id) => {
      const candidate = context.candidates.get(id);
      const vocabulary = new Set(words(`${candidate?.title ?? ''} ${candidate?.brand ?? ''} ${candidate?.subcategory ?? ''}`));
      return { id, hits: tokens.filter((token) => vocabulary.has(token)).length };
    });
    const best = Math.max(0, ...scored.map((entry) => entry.hits));
    return best === 0 ? [] : scored.filter((entry) => entry.hits === best).map((entry) => entry.id);
  };

  /**
   * Plan items a garment word refers to. The garment class first ("the
   * loafers"); if the plan holds none of that class, the umbrella role the
   * word names ("the pants" when the look holds jeans). Colour qualifiers
   * narrow either way.
   */
  const itemsNamed = (clause: string, word: string, garmentClass: string | null, within = planItemIds): string[] => {
    const byClass = garmentClass ? matchPlanItems(clause, garmentClass, within) : [];
    if (byClass.length > 0) return byClass;
    const role = layeringRoleOfWord(word);
    if (!role) return [];
    const colors = colorTokensOf([clause.toLowerCase()]);
    return within.filter((id) => {
      const candidate = context.candidates.get(id);
      if (!candidate || candidate.layeringRole !== role) return false;
      if (colors.length === 0) return true;
      const own = candidate.colors.join(' ').toLowerCase();
      return colors.some((color) => own.includes(color));
    });
  };

  const closetHasClass = (garmentClass: string, word: string): string[] => {
    const role = layeringRoleOfWord(word);
    const byClass = [...context.candidates.entries()]
      .filter(([, candidate]) => candidateGarmentClasses(candidate).includes(garmentClass))
      .map(([id]) => id);
    if (byClass.length > 0 || !role) return byClass;
    return [...context.candidates.entries()].filter(([, candidate]) => candidate.layeringRole === role).map(([id]) => id);
  };

  const slotItems = (slotIds: string[] | null): string[] =>
    [...new Set(context.slots.filter((slot) => !slotIds || slotIds.includes(slot.slotId)).flatMap((slot) => slot.itemIds))];

  const askWhich = (ids: string[], noun: string) => {
    if (context.resolvedItemId && ids.includes(context.resolvedItemId)) return context.resolvedItemId;
    result.clarification ??= {
      question: `Which ${noun} do you mean?`,
      options: ids.slice(0, 4).map((id) => ({ kind: 'item', value: id, label: titleOf(id) })),
    };
    return null;
  };

  /** The role a count or replacement phrase names: "shoes", "pairs", "jacket", "loafers". */
  const roleOfWord = (word: string): string | null => {
    const umbrella = layeringRoleOfWord(word);
    if (umbrella) return umbrella;
    const garmentClass = garmentClassOf(word);
    if (!garmentClass) return null;
    const owned = [...context.candidates.values()].find((candidate) =>
      candidateGarmentClasses(candidate).includes(garmentClass)
    );
    return owned?.layeringRole ?? null;
  };

  let inheritedDates: string[] | null = null;
  for (const clause of splitClauses(message)) {
    const lower = clause.toLowerCase();
    const { slotIds, ambiguousWeekday, dates } = resolveTargets(clause, inheritedDates);
    if (dates) inheritedDates = dates;
    if (ambiguousWeekday && !result.clarification) {
      const options = allDates
        .filter((date) => weekdayOf(date) === ambiguousWeekday)
        .map((date) => ({ kind: 'day' as const, value: date, label: dayLabel(date) }));
      result.clarification = { question: `Which ${ambiguousWeekday} do you mean?`, options };
      continue;
    }
    const classes = namedClasses(clause);
    const directives = readRefinementDirectives(clause);
    const clauseWords = words(clause);

    // A question about the plan is answered from the plan, and changes nothing.
    // Without this, "why did you pack two blazers?" read as "use blazers".
    if (EXPLAIN.test(clause)) {
      const named = classes[0] ?? null;
      const roleWord = clauseWords.find((word) => layeringRoleOfWord(word));
      const itemIds = named
        ? itemsNamed(clause, named.word, named.garmentClass)
        : roleWord
        ? itemsNamed(clause, roleWord, null)
        : [];
      result.ops.push({ kind: 'explain', itemIds, noun: named?.word ?? roleWord ?? 'pieces' });
      continue;
    }

    let handled = false;
    let consumed = false;

    if (CARRY_ON_ONLY.test(clause)) {
      result.ops.push({ kind: 'carry_on_only' });
      handled = true;
      consumed = true;
    } else if (CARRY_ON.test(clause)) {
      result.carryOnQuestion = true;
      handled = true;
    }
    if (NO_SHOP.test(clause) || OWNED_ONLY.test(clause) || directives.constraints.includes('owned_only')) {
      result.ops.push({ kind: 'owned_only' });
      handled = true;
    } else if (SHOP.test(clause)) {
      result.ops.push({ kind: 'allow_shopping' });
      handled = true;
    }
    if (LAUNDRY_NO.test(clause)) {
      result.ops.push({ kind: 'laundry', available: false });
      handled = true;
    } else if (LAUNDRY_YES.test(clause)) {
      result.ops.push({ kind: 'laundry', available: true });
      handled = true;
    }
    const conditions = readStatedConditions(clause);
    // "It's colder than expected" states cold at the destination, like "it's cold".
    if (/\bcolder\b/i.test(clause) && !conditions.includes('cold')) conditions.push('cold');
    for (const condition of conditions) {
      result.ops.push({ kind: 'condition', condition });
      handled = true;
    }
    const packLight = PACK_LIGHT.test(clause);
    if (packLight) {
      result.ops.push({ kind: 'pack_light' });
      handled = true;
    }
    if (!packLight) {
      if (LIGHTER_LAYERS.test(clause)) {
        result.ops.push({ kind: 'warmth', slotIds, direction: 'lighter' });
        handled = true;
        consumed = true;
      } else if (WARMER.test(clause)) {
        result.ops.push({ kind: 'warmth', slotIds, direction: 'warmer' });
        handled = true;
        consumed = true;
      }
    }

    // Counts: "only two pairs of shoes", "one jacket only", "fewer shoes".
    const count = MAX_COUNT.exec(clause) ?? COUNT_ONLY.exec(clause);
    const countRole = count ? roleOfWord(count[2]) : null;
    if (count && countRole) {
      result.ops.push({ kind: 'max_role', role: countRole, max: COUNT_WORDS[count[1].toLowerCase()] ?? 1 });
      handled = true;
      consumed = true;
    } else {
      const fewer = FEWER.exec(clause);
      const fewerRole = fewer ? roleOfWord(fewer[1]) : null;
      if (fewer && fewerRole) {
        const current = slotItems(null).filter((id) => context.candidates.get(id)?.layeringRole === fewerRole).length;
        result.ops.push({ kind: 'max_role', role: fewerRole, max: Math.max(1, current - 1) });
        handled = true;
        consumed = true;
      }
    }
    if (consumed) continue;
    if (handled && classes.length === 0 && !slotIds) continue;

    // "Keep everything except Saturday": Saturday changes, everything else is kept.
    // Untouched looks are already carried verbatim by a local refinement, so
    // nothing is pinned behind the traveller's back -- a later "make Friday
    // casual" must not hit a lock they never asked for.
    if (slotIds && slotIds.length > 0 && EXCEPT.test(clause)) {
      result.ops.push({ kind: 'alternative', slotIds });
      continue;
    }

    // Pins name days; keeping a garment pins the garment.
    if (UNPIN.test(clause) && slotIds) {
      result.ops.push({ kind: 'unpin_slots', slotIds });
      continue;
    }
    if (slotIds && classes.length === 0 && (PIN.test(clause) || (KEEP.test(clause) && !LESS_FORMAL.test(clause) && !MORE_FORMAL.test(clause)))) {
      result.ops.push({ kind: 'pin_slots', slotIds });
      continue;
    }

    // Repeat rules name a role ("don't repeat trousers").
    const roleWord = clauseWords.map((word) => layeringRoleOfWord(word)).find(Boolean) ?? null;
    if (roleWord && REWEAR_OK.test(clause) && !/\bdon'?t\s+(?:want|like)\b/i.test(clause)) {
      result.ops.push({ kind: 'rewear_ok', role: roleWord });
      continue;
    }
    if (roleWord && NO_REPEAT.test(clause)) {
      result.ops.push({ kind: 'no_repeat', role: roleWord });
      continue;
    }

    if (RESTORE.test(clause)) {
      if (classes.length === 0 && context.rejectedItemIds.length === 0 && context.rejectedClasses.length === 0) {
        result.nothingToRestore = true;
        continue;
      }
      for (const named of classes.length ? classes : [{ garmentClass: '', plural: false, word: '' }]) {
        const rejected = context.rejectedItemIds.filter((id) => {
          const candidate = context.candidates.get(id);
          return candidate && (!named.garmentClass || candidateGarmentClasses(candidate).includes(named.garmentClass));
        });
        if (named.garmentClass && context.rejectedClasses.includes(named.garmentClass)) {
          result.ops.push({ kind: 'restore_class', garmentClass: named.garmentClass });
        } else if (!named.garmentClass && rejected.length === 0 && context.rejectedClasses.length === 1) {
          // "Go back" after "no heels": the one thing that was ruled out.
          result.ops.push({ kind: 'restore_class', garmentClass: context.rejectedClasses[0] });
          continue;
        }
        if (rejected.length === 1 || (named.plural && rejected.length > 0)) {
          for (const id of rejected) result.ops.push({ kind: 'restore_item', itemId: id });
        } else if (rejected.length > 1) {
          const chosen = askWhich(rejected, named.word || 'piece');
          if (chosen) result.ops.push({ kind: 'restore_item', itemId: chosen });
        } else if (!named.garmentClass || !context.rejectedClasses.includes(named.garmentClass)) {
          if (named.word) result.notRejected.push(named.word);
          else result.nothingToRestore = true;
        }
      }
      continue;
    }

    // "Take that out" / "I don't own that anymore": the piece is whatever the
    // traveller selected on screen. With no selection it is not knowable, and
    // guessing would remove the wrong garment (ADD-14).
    if (classes.length === 0 && !roleWord && (REMOVE.test(clause) || NOT_OWNED.test(clause)) && PRONOUN.test(clause) &&
      colorTokensOf([lower]).length === 0) {
      if (context.resolvedItemId && planItemIds.includes(context.resolvedItemId)) {
        result.ops.push({
          kind: 'reject_item',
          itemId: context.resolvedItemId,
          ...(NOT_OWNED.test(clause) ? { reason: 'not_owned' as const } : {}),
        });
      } else {
        result.needsReference = true;
      }
      continue;
    }

    // "Not black", "no leather": an attribute ruled out, with no garment named.
    if (classes.length === 0 && !roleWord && NEGATOR.test(clause)) {
      const colors = colorTokensOf([lower]);
      if (colors.length > 0) {
        for (const color of colors) result.ops.push({ kind: 'exclude_color', color });
        continue;
      }
      const materials = new Set<string>();
      for (const candidate of context.candidates.values()) {
        for (const value of candidate.materials) for (const word of words(value)) if (word.length > 3) materials.add(word);
      }
      const excluded = clauseWords.filter((word) => materials.has(word));
      if (excluded.length > 0) {
        for (const material of excluded) result.ops.push({ kind: 'exclude_material', material });
        continue;
      }
    }

    // "Swap the loafers for sneakers": the part after for/with is what is wanted.
    const swapFor = SWAP_FOR.exec(clause);
    const wantedAfterFor = swapFor ? namedClasses(swapFor[2]) : [];

    // "Different shoes", "change Friday's shoes", "swap the jacket": replace the
    // named role in the targeted looks and leave every other piece where it is.
    if (REPLACE_ROLE.test(clause) && wantedAfterFor.length === 0 && !/\bdon'?t\s+(?:change|swap|replace|touch)\b/i.test(clause) &&
      !REMOVE.test(clause) && !/\binstead\b/i.test(clause)) {
      const named = classes[0] ?? null;
      const word = named?.word ?? clauseWords.find((entry) => layeringRoleOfWord(entry)) ?? null;
      if (word) {
        const role = roleOfWord(word);
        const within = slotItems(slotIds);
        const ids = itemsNamed(clause, word, named?.garmentClass ?? null, within);
        if (role && ids.length > 0) {
          result.ops.push({ kind: 'replace_role', role, slotIds, itemIds: ids });
        } else {
          result.notInPlan.push(word);
        }
        continue;
      }
    }

    if (classes.length > 0 && REMOVE.test(clause) && !/\binstead\s+of\b/i.test(clause)) {
      const notOwned = NOT_OWNED.test(clause);
      for (const named of classes) {
        // "the loafers" names a specific pair; "heels" / "no heels" / "any
        // heels" names the class. The word before the garment (colour words
        // skipped) decides, not the plural -- shoes are always plural.
        const before = words(lower.slice(0, lower.indexOf(named.word)));
        let cursor = before.length - 1;
        while (cursor >= 0 && colorTokensOf([before[cursor]]).length > 0) cursor -= 1;
        const colourQualified = cursor < before.length - 1;
        const determiner = before[cursor] ?? '';
        const specific = DETERMINERS.has(determiner);
        if (!specific && colourQualified) {
          // "No black shoes" rules out black shoes, not every shoe. Every owned
          // piece that matches both is rejected by id; a piece whose colour is
          // not recorded is left alone rather than guessed at.
          const matching = itemsNamed(clause, named.word, named.garmentClass, [...context.candidates.keys()]);
          if (matching.length === 0) result.notInPlan.push(`${before.slice(cursor + 1).join(' ')} ${named.word}`.trim());
          for (const id of matching) result.ops.push({ kind: 'reject_item', itemId: id });
          continue;
        }
        if (!specific && (named.plural || QUANTIFIERS.has(determiner))) {
          result.ops.push({ kind: 'reject_class', garmentClass: named.garmentClass });
          continue;
        }
        const matches = itemsNamed(clause, named.word, named.garmentClass);
        if (matches.length === 1) {
          result.ops.push({ kind: 'reject_item', itemId: matches[0], ...(notOwned ? { reason: 'not_owned' as const } : {}) });
        } else if (matches.length > 1) {
          const chosen = askWhich(matches, named.word);
          if (chosen) result.ops.push({ kind: 'reject_item', itemId: chosen, ...(notOwned ? { reason: 'not_owned' as const } : {}) });
        } else {
          result.notInPlan.push(named.word);
        }
      }
      continue;
    }

    const keepish = KEEP.test(clause) || /\bdon'?t\s+(?:change|swap|replace|touch)\b/i.test(clause);
    if (classes.length > 0 && (PREFER.test(clause) || keepish || INCLUDE.test(clause) || wantedAfterFor.length > 0)) {
      // "instead of the loafers" names what is being replaced, not what is wanted.
      const insteadIndex = lower.search(/\binstead\s+of\b/);
      const wanted = wantedAfterFor.length > 0
        ? wantedAfterFor
        : insteadIndex >= 0
        ? classes.filter((entry) => lower.indexOf(entry.word) < insteadIndex)
        : classes;
      for (const named of wanted) {
        const owned = closetHasClass(named.garmentClass, named.word);
        if (owned.length === 0) {
          const phrase = clause
            .replace(/^.*?\b(?:pack|bring|add|include|take|use|wear|keep)\b\s*/i, '')
            .replace(/^(?:my|the|your|these|those|this|that)\s+/i, '')
            .slice(0, 60) || named.word;
          result.notInCloset.push(/^(?:a|an|any|some)\s/i.test(phrase) ? phrase : `a ${phrase}`);
          continue;
        }
        if (keepish) {
          const matches = itemsNamed(clause, named.word, named.garmentClass);
          if (matches.length === 1) result.ops.push({ kind: 'pin_item', itemId: matches[0] });
          else if (matches.length > 1) {
            const chosen = askWhich(matches, named.word);
            if (chosen) result.ops.push({ kind: 'pin_item', itemId: chosen });
          } else result.notInPlan.push(named.word);
          continue;
        }
        const colors = colorTokensOf([wantedAfterFor.length > 0 && swapFor ? swapFor[2].toLowerCase() : lower]);
        const specific = owned.filter((id) => {
          if (colors.length === 0) return true;
          const own = context.candidates.get(id)!.colors.join(' ').toLowerCase();
          return colors.some((color) => own.includes(color));
        });
        if (specific.length === 0) {
          result.notInCloset.push(`a ${colors.join(' ')} ${named.word}`.replace(/\s+/g, ' ').trim());
          continue;
        }
        if (INCLUDE.test(clause) && !PREFER.test(clause) && specific.length === 1 && !planItemIds.includes(specific[0])) {
          result.ops.push({ kind: 'include_item', itemId: specific[0] });
          continue;
        }
        result.ops.push({ kind: 'prefer_class', slotIds, garmentClass: named.garmentClass });
      }
      continue;
    }

    if (LESS_FORMAL.test(clause) || directives.constraints.includes('less_formal')) {
      result.ops.push({ kind: 'formality', slotIds, direction: 'less_formal' });
      continue;
    }
    if (MORE_FORMAL.test(clause) || directives.constraints.includes('more_formal')) {
      result.ops.push({ kind: 'formality', slotIds, direction: 'more_formal' });
      continue;
    }

    const color = readColorPreference(clause, colorTokensOf);
    if (color) {
      result.ops.push({ kind: 'color', slotIds, preference: color });
      continue;
    }
    if (ALTERNATIVE.test(clause) || (slotIds && classes.length === 0 && CHANGE_SLOT.test(clause))) {
      result.ops.push({ kind: 'alternative', slotIds });
      continue;
    }
    if (KEEP.test(clause) && classes.length === 0 && !slotIds) continue;
    if (!handled) result.ops.push({ kind: 'free_text', slotIds, note: clause.slice(0, 300) });
  }

  return result;
}
