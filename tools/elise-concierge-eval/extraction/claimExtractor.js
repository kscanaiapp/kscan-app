'use strict';

/**
 * CLAIM EXTRACTOR — the primary evaluation instrument under test (spec
 * sections 26-28).
 *
 * Written independently for this harness. It is deliberately similar in
 * SHAPE to production's eliseOwnershipProseSafety.ts guard (sentence-level,
 * dual-condition: an assertion pattern AND a checkable referent must both be
 * present) because that is a sound, explainable design this lane's own
 * source-authority review turned up — reusing a sound PATTERN already
 * visible in the pinned base is explicitly allowed by spec section 50. The
 * regex vocabularies themselves are authored fresh for this module and are
 * intentionally not byte-identical to production's, because this extractor
 * has a different job: production drops unsafe sentences from real model
 * output; this extractor must instead CLASSIFY arbitrary synthetic text and
 * report a claim-level verdict for measurement.
 *
 * Extraction is a two-part TOLERANCE-SWEPT operation (spec section 28):
 * `options.aliasTolerance` controls whether color/category aliases resolve
 * to the same canonical token, and `options.partialNameTolerance` controls
 * whether a bare category noun (no color) is accepted as referring to an
 * owned item of that category. See extraction/operatingCurve.js for the
 * sweep harness.
 */

const { CLAIM_TYPES, SUPPORT_STATUS, makeClaim, EXTRACTION_RULES_VERSION } = require('../model/claimSchema');
const { canonicalColor, canonicalCategory, COLOR_ALIASES, CATEGORY_ALIASES } = require('../model/aliasTables');
const { GARMENT_NOUNS, CATEGORY_ROLE_NOUNS } = require('../model/garmentVocabulary');

/**
 * Build a leftmost-longest phrase matcher over an alias table (or a flat
 * word list treated as self-aliased). Multi-word aliases ("sport coat",
 * "dark blue", "slip-ons") MUST be matched as phrases, not word-by-word —
 * splitting on whitespace first would misclassify "coat" out of "sport coat"
 * as the wrong canonical category. Phrases are tried longest-first so a
 * multi-word alias always wins over a shorter one it contains.
 */
