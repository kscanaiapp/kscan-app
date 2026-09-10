'use strict';

/**
 * Compatibility layer against K Scan's existing research and production
 * fashion-attribute shapes (spec section 13). Two things live here:
 *
 *   1. CONTRACT_FIELD_COMPATIBILITY — a machine-readable matrix classifying
 *      each of the seven CanonicalFashionAttributesV1 fields against each
 *      existing system as DIRECT / ALIAS / TRANSFORM /
 *      NOT_CURRENTLY_REPRESENTED, so a future tool can consume the ontology
 *      without re-deriving these relationships from source.
 *   2. Adapter functions that turn each system's existing shape into a
 *      CanonicalFashionAttributesV1 record, so the mapping is testable and
 *      not just documentation. Every adapter is pure and read-only — none
 *      of them import, call, or modify the systems they adapt from, so this
 *      package has zero coupling to FMQ/Corpus/CPI/Scanner/Closet code and
 *      makes zero runtime calls of any kind.
 *
 * Source citations (as inspected on the Build 35 authority, commit
 * d284bfc61fd61de5a311597f22b14b8b4f52da69):
 *   - Scanner: supabase/functions/_shared/fashionIdentificationV2.ts,
 *     contracts/fashion-identification-v2.schema.json
 *   - Closet (committed item): services/closetLibrary.js
 *     (CLOSET_ITEM_TAXONOMY_FIELDS), services/closetCandidatePromotion.js
 *   - Closet (owned-item read projection, a separate unrelated store):
 *     types/ownedClosetItem.ts
 *   - Fashion Match Quality: tools/fashion-match-quality/fixtures/,
 *     tools/fashion-match-quality/evaluator/rubric.js
 *   - Real Fashion Corpus: tools/real-fashion-corpus/lib/constants.js,
 *     tools/real-fashion-corpus/lib/intake.js,
 *     tools/real-fashion-corpus/lib/compile.js
 *   - Canonical Product Identity:
 *     tools/canonical-product-identity/schema/identitySchema.js,
 *     tools/canonical-product-identity/resolver/normalizeOffer.js
 */

const {
  canonicalizeCategory,
  canonicalizeSubtype,
  canonicalizeColor,
  canonicalizeSilhouette,
  canonicalizeMaterial,
  canonicalizePattern,
  impliedCategoryFromSubtype,
} = require('./canonicalize');
const { CONTRACT_VERSION, createUnknownAttributeValue } = require('./schema');

const CLASSIFICATIONS = Object.freeze({
  DIRECT: 'DIRECT',
  ALIAS: 'ALIAS',
  TRANSFORM: 'TRANSFORM',
  NOT_REPRESENTED: 'NOT_CURRENTLY_REPRESENTED',
});

/**
 * field -> system -> { classification, sourceField, notes }.
 * Systems: fashionMatchQuality, realFashionCorpus, canonicalProductIdentity,
 * scanner, closetCommittedItem, closetOwnedItem (a separate, unrelated
 * Closet-named store — see types/ownedClosetItem.ts).
 */
