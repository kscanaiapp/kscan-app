'use strict';

/**
 * Phrasing variation bank — spec section 18 (PHRASING REALISM).
 *
 * The synthesizer must not generate only trivial, detector-friendly
 * sentences. This module supplies seeded variation across: direct/indirect/
 * possessive ownership language, non-ownership suggestion, hedged
 * preference, unsupported certainty, color/category aliasing, and
 * pronoun/partial-name reference — so the extractor is exercised against the
 * same range of surface forms a real assistant response could plausibly use.
 */

const { COLOR_ALIASES, CATEGORY_ALIASES } = require('../model/aliasTables');

function colorAlias(rng, color) {
  const options = COLOR_ALIASES[color] || [color];
  return rng.pick(options);
}

function categoryAlias(rng, subcategory) {
  const options = CATEGORY_ALIASES[subcategory] || [subcategory];
  return rng.pick(options);
}

/** Ownership-language templates, spanning the full realism spectrum of spec section 18. */
const OWNERSHIP_TEMPLATES = [
  (item) => `you own the ${item}`,
  (item) => `your ${item}`,
  (item) => `the ${item} you already have`,
  (item) => `that ${item} of yours`,
];

/** A SUGGESTION that names an item WITHOUT claiming ownership. */
const NON_OWNERSHIP_SUGGESTION_TEMPLATES = [
  (item) => `a ${item} would work well here`,
  (item) => `consider adding a ${item}`,
  (item) => `a ${item} could complete this look`,
];

const HEDGED_PREFERENCE_TEMPLATES = [
  (desc) => `you seem to lean toward ${desc}`,
  (desc) => `it looks like you tend to favor ${desc}`,
  (desc) => `based on a few signals, you might gravitate toward ${desc}`,
];

const UNSUPPORTED_CERTAINTY_TEMPLATES = [
  (desc) => `since you love ${desc}, this is definitely the one for you`,
  (desc) => `you always go for ${desc}, so you will love this`,
  (desc) => `this is without question your best option, given how much you love ${desc}`,
];

function pickOwnershipPhrase(rng, itemLabel) {
  return rng.pick(OWNERSHIP_TEMPLATES)(itemLabel);
}

function pickNonOwnershipSuggestion(rng, itemLabel) {
  return rng.pick(NON_OWNERSHIP_SUGGESTION_TEMPLATES)(itemLabel);
}

function pickHedgedPreference(rng, desc) {
  return rng.pick(HEDGED_PREFERENCE_TEMPLATES)(desc);
}

function pickUnsupportedCertainty(rng, desc) {
  return rng.pick(UNSUPPORTED_CERTAINTY_TEMPLATES)(desc);
}

/** Render an item's display label with seeded alias variation. */
function itemLabel(rng, item, options = {}) {
  const color = item.colors && item.colors.length ? colorAlias(rng, item.colors[0]) : null;
  const subcat = categoryAlias(rng, item.subcategory || item.category);
  if (options.partialName) {
    // Partial item name: drop the color, keep only the category noun.
    return subcat;
  }
  return color ? `${color} ${subcat}` : subcat;
}

const EXPLANATION_CONNECTORS = [
  'because it pairs cleanly with',
  'since it works well alongside',
  'as a strong match for',
  'which complements',
];

function explanationSentence(rng, subjectLabel, groundedReasonLabel) {
  const connector = rng.pick(EXPLANATION_CONNECTORS);
  return `I'd reach for the ${subjectLabel} ${connector} ${groundedReasonLabel}.`;
}

module.exports = {
  colorAlias,
  categoryAlias,
  itemLabel,
  pickOwnershipPhrase,
  pickNonOwnershipSuggestion,
  pickHedgedPreference,
  pickUnsupportedCertainty,
  explanationSentence,
};