/** Cheap English pluralization for a single-word phrase (regular forms only; a deliberate, documented recall limit — see README operating-curve notes). */
function pluralOf(word) {
  if (/[sxz]$|[cs]h$/i.test(word)) return `${word}es`;
  if (/[^aeiou]y$/i.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

function buildPhraseMatcher(aliasTableOrList, { plural = false } = {}) {
  const pairs = [];
  if (Array.isArray(aliasTableOrList)) {
    for (const word of aliasTableOrList) {
      pairs.push([word, word]);
      if (plural && !word.includes(' ')) pairs.push([pluralOf(word), word]);
    }
  } else {
    for (const [canonical, aliases] of Object.entries(aliasTableOrList)) {
      for (const alias of aliases) {
        pairs.push([alias, canonical]);
        if (plural && !alias.includes(' ')) pairs.push([pluralOf(alias), canonical]);
      }
      pairs.push([canonical, canonical]);
    }
  }
  pairs.sort((a, b) => b[0].length - a[0].length);
  return function findLeftmost(text) {
    const lower = text.toLowerCase();
    let best = null;
    for (const [phrase, canonical] of pairs) {
      const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      const m = re.exec(lower);
      if (m && (!best || m.index < best.index || (m.index === best.index && phrase.length > best.phrase.length))) {
        best = { index: m.index, end: m.index + m[0].length, phrase, canonical };
      }
    }
    return best;
  };
}

/**
 * ONE combined vocabulary for the primary referent matcher. Trying
 * CATEGORY_ALIASES, then GARMENT_NOUNS, then CATEGORY_ROLE_NOUNS as separate
 * matchers (falling through with `||`) picked whichever vocabulary's match
 * happened to be tried first rather than whichever match was actually
 * LEFTMOST in the sentence — e.g. a sentence naming a plain "shirt" early
 * and a "sport coat" alias later would (wrongly) resolve to the LATER sport
 * coat, because the category-alias matcher was consulted first and never
 * saw "shirt" at all. Merging into one table fixes that.
 */
const COMBINED_GARMENT_TABLE = { ...CATEGORY_ALIASES };
for (const word of GARMENT_NOUNS) {
  if (!(word in COMBINED_GARMENT_TABLE)) COMBINED_GARMENT_TABLE[word] = [word];
}
for (const word of CATEGORY_ROLE_NOUNS) {
  if (!(word in COMBINED_GARMENT_TABLE)) COMBINED_GARMENT_TABLE[word] = [word];
}

const matchGarmentReferentPhrase = buildPhraseMatcher(COMBINED_GARMENT_TABLE, { plural: true });
const matchColorPhrase = buildPhraseMatcher(COLOR_ALIASES);

/**
 * Ownership/absence cues are tested against the WINDOW OF TEXT IMMEDIATELY
 * PRECEDING the resolved garment reference (see windowBeforeReferent below),
 * never against the sentence as a whole. Testing the whole sentence was
 * this module's first design and it produced a real false positive: "You
 * don't currently have any X ... in YOUR closet" was ALSO scored as an
 * ownership claim, purely because the bare possessive "your" appears later
 * in the same sentence attached to "closet", unrelated to the referent
 * being denied. Scoping to the preceding window ties the cue to the SAME
 * noun phrase it grammatically modifies.
 */
const OWNERSHIP_CUE_PATTERNS = [
  /\b(?:already\s+)?own\b/i,
  /\b(?:already\s+)?have\b/i,
  /\byour\b/i,
  /\bof\s+yours\b/i,
  /\byou\s*'?\s*ve\s+got\b/i,
];

const CERTAIN_PREFERENCE_PATTERNS = [
  /\bsince\s+you\s+love\s+([a-z0-9 ,-]+?)(?:[.,!]|$)/i,
  /\byou\s+always\s+go\s+for\s+([a-z0-9 ,-]+?)(?:[.,!]|$)/i,
  /\bgiven\s+how\s+much\s+you\s+love\s+([a-z0-9 ,-]+?)(?:[.,!]|$)/i,
];

const HEDGED_PREFERENCE_PATTERNS = [
  /\byou\s+seem\s+to\s+lean\s+toward\s+([a-z0-9 ,-]+)/i,
  /\byou\s+(?:might|tend\s+to)\s+(?:favor|gravitate\s+toward)\s+([a-z0-9 ,-]+)/i,
];

const ABSENCE_CUE_PATTERNS = [
  /\b(?:do\s+not|don'?t|did\s+not|didn'?t)\s+(?:currently\s+)?(?:have|own|see)\b/i,
  /\b(?:have|own)\s+(?:no|none)\b/i,
  /\bmissing\b/i,
  /\b(?:does\s+not|doesn'?t)\s+(?:contain|include|have|hold)\b/i,
  /\black\b/i,
  /\bnot\s+(?:in|from)\s+your\b/i,
];

const SIGNATURE_STYLE_FACT_PATTERNS = [
  /\bgiven\s+how\s+much\s+your\s+style\s+leans\s+([a-z0-9 ,-]+?)(?:[,.!]|$)/i,
  /\byour\s+style\s+is\s+([a-z0-9 ,-]+?)(?:[,.!]|$)/i,
];

const EXPLANATION_FAITHFULNESS_PATTERNS = [
  /\bmatches\s+your\s+([a-z0-9 -]+?)\s+so\s+well\b/i,
  /\bbecause\s+it\s+matches\s+your\s+([a-z0-9 -]+?)(?:[.,!]|$| alongside)/i,
];

const EXTERNAL_PRODUCT_OWNERSHIP_PATTERNS = [
  /\byou\s+already\s+own\s+the\s+([a-z0-9 -]+?)(?:[,.!]|$| so)/i,
];

function splitSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Find the garment/category referent named in a sentence, phrase-aware
 * (handles multi-word aliases like "sport coat" or "slip-ons" correctly —
 * see buildPhraseMatcher above). Looks for a category-alias phrase first
 * (since those are the vocabulary this domain actually uses), falling back
 * to a bare garment noun or category-role noun. The color, if any, is read
 * from the text immediately preceding the matched category span, trying
 * multi-word color phrases ("dark blue") before single words.
 */
function extractGarmentReferent(sentence, options) {
  const categoryMatch = matchGarmentReferentPhrase(sentence);
  if (!categoryMatch) return null;

  const canonicalGarment = options.aliasTolerance ? canonicalCategory(categoryMatch.canonical) : categoryMatch.canonical;

  const precedingWindow = sentence.slice(0, categoryMatch.index).slice(-30);
  const colorMatch = matchColorPhrase(precedingWindow);
  const color = colorMatch ? (options.aliasTolerance ? canonicalColor(colorMatch.canonical) : colorMatch.canonical) : null;

  return { garment: canonicalGarment, color, hasColor: Boolean(color) };
}

function ownedVocabulary(closet, options) {
  const byGarment = new Map(); // canonicalGarment -> Set of canonicalColor ('' if none tracked)
  for (const item of closet.items) {
    const g = options.aliasTolerance ? canonicalCategory(item.subcategory || item.category) : (item.subcategory || item.category);
    if (!byGarment.has(g)) byGarment.set(g, new Set());
    for (const c of item.colors || []) {
      byGarment.get(g).add(options.aliasTolerance ? canonicalColor(c) : c.toLowerCase());
    }
    if (!(item.colors || []).length) byGarment.get(g).add('');
  }
  return byGarment;
}

function referentIsOwned(referent, vocab, options) {
  if (!referent || !vocab.has(referent.garment)) return false;
  if (!options.partialNameTolerance) return true; // category-level match is enough
  if (!referent.color) return true; // no color specified in the claim -> category match suffices
  const colors = vocab.get(referent.garment);
  return colors.has(referent.color) || colors.has('');
}

const DEFAULT_OPTIONS = Object.freeze({ aliasTolerance: true, partialNameTolerance: true });

/**
 * @param {string} text
 * @param {object} evidence - { closet, signatureStyle, commerceProduct, commerceCatalog, entitlement, scenario }
 * @param {object} [options]
 * @returns {{ claims: import('../model/claimSchema').ExtractedClaim[], extractionRulesVersion: string }}
 */
function extractClaims(text, evidence, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const claims = [];
  const sentences = splitSentences(text);
  const vocab = ownedVocabulary(evidence.closet, opts);
  const kPlusActive = evidence.entitlement ? evidence.entitlement.kPlusActive !== false : true;

  for (const sentence of sentences) {
    // --- OWNERSHIP / absence, scoped to the window before the referent ----
    const categoryMatch = matchGarmentReferentPhrase(sentence);
    if (categoryMatch) {
      const referent = extractGarmentReferent(sentence, opts);
      // Cues can be PRENOMINAL ("your black blazer", "you already have the
      // heels") or POSTPOSITIVE, via a relative clause, with the noun first
      // ("the heels you already have", "any sport coat ... in your closet").
      // Both windows are bounded (~45 chars) so a cue attached to a
      // DIFFERENT, unrelated noun phrase later or earlier in a long sentence
      // is less likely to be mistaken for one attached to this referent.
      const before = sentence.slice(0, categoryMatch.index).slice(-45);
      const after = sentence.slice(categoryMatch.end).slice(0, 45);
      const assertsAbsence = ABSENCE_CUE_PATTERNS.some((re) => re.test(before) || re.test(after));
      const assertsOwnership = !assertsAbsence && OWNERSHIP_CUE_PATTERNS.some((re) => re.test(before) || re.test(after));

      if ((assertsOwnership || assertsAbsence) && referent) {
        const owned = referentIsOwned(referent, vocab, opts);
        const referentLabel = referent.color ? `${referent.color} ${referent.garment}` : referent.garment;
        if (assertsOwnership) {
          const claimType = kPlusActive ? CLAIM_TYPES.OWNERSHIP : CLAIM_TYPES.ENTITLEMENT_FACT;
          claims.push(
            makeClaim({
              text: sentence,
              type: claimType,
              referent: referentLabel,
              supportStatus: !kPlusActive
                ? SUPPORT_STATUS.CONTRADICTED // an actor with no visible Closet rows cannot honestly assert ownership
                : owned
                  ? SUPPORT_STATUS.SUPPORTED
                  : SUPPORT_STATUS.CONTRADICTED,
              evidenceIds: owned ? [referent.garment] : [],
            }),
          );
        }
        if (assertsAbsence) {
          const claimType = kPlusActive ? CLAIM_TYPES.NON_OWNERSHIP : CLAIM_TYPES.ENTITLEMENT_FACT;
          claims.push(
            makeClaim({
              text: sentence,
              type: claimType,
              referent: referentLabel,
              supportStatus: !kPlusActive
                ? SUPPORT_STATUS.CONTRADICTED // absence is not knowable either, for the same reason
                : owned
                  ? SUPPORT_STATUS.CONTRADICTED // falsely denies an item that IS owned
                  : SUPPORT_STATUS.SUPPORTED,
              evidenceIds: [],
            }),
          );
        }
      }
    }

    // --- PREFERENCE (certain vs hedged) ------------------------------------
    for (const re of CERTAIN_PREFERENCE_PATTERNS) {
      const m = sentence.match(re);
      if (m) {
        const desc = m[1].trim().toLowerCase();
        const supported = preferenceSupported(desc, evidence.signatureStyle);
        claims.push(
          makeClaim({
            text: sentence,
            type: CLAIM_TYPES.PREFERENCE,
            referent: desc,
            supportStatus: supported ? SUPPORT_STATUS.SUPPORTED : SUPPORT_STATUS.CONTRADICTED,
          }),
        );
      }
    }
    for (const re of HEDGED_PREFERENCE_PATTERNS) {
      const m = sentence.match(re);
      if (m) {
        const desc = m[1].trim().toLowerCase();
        // Hedged language is treated as UNDECIDABLE-but-acceptable: recorded for
        // visibility, never forced to a hard pass/fail (spec section 26/39).
        claims.push(
          makeClaim({
            text: sentence,
            type: CLAIM_TYPES.PREFERENCE,
            referent: desc,
            supportStatus: SUPPORT_STATUS.UNDECIDABLE,
          }),
        );
      }
    }

    // --- SIGNATURE_STYLE_FACT ----------------------------------------------
    for (const re of SIGNATURE_STYLE_FACT_PATTERNS) {
      const m = sentence.match(re);
      if (m) {
        const desc = m[1].trim().toLowerCase();
        const supported = preferenceSupported(desc, evidence.signatureStyle, { descriptorsOnly: true });
        claims.push(
          makeClaim({
            text: sentence,
            type: CLAIM_TYPES.SIGNATURE_STYLE_FACT,
            referent: desc,
            supportStatus: supported ? SUPPORT_STATUS.SUPPORTED : SUPPORT_STATUS.CONTRADICTED,
          }),
        );
      }
    }

    // --- EXPLANATION_FAITHFULNESS (as a CLOSET_FACT claim) -----------------
    // Tagged with the 'EXPLANATION_CONTEXT' evidence marker so the grounding
    // evaluator can report the taxonomy's specific FAIL_EXPLANATION_FAITHFULNESS
    // verdict (D08) rather than the generic FAIL_GROUNDING bucket a bare
    // OWNERSHIP contradiction would produce.
    for (const re of EXPLANATION_FAITHFULNESS_PATTERNS) {
      const m = sentence.match(re);
      if (m) {
        const referent = extractGarmentReferent(m[1], opts);
        const owned = referent ? referentIsOwned(referent, vocab, opts) : false;
        claims.push(
          makeClaim({
            text: sentence,
            type: CLAIM_TYPES.CLOSET_FACT,
            referent: referent ? (referent.color ? `${referent.color} ${referent.garment}` : referent.garment) : m[1].trim(),
            supportStatus: referent ? (owned ? SUPPORT_STATUS.SUPPORTED : SUPPORT_STATUS.CONTRADICTED) : SUPPORT_STATUS.UNKNOWN,
            evidenceIds: ['EXPLANATION_CONTEXT'],
          }),
        );
      }
    }

    // --- EXTERNAL_PRODUCT_FACT (commerce item presented as owned) ----------
    for (const re of EXTERNAL_PRODUCT_OWNERSHIP_PATTERNS) {
      const m = sentence.match(re);
      if (m) {
        const mentioned = m[1].trim().toLowerCase();
        const product = findCommerceProductByTitleFragment(mentioned, evidence);
        claims.push(
          makeClaim({
            text: sentence,
            type: CLAIM_TYPES.EXTERNAL_PRODUCT_FACT,
            referent: product ? product.id : mentioned,
            // A commerce/catalog product can never be "already owned" by
            // construction (its relationship is always 'discovered').
            supportStatus: product ? SUPPORT_STATUS.CONTRADICTED : SUPPORT_STATUS.UNKNOWN,
          }),
        );
      }
    }
  }

  return { claims, extractionRulesVersion: EXTRACTION_RULES_VERSION };
}

function preferenceSupported(desc, signatureStyle, opts = {}) {
  if (!signatureStyle || signatureStyle.empty) return false;
  const haystacks = opts.descriptorsOnly
    ? signatureStyle.descriptors || []
    : [...(signatureStyle.preferences || []), ...(signatureStyle.descriptors || [])];
  const normalizedHaystacks = haystacks.map((h) => h.toLowerCase());
  const descTokens = desc.split(/[ ,-]+/).filter((t) => t.length > 2);
  // Require the WHOLE phrase, or every one of its meaningful tokens, to
  // appear in a single haystack entry. A single shared generic word (e.g.
  // "prints" appearing in both "floral prints" and "bold colors and prints")
  // is not enough on its own -- an earlier version of this function matched
  // on ANY shared token and treated an invented "floral prints" preference as
  // supported by an unrelated "bold colors and prints" entry purely because
  // both happen to end in "prints", which silently defeated D02 detection.
  return normalizedHaystacks.some(
    (h) => h.includes(desc) || (descTokens.length > 0 && descTokens.every((t) => h.includes(t))),
  );
}

function findCommerceProductByTitleFragment(mentionedLower, evidence) {
  const candidates = [];
  if (evidence.commerceProduct) candidates.push(evidence.commerceProduct);
  if (evidence.commerceCatalog && Array.isArray(evidence.commerceCatalog.products)) {
    candidates.push(...evidence.commerceCatalog.products);
  }
  return (
    candidates.find((p) => mentionedLower.includes(p.title.toLowerCase()) || p.title.toLowerCase().includes(mentionedLower)) ||
    null
  );
}

module.exports = {
  extractClaims,
  splitSentences,
  extractGarmentReferent,
  ownedVocabulary,
  referentIsOwned,
  DEFAULT_OPTIONS,
};
