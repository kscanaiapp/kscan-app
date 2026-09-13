/**
 * Recommendation rationale — one set of facts, two renderings (Build 35).
 *
 * Commerce owns the FACTS (what matched, budget fit, gap relationship,
 * availability state). This module turns those facts into short product-UI
 * copy. Elise converts the SAME facts into conversational language. There is
 * deliberately no second explanation pipeline and no model call on either
 * side: an explanation that cannot be derived from these fields is one K Scan
 * cannot support, and would be a claim rather than an explanation.
 */

import type { CommercialUsability } from './commercialUsability.ts';

export type RationaleFactCode =
  | 'explicit_color_match'
  | 'explicit_material_match'
  | 'explicit_silhouette_match'
  | 'explicit_attribute_missing'
  | 'functional_requirement_met'
  | 'confirmed_gap_match'
  | 'unconfirmed_gap_context'
  | 'occasion_match'
  | 'formality_match'
  | 'signature_style_aligned'
  | 'duplicate_of_owned'
  | 'budget_within'
  | 'budget_unknown';

export interface CommerceRationaleFacts {
  matchedAttributes: string[];
  factCodes: RationaleFactCode[];
  budgetFit: 'within' | 'over' | 'unknown';
  usability: CommercialUsability;
  gap: { gapCode: string; certainty: 'confirmed' | 'unconfirmed' } | null;
  relationship: 'external';
  priceComparable: boolean;
}

/**
 * Copy per fact.
 *
 * `unconfirmed_gap_context` is hedged in words, not just in data: Packing said
 * it could not confirm the absence, and the sentence a traveller reads has to
 * carry that same uncertainty or the firewall only exists in the types.
 */
const FACT_COPY: Readonly<Record<RationaleFactCode, string>> = {
  explicit_color_match: 'Matches the colour you asked for',
  explicit_material_match: 'Matches the material you asked for',
  explicit_silhouette_match: 'Matches the shape you asked for',
  explicit_attribute_missing: "Doesn't match everything you asked for",
  functional_requirement_met: 'Covers what you said you need it to do',
  confirmed_gap_match: 'Fills a gap in what you packed',
  unconfirmed_gap_context: "Shown because I couldn't confirm you already have this covered",
  occasion_match: 'Suits the occasion',
  formality_match: 'Matches the dress code',
  signature_style_aligned: 'Close to your usual style',
  duplicate_of_owned: 'Very close to something already in your Closet',
  budget_within: 'Within your budget',
  budget_unknown: "Price isn't comparable to your budget",
};

const MAX_LINES = 3;

/**
 * Short, evidence-backed lines for one recommendation card.
 *
 * Ordered by the facts' own order (which is the order the ranker produced
 * them in), de-duplicated, and capped — a card explains itself, it does not
 * recite a scorecard.
 */
export function rationaleLines(facts: CommerceRationaleFacts | null | undefined): string[] {
  if (!facts || !Array.isArray(facts.factCodes)) return [];
  const lines: string[] = [];
  for (const code of facts.factCodes) {
    const copy = FACT_COPY[code];
    if (!copy || lines.includes(copy)) continue;
    lines.push(copy);
    if (lines.length >= MAX_LINES) break;
  }
  return lines;
}

/**
 * The one sentence that must be true of every Commerce candidate.
 *
 * SAVE, WATCH, VIEW and BUY all leave this unchanged: only the explicit Closet
 * ownership flow can, and it does not run here.
 */
export function ownershipStatement(facts: CommerceRationaleFacts | null | undefined): string {
  return facts?.relationship === 'external' || !facts
    ? 'Not in your Closet'
    : 'Not in your Closet';
}

export type RecommendationLabel = 'BEST MATCH' | 'UNDER BUDGET' | 'MORE VERSATILE' | 'BEST VALUE';

/**
 * A deterministic label, or none.
 *
 * There are no fixed marketing roles to fill: a set with nothing distinctive
 * to say gets no labels at all, which is the honest outcome. `BEST VALUE`
 * requires a real same-currency comparison (`priceComparable`), and there is
 * no `CLOSEST VISUAL MATCH` because this build has no visual signal that could
 * support one.
 */
export function recommendationLabel(input: {
  rankIndex: number;
  facts: CommerceRationaleFacts | null | undefined;
  isCheapestComparable?: boolean;
}): RecommendationLabel | null {
  const facts = input.facts;
  if (!facts) return null;
  if (input.rankIndex === 0 && facts.usability === 'TRANSACTION_READY') return 'BEST MATCH';
  if (facts.budgetFit === 'within') return 'UNDER BUDGET';
  if (input.isCheapestComparable && facts.priceComparable) return 'BEST VALUE';
  if (facts.factCodes.includes('occasion_match') || facts.factCodes.includes('formality_match')) {
    return 'MORE VERSATILE';
  }
  return null;
}

/**
 * Facts handed to Elise so she can say the same thing in her own voice.
 *
 * Codes, not prose: giving Elise the rendered strings would make the product
 * UI's copy her script, and giving her freedom over the underlying claim would
 * make it a second explanation. She gets what is true and chooses the words.
 */
export function eliseRationaleFacts(facts: CommerceRationaleFacts | null | undefined): {
  factCodes: RationaleFactCode[];
  matchedAttributes: string[];
  budgetFit: 'within' | 'over' | 'unknown';
  gapCertainty: 'confirmed' | 'unconfirmed' | null;
  transactable: boolean;
  ownership: 'external';
} | null {
  if (!facts) return null;
  return {
    factCodes: facts.factCodes,
    matchedAttributes: facts.matchedAttributes,
    budgetFit: facts.budgetFit,
    gapCertainty: facts.gap?.certainty ?? null,
    transactable: facts.usability === 'TRANSACTION_READY',
    ownership: 'external',
  };
}

/**
 * Did the ranker record this candidate as matching the colour the customer
 * stated?
 *
 * A READ OF AN EXISTING DECISION. `explicit_color_match` is written by #409's
 * ranker during ranking; nothing here inspects a title, compares a colour or
 * re-derives anything. That matters because this fact decides how a shelf is
 * PRESENTED (BEST MATCHES versus OTHER OPTIONS), and a presentation layer that
 * made its own colour judgement would be a second opinion the customer could
 * catch disagreeing with the ordering.
 *
 * Absent evidence reads as "not a stated match", never as one: a zero-context
 * product carries no rationale at all, and must not be captioned as answering
 * a request nobody scored it against.
 */
export function matchedRequestedAttribute(product: unknown): boolean {
  if (!product || typeof product !== 'object') return false;
  const rationale = (product as { commerceRationale?: unknown }).commerceRationale;
  if (!rationale || typeof rationale !== 'object') return false;
  const codes = (rationale as { factCodes?: unknown }).factCodes;
  return Array.isArray(codes) && codes.includes('explicit_color_match');
}