const CONTRACT_FIELD_COMPATIBILITY = Object.freeze({
  category: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'category | garmentIdentification.item_type', notes: 'Same concept, direct rename.' },
    realFashionCorpus: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'category (closed 7-value enum)', notes: "6 of 7 enum values are DIRECT; 'pants' renames to canonical 'bottom' with 'pants' becoming the implied subtype (a canonical category has to cover skirts/shorts too)." },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'offer.category', notes: "Corpus-generated offers use subtype-grained values ('jacket', 'boot', 'sweater'); resolved via subtype-implies-category when the raw value is not itself a category word." },
    scanner: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.category', notes: 'Free-text string, same concept.' },
    closetCommittedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'record.category', notes: null },
    closetOwnedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.category', notes: 'types/ownedClosetItem.ts — a different, unrelated read projection over saved_scans/inspiration_items, not services/closetLibrary.js.' },
  },
  subtype: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: 'No subtype field anywhere in FMQ (fixtures, schema, or rubric).' },
    realFashionCorpus: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: 'category is the only classification level; no subtype field exists.' },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: 'Closest concept is generator-only styleNames, which are never exposed to the resolver and live only in offer.title text.' },
    scanner: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.subtype', notes: null },
    closetCommittedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'record.subtype', notes: "Closet also has a middle-granularity 'clothingType' field (e.g. 'Jacket') with no equivalent in this V1 ontology — NOT_CURRENTLY_REPRESENTED on our side, left for a future workstream." },
    closetOwnedItem: { classification: CLASSIFICATIONS.ALIAS, sourceField: 'item.subcategory', notes: 'Same concept, different field name.' },
  },
  primaryColor: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.ALIAS, sourceField: 'color_family | primary_color', notes: "Naming collision: FMQ's 'color_family' is single-valued and carries what this ontology calls the canonical color NAME (e.g. 'navy'), not our broader family concept." },
    realFashionCorpus: { classification: CLASSIFICATIONS.ALIAS, sourceField: 'attributes.colorFamily', notes: 'Same naming collision as FMQ (this field compiles directly into FMQ fixtures).' },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.ALIAS, sourceField: 'offer.color', notes: null },
    scanner: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.colors.primary', notes: null },
    closetCommittedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'record.primaryColor', notes: null },
    closetOwnedItem: { classification: CLASSIFICATIONS.ALIAS, sourceField: 'item.color', notes: 'Singular, no primary/secondary split on this type.' },
  },
  secondaryColor: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: null },
    realFashionCorpus: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: 'groundTruth.identity.variant.colorwayName/Code is a manufacturer colorway identity, a different concept from a second color descriptor — not treated as an alias.' },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: null },
    scanner: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'item.colors.secondary[]', notes: 'Array of strings; this ontology resolves the first alias-recognized entry to one canonical value.' },
    closetCommittedItem: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'record.secondaryColors[]', notes: 'Same array-to-singular transform as Scanner.' },
    closetOwnedItem: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: null },
  },
  silhouette: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'silhouette', notes: null },
    realFashionCorpus: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'attributes.silhouette', notes: null },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'offer.silhouette', notes: null },
    scanner: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'item.silhouette[]', notes: 'Array of strings; resolved to one canonical value.' },
    closetCommittedItem: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: 'Confirmed dropped at the candidate-to-committed projection boundary (services/closetIdentificationV2.ts normalizeClosetClassification) — no silhouette field exists in the committed schema at all.' },
    closetOwnedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.silhouette', notes: null },
  },
  material: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'material | materialEstimate | material_tags[]', notes: null },
    realFashionCorpus: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'attributes.material', notes: null },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'offer.material', notes: null },
    scanner: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'item.material[]', notes: 'Array of strings; resolved to one canonical value.' },
    closetCommittedItem: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'record.material[]', notes: 'Same array-to-singular transform.' },
    closetOwnedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.material', notes: null },
  },
  pattern: {
    fashionMatchQuality: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'pattern', notes: "Present directly on fixture ground truth and candidateProducts. The corpus-compiled garmentIdentification.* shape is a separate, lossier projection (see realFashionCorpus row) — this ontology's FMQ adapter reads the fixture-level field, not that projection." },
    realFashionCorpus: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'attributes.pattern', notes: "DIRECT at the garment-record level (attr_pattern intake column). Pre-existing, out-of-scope observation: Real Corpus's own compile.js folds this into garmentIdentification.distinctive_features rather than a dedicated key when building FMQL fixtures — a lossy step internal to that lab, not something this ontology causes or is responsible for fixing." },
    canonicalProductIdentity: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'offer.pattern', notes: null },
    scanner: { classification: CLASSIFICATIONS.TRANSFORM, sourceField: 'item.pattern[]', notes: 'Array of strings; resolved to one canonical value.' },
    closetCommittedItem: { classification: CLASSIFICATIONS.NOT_REPRESENTED, sourceField: null, notes: 'Confirmed dropped at the same projection boundary as silhouette.' },
    closetOwnedItem: { classification: CLASSIFICATIONS.DIRECT, sourceField: 'item.pattern', notes: null },
  },
});

/**
 * Resolves category + subtype together for a source whose "category" field
 * is sometimes actually subtype-grained (CPI's corpus offers, Real Corpus's
 * 'pants'). Tries the value as a category word first; if that fails, tries
 * it as a subtype and lets the subtype imply its parent category. An
 * explicit subtype field, when the source has one, always wins over the
 * implied one.
 */
function resolveCategoryAndSubtype(rawCategoryLike, rawSubtype) {
  let category = canonicalizeCategory(rawCategoryLike);
  let subtype = rawSubtype !== undefined ? canonicalizeSubtype(rawSubtype) : createUnknownAttributeValue();

  if (category.value === null) {
    const impliedSubtype = canonicalizeSubtype(rawCategoryLike);
    if (impliedSubtype.value !== null) {
      category = { value: impliedCategoryFromSubtype(impliedSubtype.value), raw: category.raw };
      if (subtype.value === null) subtype = impliedSubtype;
    }
  }
  return { category, subtype };
}

function record({ category, subtype, primaryColor, secondaryColor, silhouette, material, pattern }) {
  return {
    contractVersion: CONTRACT_VERSION,
    category,
    subtype,
    primaryColor,
    secondaryColor,
    silhouette,
    material,
    pattern,
  };
}

