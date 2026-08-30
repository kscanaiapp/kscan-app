/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C3 sections 33/34/35.
 *
 * Last-line guard against a false ownership claim reaching the customer.
 *
 * WHERE THIS SITS IN THE DEFENCE ORDER
 * ------------------------------------
 * It is fourth, not first. The order that matters is:
 *
 *   1. a grounded prompt that states ownership semantics explicitly
 *   2. server-authored structured metadata, which is the object layer the UI
 *      actually renders from
 *   3. bounded detection of an OBVIOUS ownership conflict   <- this module
 *   4. a deterministic neutral fallback when one is detected <- this module
 *
 * Steps 1 and 2 do the real work. If this module fires often, the prompt is
 * wrong and should be fixed there; a guard that is load-bearing is a bug.
 *
 * WHAT THIS DELIBERATELY IS NOT (section 34)
 * ------------------------------------------
 * Not an NLP pipeline, not a semantic parser, not a second LLM call, not a
 * prose rewriter. It matches a small set of literal ownership assertions against
 * the categories the server actually authorized as owned. Anything subtler than
 * that is out of scope on purpose: a clever checker that is occasionally wrong
 * is worse than a blunt one that is always explicable.
 *
 * WHY IT REPLACES RATHER THAN REPAIRS (section 35)
 * ------------------------------------------------
 * When an unsupported ownership claim is found, the offending SENTENCE is
 * dropped and -- if nothing safe survives -- neutral copy derived from
 * validated metadata takes its place. It never substitutes a different garment
 * name into the model's sentence. Guessing what the model meant and rewriting
 * it produces text no system authored and no human checked, which is a worse
 * failure than the one being fixed. The structured cards remain authoritative
 * either way, so dropping prose loses presentation, never evidence.
 */

import type { EliseScoredCandidate } from './eliseAdviceTypes.ts';

/**
 * Literal ownership assertions. Present tense, second person, about a garment
 * the user supposedly has. Kept small and explicit -- every entry here is a
 * phrase that a reader would fairly hear as "you own this".
 */
const OWNERSHIP_ASSERTIONS: RegExp[] = [
  /\byou\s+(?:already\s+)?own\b/i,
  /\byou\s+(?:already\s+)?have\b/i,
  /\byour\s+(?:existing|current)\b/i,
  /\bin\s+your\s+closet\b/i,
  /\bfrom\s+your\s+closet\b/i,
  /\byou\s*'?\s*ve\s+got\b/i,
  /\bthat\s+you\s+own\b/i,
];

/**
 * Garment nouns a false claim would name. Intentionally the same everyday
 * vocabulary a user would use, not the internal taxonomy -- the claim being
 * checked is the one the READER understands.
 */
const GARMENT_NOUNS = [
  'loafer', 'sneaker', 'trainer', 'boot', 'heel', 'pump', 'sandal', 'oxford',
  'brogue', 'derby', 'mule', 'shoe',
  'blazer', 'jacket', 'coat', 'trench', 'parka', 'bomber', 'cardigan', 'sweater',
  'jumper', 'hoodie', 'sweatshirt', 'pullover', 'vest',
  'shirt', 'blouse', 'tee', 'tshirt', 'top', 'tank', 'polo', 'turtleneck',
  'trouser', 'pant', 'jean', 'chino', 'short', 'skirt', 'legging',
  'dress', 'gown', 'jumpsuit', 'romper',
  'bag', 'purse', 'tote', 'clutch', 'backpack', 'belt', 'scarf', 'hat', 'cap',
  'watch', 'necklace', 'bracelet', 'sunglasses',
];

export interface EliseOwnershipProseVerdict {
  /** True when at least one unsupported ownership claim was removed. */
  conflictDetected: boolean;
  /** The text safe to show. Never a rewritten version of an unsafe sentence. */
  safeText: string;
  /**
   * Stable codes for telemetry. Garment CLASS only, never the sentence, the
   * item title or anything else that could carry Closet contents off-device.
   */
  conflictCodes: string[];
}

