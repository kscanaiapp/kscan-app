'use strict';

/**
 * Synthetic commerce catalog — spec sections 21/24.
 *
 * Built only because source proves external-product recommendation is a real
 * capability of the shared Elise/Concierge pipeline (EliseWardrobeSourceType
 * includes 'commerce_product'; EliseActorRelationship includes 'discovered'
 * — see authority/conciergeSourceMap.json commerceCapability). This catalog
 * is DETERMINISTIC and SYNTHETIC: no retailer is called, no real product
 * data is used, and synthetic availability/price/stock must never be
 * reported as real (see model constraints in synthesis/responseSynthesizer.js
 * and README "what metrics do/don't mean").
 *
 * Deterministic: same CATALOG_SEED always produces the same catalog, so it
 * participates safely in the corpus hash (spec section 52).
 */

const { SeededRandom } = require('../model/seededRandom');

const CATALOG_VERSION = 'COMMERCE_CATALOG_V1';
const CATALOG_SEED = 'elise-concierge-eval:commerce-catalog:v1';
const CATALOG_SIZE = 60; // bounded well under the 100-item cap (spec section 21)

const CATEGORIES = [
  { category: 'shoes', subcategories: ['boot', 'loafer', 'sneaker', 'oxford', 'heel', 'sandal'] },
  { category: 'outerwear', subcategories: ['blazer', 'coat', 'jacket', 'bomber'] },
  { category: 'tops', subcategories: ['shirt', 't-shirt', 'sweater', 'blouse'] },
  { category: 'bottoms', subcategories: ['trouser', 'jeans', 'chino', 'short'] },
  { category: 'accessories', subcategories: ['belt', 'scarf', 'bag', 'watch'] },
  { category: 'dresses', subcategories: ['dress'] },
];

const BRANDS = [
  'Ashfield & Co', 'Kestrel Supply', 'Marlowe Studio', 'Northbound', 'Verdant Row',
  'Halden Atelier', 'Corriedale', 'Fenwick Trade', 'Solace Basics', 'Ridgeline',
];

const COLORS = ['black', 'white', 'grey', 'navy', 'brown', 'olive', 'burgundy', 'camel', 'blue', 'red'];
const MATERIALS = ['leather', 'suede', 'cotton', 'wool', 'linen', 'denim', 'canvas', 'silk'];
const SIZES = ['XS', 'S', 'M', 'L', 'XL'];

function buildProduct(rng, index) {
  const group = rng.pick(CATEGORIES);
  const subcategory = rng.pick(group.subcategories);
  const brand = rng.pick(BRANDS);
  const color = rng.pick(COLORS);
  const material = rng.pick(MATERIALS);
  const priceBase = rng.int(20, 480);
  const price = Math.round(priceBase / 5) * 5 - 0.01 > 0 ? Math.round(priceBase / 5) * 5 - 0.01 : 19.99;
  const stock = rng.int(0, 50);
  const sizesAvailable = stock === 0 ? [] : rng.pickN(SIZES, rng.int(1, SIZES.length));

  return {
    id: `prod_synth_${String(index + 1).padStart(4, '0')}`,
    category: group.category,
    subcategory,
    brand,
    color,
    colorFamilies: [color === 'burgundy' || color === 'red' ? 'red' : color === 'camel' || color === 'brown' ? 'brown' : color === 'olive' ? 'green' : color === 'navy' || color === 'blue' ? 'blue' : 'neutral'],
    material,
    price: Number(price.toFixed(2)),
    stock,
    sizesAvailable,
    title: `${brand} ${color[0].toUpperCase()}${color.slice(1)} ${subcategory}`,
  };
}

/**
 * A small set of HAND-PINNED anchor products with fixed ids, referenced
 * directly by scenario fixtures (e.g. scn_recommend_purchase ->
 * prod_boots_0001), so a scenario's ground truth never depends on generator
 * iteration order.
 */
const ANCHOR_PRODUCTS = [
  {
    id: 'prod_boots_0001',
    category: 'shoes',
    subcategory: 'boot',
    brand: 'Ridgeline',
    color: 'brown',
    colorFamilies: ['brown'],
    material: 'leather',
    price: 138.0,
    stock: 12,
    sizesAvailable: ['S', 'M', 'L'],
    title: 'Ridgeline Brown Leather Boot',
  },
  {
    id: 'prod_heels_0001',
    category: 'shoes',
    subcategory: 'heel',
    brand: 'Halden Atelier',
    color: 'black',
    colorFamilies: ['neutral'],
    material: 'leather',
    price: 165.0,
    stock: 8,
    sizesAvailable: ['S', 'M'],
    title: 'Halden Atelier Black Leather Heel',
  },
];

function buildCommerceCatalog() {
  const rng = new SeededRandom(CATALOG_SEED);
  const anchorIds = new Set(ANCHOR_PRODUCTS.map((p) => p.id));
  const generated = [];
  let index = 0;
  while (generated.length < CATALOG_SIZE - ANCHOR_PRODUCTS.length) {
    const product = buildProduct(rng, index);
    index += 1;
    if (anchorIds.has(product.id)) continue; // never collide with a pinned id
    generated.push(product);
  }
  return {
    catalogVersion: CATALOG_VERSION,
    seed: CATALOG_SEED,
    products: [...ANCHOR_PRODUCTS, ...generated],
  };
}

module.exports = { CATALOG_VERSION, CATALOG_SEED, CATALOG_SIZE, buildCommerceCatalog };
