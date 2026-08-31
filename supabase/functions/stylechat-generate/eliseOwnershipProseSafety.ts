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

import type {
  EliseFocusedItem,
  EliseScoredCandidate,
  EliseWardrobeCandidate,
} from './eliseAdviceTypes.ts';

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
  // CON-PROSE-001. "Wardrobe" is the word a person is most likely to use for
  // the same idea, and none of the patterns above contain it -- so
  // "the navy blazer is already in your wardrobe" asserted ownership as
  // plainly as any of them and was not even examined. It reads as an ownership
  // claim to the customer, so it is one here.
  /\bin\s+your\s+wardrobe\b/i,
  /\bfrom\s+your\s+wardrobe\b/i,
  /\byour\s+wardrobe\s+(?:already\s+)?(?:has|includes|contains|holds)\b/i,
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

/**
 * CON-ABSENCE-005 -- the OTHER half of the ownership boundary.
 *
 * Ownership and absence are two factual claims about the same store, and only
 * one of them was ever guarded. A non-K+ actor -- who has no Closet at all,
 * because RLS gates `user_closet_items` on `has_active_k_plus()` -- was told
 * "I don't currently have any outerwear items listed in your Closet". That is a
 * factual claim about the contents of a store the turn had no census of.
 *
 * The structured layer already had the right authority for this
 * (`censusConfirmsRoleAbsent`: absence is a fact only when the census was
 * EXHAUSTIVE and nothing went unclassified). Nothing checked the PROSE against
 * it, and the ownership guard could not have: it only runs when owned evidence
 * exists, which is precisely when this failure does not happen.
 *
 * The invariant, stated once:
 *
 *   A factual assertion that the Closet/wardrobe LACKS something requires
 *   authoritative Closet census provenance.
 *
 * This is deliberately NOT symmetric with the ownership guard's gating. An
 * ownership claim is dangerous when evidence is thin; an absence claim is most
 * dangerous when there is NO evidence at all, so this half must run exactly
 * where the other half stands down.
 */