function normalizeWord(value: string): string {
  const lower = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lower.length > 3 && lower.endsWith('ies')) return `${lower.slice(0, -3)}y`;
  if (lower.length > 3 && lower.endsWith('es') && !lower.endsWith('ses')) return lower.slice(0, -2);
  if (lower.length > 2 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
  return lower;
}

/**
 * The garment vocabulary the server can honestly support ownership language
 * for: every word appearing in the category, subtype or title of a candidate
 * this actor genuinely OWNS.
 *
 * Saved, scanned, shared and discovered candidates contribute nothing here --
 * that is the entire point. An item the user photographed in a shop must not
 * license "you already have".
 */
function ownedGarmentVocabulary(shortlist: EliseScoredCandidate[]): Set<string> {
  const vocabulary = new Set<string>();
  for (const scored of shortlist) {
    if (scored.candidate.actorRelationship !== 'owned') continue;
    const fields = [
      scored.candidate.category,
      scored.candidate.subcategory,
      scored.candidate.title,
    ];
    for (const field of fields) {
      if (typeof field !== 'string') continue;
      for (const word of field.split(/[^A-Za-z0-9]+/)) {
        const normalized = normalizeWord(word);
        if (normalized.length > 2) vocabulary.add(normalized);
      }
    }
  }
  return vocabulary;
}

/**
 * Split into sentences on terminal punctuation, keeping the punctuation so a
 * surviving sentence reads normally. Bounded by construction: the split is over
 * text the generation layer already length-capped.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/**
 * Enforce the ownership boundary on generated prose.
 *
 * A sentence is removed when it BOTH asserts ownership AND names a garment the
 * owned evidence does not support. Both halves are required: "you already have
 * a strong base here" names no garment and stays; "a leather jacket works well
 * with these" asserts no ownership and stays. Only the intersection -- a
 * concrete ownership claim about a garment class the user has no owned evidence
 * for -- is unsafe.
 */
export function enforceOwnershipProseSafety(input: {
  text: string;
  shortlist: EliseScoredCandidate[];
  /**
   * Neutral copy used when nothing safe survives. Supplied by the caller so the
   * wording lives with the rest of the product copy rather than being invented
   * here.
   */
  neutralFallback: string;
}): EliseOwnershipProseVerdict {
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) {
    return { conflictDetected: false, safeText: text, conflictCodes: [] };
  }

  const vocabulary = ownedGarmentVocabulary(input.shortlist);
  const sentences = splitSentences(text);
  const kept: string[] = [];
  const conflictCodes = new Set<string>();

  for (const sentence of sentences) {
    const assertsOwnership = OWNERSHIP_ASSERTIONS.some((pattern) => pattern.test(sentence));
    if (!assertsOwnership) {
      kept.push(sentence);
      continue;
    }

    const words = sentence.split(/[^A-Za-z0-9]+/).map(normalizeWord);
    const namedGarments = words.filter((word) => GARMENT_NOUNS.includes(word));

    // Ownership language with no specific garment named is not a checkable
    // claim about an item ("you already have a good foundation"). Leaving it is
    // correct: this guard removes false claims, not confident tone.
    if (!namedGarments.length) {
      kept.push(sentence);
      continue;
    }

    const unsupported = namedGarments.filter((garment) => !vocabulary.has(garment));
    if (!unsupported.length) {
      kept.push(sentence);
      continue;
    }

    for (const garment of unsupported) conflictCodes.add(`unsupported_owned_${garment}`);
  }

  if (!conflictCodes.size) {
    return { conflictDetected: false, safeText: text, conflictCodes: [] };
  }

  const surviving = kept.join(' ').trim();
  return {
    conflictDetected: true,
    // Dropping the unsafe sentences is the whole repair. What remains is
    // untouched model prose, so nothing the user reads was synthesised by this
    // guard except the fallback, which is fixed product copy.
    safeText: surviving || input.neutralFallback,
    conflictCodes: [...conflictCodes].slice(0, 6),
  };
}