/** Scanner: FashionIdentificationResultV2['item'] (supabase/functions/_shared/fashionIdentificationV2.ts). */
function fromScannerResultItem(item) {
  const source = item && typeof item === 'object' ? item : {};
  const colors = source.colors && typeof source.colors === 'object' ? source.colors : {};
  return record({
    category: canonicalizeCategory(source.category),
    subtype: canonicalizeSubtype(source.subtype),
    primaryColor: canonicalizeColor(colors.primary),
    secondaryColor: canonicalizeColor(colors.secondary),
    silhouette: canonicalizeSilhouette(source.silhouette),
    material: canonicalizeMaterial(source.material),
    pattern: canonicalizePattern(source.pattern),
  });
}

/** Closet committed item taxonomy (services/closetLibrary.js CLOSET_ITEM_TAXONOMY_FIELDS). */
function fromClosetCommittedItem(closetItem) {
  const source = closetItem && typeof closetItem === 'object' ? closetItem : {};
  return record({
    category: canonicalizeCategory(source.category),
    subtype: canonicalizeSubtype(source.subtype),
    primaryColor: canonicalizeColor(source.primaryColor),
    secondaryColor: canonicalizeColor(source.secondaryColors),
    // Not represented in the committed Closet schema at all.
    silhouette: createUnknownAttributeValue(),
    material: canonicalizeMaterial(source.material),
    pattern: createUnknownAttributeValue(),
  });
}

/** The separate, unrelated Closet-named read projection (types/ownedClosetItem.ts). */
function fromClosetOwnedItem(ownedItem) {
  const source = ownedItem && typeof ownedItem === 'object' ? ownedItem : {};
  return record({
    category: canonicalizeCategory(source.category),
    subtype: canonicalizeSubtype(source.subcategory),
    primaryColor: canonicalizeColor(source.color),
    secondaryColor: createUnknownAttributeValue(),
    silhouette: canonicalizeSilhouette(source.silhouette),
    material: canonicalizeMaterial(source.material),
    pattern: canonicalizePattern(source.pattern),
  });
}

/**
 * Fashion Match Quality — accepts either a fixture's `groundTruth`/
 * `candidateProducts[n]` shape ({ category, color_family, material,
 * silhouette, pattern }) or the production-input-shaped
 * `garmentIdentification` shape ({ item_type, primary_color,
 * material_estimate, silhouette }). Both are read leniently; whichever keys
 * are present win.
 */
function fromFmqAttributes(attrs) {
  const source = attrs && typeof attrs === 'object' ? attrs : {};
  const { category, subtype } = resolveCategoryAndSubtype(
    source.category !== undefined ? source.category : source.item_type,
    source.subtype,
  );
  return record({
    category,
    subtype,
    primaryColor: canonicalizeColor(source.color_family !== undefined ? source.color_family : source.primary_color),
    secondaryColor: createUnknownAttributeValue(),
    silhouette: canonicalizeSilhouette(source.silhouette),
    material: canonicalizeMaterial(source.material !== undefined ? source.material : source.material_estimate),
    pattern: canonicalizePattern(source.pattern),
  });
}

/** Canonical Product Identity: RetailOffer (schema/identitySchema.js OFFER_SIGNAL_FIELDS). */
function fromCpiOffer(offer) {
  const source = offer && typeof offer === 'object' ? offer : {};
  const { category, subtype } = resolveCategoryAndSubtype(source.category, undefined);
  return record({
    category,
    subtype,
    primaryColor: canonicalizeColor(source.color),
    secondaryColor: createUnknownAttributeValue(),
    silhouette: canonicalizeSilhouette(source.silhouette),
    material: canonicalizeMaterial(source.material),
    pattern: canonicalizePattern(source.pattern),
  });
}

/** Real Fashion Corpus: garment record (lib/constants.js CATEGORIES, lib/intake.js attributes.*). */
function fromRealCorpusGarment(garment) {
  const source = garment && typeof garment === 'object' ? garment : {};
  const attributes = source.attributes && typeof source.attributes === 'object' ? source.attributes : {};
  const { category, subtype } = resolveCategoryAndSubtype(source.category, undefined);
  return record({
    category,
    subtype,
    primaryColor: canonicalizeColor(attributes.colorFamily),
    secondaryColor: createUnknownAttributeValue(),
    silhouette: canonicalizeSilhouette(attributes.silhouette),
    material: canonicalizeMaterial(attributes.material),
    pattern: canonicalizePattern(attributes.pattern),
  });
}

module.exports = {
  CLASSIFICATIONS,
  CONTRACT_FIELD_COMPATIBILITY,
  resolveCategoryAndSubtype,
  fromScannerResultItem,
  fromClosetCommittedItem,
  fromClosetOwnedItem,
  fromFmqAttributes,
  fromCpiOffer,
  fromRealCorpusGarment,
};
