'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  CLASSIFICATIONS,
  CONTRACT_FIELD_COMPATIBILITY,
  fromScannerResultItem,
  fromClosetCommittedItem,
  fromClosetOwnedItem,
  fromFmqAttributes,
  fromCpiOffer,
  fromRealCorpusGarment,
} = require('../compatibility');
const { validateCanonicalFashionAttributes } = require('../schema');
const { ALL_FIELDS } = require('../schema');

const SYSTEMS = [
  'fashionMatchQuality',
  'realFashionCorpus',
  'canonicalProductIdentity',
  'scanner',
  'closetCommittedItem',
  'closetOwnedItem',
];

// ── Matrix completeness ────────────────────────────────────────────────────

test('every one of the seven fields has a classification entry for every system', () => {
  for (const field of ALL_FIELDS) {
    assert.ok(CONTRACT_FIELD_COMPATIBILITY[field], `no matrix entry for field ${field}`);
    for (const system of SYSTEMS) {
      const entry = CONTRACT_FIELD_COMPATIBILITY[field][system];
      assert.ok(entry, `no matrix entry for ${field}/${system}`);
      assert.ok(Object.values(CLASSIFICATIONS).includes(entry.classification), `${field}/${system} has an invalid classification`);
    }
  }
});

test('a NOT_CURRENTLY_REPRESENTED entry never claims a source field', () => {
  for (const field of ALL_FIELDS) {
    for (const system of SYSTEMS) {
      const entry = CONTRACT_FIELD_COMPATIBILITY[field][system];
      if (entry.classification === CLASSIFICATIONS.NOT_REPRESENTED) {
        assert.equal(entry.sourceField, null, `${field}/${system} is NOT_CURRENTLY_REPRESENTED but names a source field`);
      }
    }
  }
});

// ── Scanner adapter — real fashion-identification-v2 item shape ───────────
// (supabase/functions/_shared/fashionIdentificationV2.ts item shape, as
// exercised by __tests__/fashionIdentificationV2Contract.test.js)

test('Scanner adapter: a fully resolved item maps every field', () => {
  const record = fromScannerResultItem({
    category: 'outerwear',
    subtype: 'flight jacket',
    colors: { primary: 'grey', secondary: ['unrecognized-shade', 'oxblood'] },
    material: ['unobtainium', 'lambskin'],
    silhouette: ['cropped'],
    pattern: ['solid'],
  });
  assert.equal(validateCanonicalFashionAttributes(record).valid, true);
  assert.equal(record.category.value, 'outerwear');
  assert.equal(record.subtype.value, 'bomber_jacket');
  assert.equal(record.primaryColor.value, 'grey');
  assert.equal(record.secondaryColor.value, 'burgundy');
  assert.equal(record.material.value, 'leather');
  assert.equal(record.silhouette.value, 'cropped');
  assert.equal(record.pattern.value, 'solid');
});

test('Scanner adapter: a category-only partial result leaves the rest explicitly unknown', () => {
  const record = fromScannerResultItem({ category: 'dress', subtype: null, colors: { primary: null, secondary: [] } });
  assert.equal(record.category.value, 'dress');
  assert.equal(record.subtype.value, null);
  assert.equal(record.primaryColor.value, null);
  assert.equal(record.secondaryColor.value, null);
});

test('Scanner adapter tolerates a malformed item without throwing', () => {
  for (const bad of [null, undefined, 'nope', 42]) {
    assert.doesNotThrow(() => fromScannerResultItem(bad));
  }
});

// ── Closet committed-item adapter — real CLOSET_ITEM_TAXONOMY_FIELDS shape ─
// (services/closetLibrary.js, as exercised by
// __tests__/closetTaxonomyPreservation.test.js FULL_TAXONOMY fixture)

test('Closet committed-item adapter: silhouette and pattern are NOT_CURRENTLY_REPRESENTED, matching the real schema gap', () => {
  const record = fromClosetCommittedItem({
    category: 'Outerwear',
    clothingType: 'Jacket',
    subtype: 'Bomber',
    brand: 'Acme',
    primaryColor: 'Black',
    secondaryColors: ['Grey', 'White'],
    material: ['Wool', 'Nylon'],
    size: 'M',
  });
  assert.equal(record.category.value, 'outerwear');
  assert.equal(record.subtype.value, 'bomber_jacket');
  assert.equal(record.primaryColor.value, 'black');
  assert.equal(record.secondaryColor.value, 'grey');
  assert.equal(record.material.value, 'wool');
  // Confirmed absent in the real committed schema — never guessed here either.
  assert.equal(record.silhouette.value, null);
  assert.equal(record.pattern.value, null);
});

test('Closet committed-item adapter: an absent-taxonomy record (category only) stays mostly unknown', () => {
  const record = fromClosetCommittedItem({ category: 'Shoes' });
  assert.equal(record.category.value, 'footwear'); // "Shoes" is a recognized alias for K Scan's canonical "footwear".
  assert.equal(record.subtype.value, null);
  assert.equal(record.primaryColor.value, null);
  assert.equal(record.material.value, null);
});