const ABSENCE_ASSERTIONS: RegExp[] = [
  // Second person, possession negated. `(?!\s+to\b)` keeps "you don't have to
  // wear a jacket" -- ordinary advice -- out of the claim class.
  /\byou\s+(?:do\s+not|don'?t|did\s+not|didn'?t)\s+(?:currently\s+|already\s+)?(?:seem\s+to\s+)?(?:own|have)\b(?!\s+to\b)/i,
  /\byou\s+have\s+(?:no|none)\b/i,
  // "you are missing" AND the contraction "you're missing" -- the apostrophe is
  // not whitespace, so `you\s+re` would never have matched the form people
  // actually write.
  /\byou(?:\s*'re|\s+are)\s+missing\b/i,
  /\byou\s+lack\b/i,
  // The store itself as subject.
  /\byour\s+(?:closet|wardrobe)\s+(?:does\s+not|doesn'?t)\s+(?:contain|include|have|hold)\b/i,
  /\byour\s+(?:closet|wardrobe)\s+(?:has|holds|contains)\s+(?:no|none)\b/i,
  /\byour\s+(?:closet|wardrobe)\s+is\s+(?:missing|empty)\b/i,
  // Scoped negation anywhere in the sentence, e.g. "there aren't any jackets in
  // your wardrobe", "nothing in your Closet", "not in your Closet".
  /\b(?:no|none|not\s+any|nothing|aren'?t\s+any|isn'?t\s+any)\b[^.!?]*\b(?:in|from)\s+your\s+(?:closet|wardrobe)\b/i,
  /\bnot\s+(?:in|from)\s+your\s+(?:closet|wardrobe)\b/i,
  // First-person assistant phrasing -- the exact shape CON-ABSENCE-005 shipped.
  /\bi\s+(?:do\s+not|don'?t)\s+(?:currently\s+)?(?:see|have|find|show)\b[^.!?]*\b(?:in|from|on)\s+your\s+(?:closet|wardrobe)\b/i,
  /\bi\s+(?:do\s+not|don'?t)\s+(?:currently\s+)?(?:see|have|find|show)\s+any\b/i,
];

/**
 * Category and role words an absence claim can be ABOUT, on top of the garment
 * nouns above.
 *
 * The census counts by category and by layering role, and the failing sentence
 * named a ROLE ("outerwear"), not a garment. Checking garment nouns alone would
 * have missed the very claim this exists to catch.
 */
const ABSENCE_CATEGORY_NOUNS = [
  'outerwear', 'footwear', 'knitwear', 'activewear', 'swimwear', 'loungewear',
  'sleepwear', 'headwear', 'eyewear', 'legwear',
  'bottom', 'accessory', 'layer', 'denim', 'tailoring', 'suit', 'jewelry',
  'jewellery', 'outerlayer', 'midlayer', 'baselayer',
];

/** The subject vocabulary for an absence claim: garments plus categories. */
function absenceSubjectOf(word: string): string | null {
  for (const variant of wordVariants(word)) {
    if (GARMENT_NOUNS.includes(variant)) return variant;
    if (ABSENCE_CATEGORY_NOUNS.includes(variant)) return variant;
  }
  return null;
}

/**
 * What the turn can honestly say the Closet does NOT hold.
 *
 * `censusAvailable` is the whole permission: it must already fold in the
 * census's own honesty conditions (exhaustive, nothing unclassified), so this
 * module never has to re-derive them and can never disagree with
 * `censusConfirmsRoleAbsent`.
 */
export interface EliseClosetAbsenceEvidence {
  /** True ONLY when an authoritative, exhaustive census backs absence claims. */
  censusAvailable: boolean;
  /** Category/role/garment tokens the census counted at least one item for. */
  presentSubjects?: string[];
}

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

/**
 * CON-PROSE-004 -- every plausible stem, not one guessed stem.
 *
 * This used to commit to a SINGLE normalization, and its `-es` rule fired on
 * words whose plural is merely `+s` over a stem already ending in `e`:
 *
 *   shoes -> sho      dresses -> dresse    totes -> tot
 *   mules -> mul      tees    -> te        sunglasses -> sunglasse
 *
 * None of those are in GARMENT_NOUNS, so the guard could not see a claim about
 * them AT ALL. "You already have brown shoes" -- the most natural way anyone
 * would phrase it -- was never examined, for any actor, however little they
 * owned. Six garment classes were structurally unguardable, two of them among
 * the most common things a person owns.
 *
 * English morphology is not worth guessing at. Produce every candidate stem
 * instead and let the caller match on any of them: over-generating a stem is
 * harmless (the extra forms are not garment nouns and match nothing), while
 * guessing wrong silently disables the guard.
 */
function wordVariants(value: string): string[] {
  const lower = value.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (lower.length < 3) return lower ? [lower] : [];
  const variants = new Set<string>([lower]);
  if (lower.length > 3 && lower.endsWith('ies')) variants.add(`${lower.slice(0, -3)}y`);
  if (lower.length > 3 && lower.endsWith('es')) variants.add(lower.slice(0, -2));
  if (lower.length > 2 && lower.endsWith('s') && !lower.endsWith('ss')) {
    variants.add(lower.slice(0, -1));
  }
  return [...variants];
}

/**
 * The garment class a word names, or null when it names none.
 *
 * One word yields at most one class: the first variant that is a known garment
 * noun. This is the ONLY place a word becomes a garment, so the vocabulary and
 * the claim check can never disagree about what "shoes" is.
 */
function garmentClassOf(word: string): string | null {
  for (const variant of wordVariants(word)) {
    if (GARMENT_NOUNS.includes(variant)) return variant;
  }
  return null;
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
/**
 * The garment classes a TITLE may license.
 *
 * CON-PROSE-002 -- a title is a NAME, not a taxonomy.
 *
 * Every word of the title used to be added to the vocabulary, so an owned
 * "Leather Shoe Bag" licensed the word `shoe` and the sentence "you already
 * have brown shoes" passed the guard for a customer who owns no shoes at all.
 * The same holds for a "Suit Carrier", a "Garment Bag", a "Shoe Tree" -- any
 * accessory whose name happens to contain another garment's noun.
 *
 * English noun phrases put the head noun last: "Leather Shoe Bag" IS a bag,
 * "Brown Shoes" ARE shoes, "Shirt Dress" IS a dress. So only the LAST garment
 * noun in the title is what the item actually is; earlier ones are modifiers
 * describing it. Licensing only the head keeps the true claim ("you already
 * have brown shoes" for an owned "Brown Shoes") and drops the false one.
 *
 * Words that are not garment nouns at all are still added: they are colours,
 * materials and brands, and they can never be the subject of the ownership
 * check, which only ever looks up GARMENT_NOUNS.
 */
function titleLicensedWords(title: string): string[] {
  const words = title.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (words.length === 0) return [];
  // English noun phrases put the head LAST, and in this domain a title is such
  // a phrase: "Navy Wool Trousers", "Leather Shoe Bag", "Cedar Shoe Tree". So
  // the final word is what the item IS, and a garment noun anywhere before it
  // is a modifier describing that thing -- never a thing the actor owns.
  //
  // Taking the last GARMENT noun instead would be wrong for the third example:
  // a shoe tree is not a shoe. Taking the last word is right for all three, and
  // when it is not a garment at all the title licenses no garment, which is the
  // safe direction. Taxonomy (category/subcategory) remains the primary
  // licensor, so a head-final miss cannot silently strip a claim the server's
  // own classification supports.
  const headIndex = words.length - 1;
  const licensed: string[] = [];
  words.forEach((word, index) => {
    if (garmentClassOf(word) && index !== headIndex) return;
    for (const variant of wordVariants(word)) {
      if (variant.length > 2) licensed.push(variant);
    }
  });
  return licensed;
}

function addCandidateWords(
  vocabulary: Set<string>,
  candidate: EliseWardrobeCandidate,
): void {
  if (candidate.actorRelationship !== 'owned') return;
  // Category and subcategory are TAXONOMY -- the server's own classification of
  // what the item IS -- so they license directly. The title is a NAME and goes
  // through the head-noun rule above.
  for (const field of [candidate.category, candidate.subcategory]) {
    if (typeof field !== 'string') continue;
    for (const word of field.split(/[^A-Za-z0-9]+/)) {
      for (const variant of wordVariants(word)) {
        if (variant.length > 2) vocabulary.add(variant);
      }
    }
  }
  if (typeof candidate.title === 'string') {
    for (const word of titleLicensedWords(candidate.title)) vocabulary.add(word);
  }
}

/**
 * AUDIT-CON-001/003 -- the FOCUS is owned evidence too.
 *
 * `rankAndBoundCandidates` deliberately drops the focused item from the
 * shortlist ("you do not recommend the thing you are building around"). Reading
 * the vocabulary off the shortlist alone therefore omits the single item the
 * whole turn is ABOUT, and the flagship sentence -- "the navy trousers you
 * already have work with your brown loafers" -- gets destroyed for naming a
 * garment the user demonstrably owns.
 *
 * Section 34 scopes this guard to removing FALSE claims. Deleting a true one is
 * strictly worse than the failure it was built to prevent, because the customer
 * loses correct advice and no system records that it happened.
 *
 * An ambiguous match contributes too: no single item resolved, but retrieval
 * proved several OWNED items fit the description, so ownership language about
 * that garment class is supported. A focus that is scanned, saved or shared
 * contributes nothing -- `addCandidateWords` enforces that.
 */
function ownedGarmentVocabulary(
  shortlist: EliseScoredCandidate[],
  focus?: EliseFocusedItem | null,
): Set<string> {
  const vocabulary = new Set<string>();
  for (const scored of shortlist) {
    addCandidateWords(vocabulary, scored.candidate);
  }
  if (focus?.candidate) addCandidateWords(vocabulary, focus.candidate);
  for (const candidate of focus?.ambiguousCandidates ?? []) {
    addCandidateWords(vocabulary, candidate);
  }
  return vocabulary;
}

/**
 * Split into sentences on terminal punctuation, keeping the punctuation so a
 * surviving sentence reads normally. Bounded by construction: the split is over
 * text the generation layer already length-capped.
 */
/**
 * Fold typographic apostrophes to ASCII for MATCHING only.
 *
 * Found while building the CON-ABSENCE-005 matrix: "You don't have any jackets
 * in your Closet." (U+2019) slipped every contraction pattern, because `don'?t`
 * matches `dont` and `don't` but not `don’t`. Generative output uses curly
 * apostrophes constantly, so a guard that only reads ASCII ones is a guard with
 * a hole the size of the model's default typography -- and the OWNERSHIP half
 * had the same hole ("you’ve got").
 *
 * Matching only. The sentence the customer reads is never rewritten by this
 * module; only the copy the regexes see is normalized.
 */
function foldApostrophes(value: string): string {
  return value.replace(/[‘’ʼ‛′]/g, "'");
}

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
   * The resolved focus, when the pipeline produced one. Optional so every
   * pre-existing caller keeps its exact behaviour; supplying it only ever
   * WIDENS what the guard accepts as true, never what it accepts as owned --
   * a non-owned focus still contributes no vocabulary.
   */
  focus?: EliseFocusedItem | null;
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

  const vocabulary = ownedGarmentVocabulary(input.shortlist, input.focus);
  const sentences = splitSentences(text);
  const kept: string[] = [];
  const conflictCodes = new Set<string>();

  for (const sentence of sentences) {
    // Matched against the apostrophe-folded copy; `sentence` itself is what is
    // kept or dropped, never a rewritten version of it.
    const probe = foldApostrophes(sentence);
    const assertsOwnership = OWNERSHIP_ASSERTIONS.some((pattern) => pattern.test(probe));
    if (!assertsOwnership) {
      kept.push(sentence);
      continue;
    }

    // One word -> at most one garment class, via the SAME resolver the
    // vocabulary was built with, so "shoes" here and "Shoes" in an owned item's
    // title can never resolve differently.
    const namedGarments = sentence
      .split(/[^A-Za-z0-9]+/)
      .map(garmentClassOf)
      .filter((garment): garment is string => garment !== null);

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

/**
 * Enforce the ABSENCE boundary on generated prose (CON-ABSENCE-005).
 *
 * A sentence is removed when it BOTH asserts that the Closet/wardrobe lacks
 * something AND names a subject the census cannot prove absent. Both halves are
 * required, which is what keeps ordinary styling advice untouched:
 *
 *   "A lightweight jacket could work well here."      -> no absence assertion
 *   "Consider adding outerwear for colder weather."   -> no absence assertion
 *   "You don't have to wear a jacket."                -> 'have to', not a claim
 *   "You don't have a jacket in your Closet."         -> claim, needs a census
 *
 * With NO authoritative census, nothing is provably absent, so every such claim
 * goes. With one, a claim passes only for a subject the census counted zero of
 * -- so "you don't own outerwear" survives an empty-outerwear Closet and is
 * removed from one that holds a coat.
 *
 * Same removal discipline as the ownership half: the offending SENTENCE is
 * dropped and never rewritten, because prose no system authored is a worse
 * outcome than the claim it replaced.
 */
export function enforceClosetAbsenceProseSafety(input: {
  text: string;
  evidence: EliseClosetAbsenceEvidence | null | undefined;
  neutralFallback: string;
}): EliseOwnershipProseVerdict {
  const text = typeof input.text === 'string' ? input.text : '';
  if (!text.trim()) {
    return { conflictDetected: false, safeText: text, conflictCodes: [] };
  }

  const censusAvailable = input.evidence?.censusAvailable === true;
  const present = new Set<string>();
  for (const subject of input.evidence?.presentSubjects ?? []) {
    if (typeof subject !== 'string') continue;
    // A census token is free-form ("Outerwear", "coats"), so it is resolved by
    // the SAME resolver the sentence goes through -- one vocabulary, one answer.
    for (const word of subject.split(/[^A-Za-z0-9]+/)) {
      const resolved = absenceSubjectOf(word);
      if (resolved) present.add(resolved);
    }
  }

  const kept: string[] = [];
  const conflictCodes = new Set<string>();

  for (const sentence of splitSentences(text)) {
    const probe = foldApostrophes(sentence);
    const assertsAbsence = ABSENCE_ASSERTIONS.some((pattern) => pattern.test(probe));
    if (!assertsAbsence) {
      kept.push(sentence);
      continue;
    }

    const subjects = sentence
      .split(/[^A-Za-z0-9]+/)
      .map(absenceSubjectOf)
      .filter((subject): subject is string => subject !== null);

    // Absence language naming nothing checkable is not a claim about an item
    // ("you're missing a bit of contrast here"). Leaving it is correct: this
    // guard removes unprovable claims, not hedged phrasing.
    if (!subjects.length) {
      kept.push(sentence);
      continue;
    }

    const unprovable = subjects.filter(
      (subject) => !censusAvailable || present.has(subject),
    );
    if (!unprovable.length) {
      kept.push(sentence);
      continue;
    }

    for (const subject of unprovable) {
      conflictCodes.add(
        censusAvailable ? `contradicted_absent_${subject}` : `ungrounded_absent_${subject}`,
      );
    }
  }

  if (!conflictCodes.size) {
    return { conflictDetected: false, safeText: text, conflictCodes: [] };
  }

  const surviving = kept.join(' ').trim();
  return {
    conflictDetected: true,
    safeText: surviving || input.neutralFallback,
    conflictCodes: [...conflictCodes].slice(0, 6),
  };
}