test('Closet committed-item adapter: a genuinely unrecognized category stays unknown', () => {
  const record = fromClosetCommittedItem({ category: 'Loungewear' });
  assert.equal(record.category.value, null);
  assert.equal(record.category.raw, 'loungewear');
});

// ── Closet OwnedClosetItem adapter — the separate, unrelated read type ────

test('OwnedClosetItem adapter: subcategory aliases to subtype, single color maps to primaryColor only', () => {
  const record = fromClosetOwnedItem({
    category: 'footwear',
    subcategory: 'boot',
    color: 'tan',
    pattern: 'solid',
    material: 'suede',
    silhouette: 'boxy',
  });
  assert.equal(record.category.value, 'footwear');
  assert.equal(record.subtype.value, 'boot');
  assert.equal(record.primaryColor.value, 'tan');
  assert.equal(record.secondaryColor.value, null);
  assert.equal(record.material.value, 'suede');
  assert.equal(record.silhouette.value, 'boxy');
  assert.equal(record.pattern.value, 'solid');
});

// ── FMQ adapter — real fixture ground-truth / garmentIdentification shapes ─
// (tools/fashion-match-quality/fixtures/synthetic/*.json field names)

test('FMQ adapter: fixture ground-truth shape resolves category, color_family naming collision, and pattern', () => {
  const record = fromFmqAttributes({
    category: 'dress',
    color_family: 'navy',
    material: 'cotton twill',
    silhouette: 'a-line',
    pattern: 'floral',
  });
  assert.equal(record.category.value, 'dress');
  assert.equal(record.primaryColor.value, 'navy');
  assert.equal(record.primaryColor.family, 'blue');
  assert.equal(record.material.value, 'cotton');
  assert.equal(record.silhouette.value, 'a_line');
  assert.equal(record.pattern.value, 'floral');
});

test('FMQ adapter: garmentIdentification shape (item_type/primary_color/material_estimate) resolves the same way', () => {
  const record = fromFmqAttributes({
    item_type: 'jacket',
    primary_color: 'camel',
    material_estimate: 'suede',
    silhouette: 'oversized',
  });
  // "jacket" is subtype-grained in FMQ/CPI corpora — resolved via subtype-implies-category.
  assert.equal(record.category.value, 'outerwear');
  assert.equal(record.subtype.value, 'jacket');
  assert.equal(record.primaryColor.value, 'camel');
  assert.equal(record.material.value, 'suede');
});

// ── CPI adapter — real RetailOffer field names ─────────────────────────────
// (tools/canonical-product-identity/schema/identitySchema.js OFFER_SIGNAL_FIELDS)

test('CPI adapter: a coarse category offer resolves directly', () => {
  const record = fromCpiOffer({ category: 'dress', color: 'burgundy', material: 'silk', pattern: 'floral', silhouette: 'bodycon' });
  assert.equal(record.category.value, 'dress');
  assert.equal(record.primaryColor.value, 'burgundy');
  assert.equal(record.material.value, 'silk');
  assert.equal(record.pattern.value, 'floral');
  assert.equal(record.silhouette.value, 'bodycon');
});

test('CPI adapter: subtype-grained corpus categories (boot, sweater) imply their parent category', () => {
  assert.equal(fromCpiOffer({ category: 'boot' }).category.value, 'footwear');
  assert.equal(fromCpiOffer({ category: 'boot' }).subtype.value, 'boot');
  assert.equal(fromCpiOffer({ category: 'sweater' }).category.value, 'top');
  assert.equal(fromCpiOffer({ category: 'sweater' }).subtype.value, 'sweater');
});

// ── Real Fashion Corpus adapter — real closed-enum category + attributes.* ─
// (tools/real-fashion-corpus/lib/constants.js CATEGORIES, lib/intake.js)

test("Real Corpus adapter: the corpus's own six non-pants categories map directly", () => {
  for (const category of ['top', 'dress', 'outerwear', 'footwear', 'bag', 'accessory']) {
    assert.equal(fromRealCorpusGarment({ category }).category.value, category);
  }
});

test("Real Corpus adapter: 'pants' renames to canonical 'bottom' with 'pants' as the implied subtype", () => {
  const record = fromRealCorpusGarment({ category: 'pants' });
  assert.equal(record.category.value, 'bottom');
  assert.equal(record.subtype.value, 'trouser');
});

test('Real Corpus adapter: attributes.* maps silhouette/material/pattern/colorFamily', () => {
  const record = fromRealCorpusGarment({
    category: 'top',
    attributes: { silhouette: 'fitted', material: 'wool', pattern: 'stripe', colorFamily: 'beige' },
  });
  assert.equal(record.silhouette.value, 'fitted');
  assert.equal(record.material.value, 'wool');
  assert.equal(record.pattern.value, 'stripe');
  assert.equal(record.primaryColor.value, 'beige');
});

test('Real Corpus adapter: an omitted attributes object (UNKNOWN as a first-class answer) never throws', () => {
  assert.doesNotThrow(() => fromRealCorpusGarment({ category: 'top' }));
  const record = fromRealCorpusGarment({ category: 'top' });
  assert.equal(record.material.value, null);
});
