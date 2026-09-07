'use strict';

/**
 * Deterministic fashion vocabulary the corpus generator draws from. Values
 * are illustrative, not references to any specific real retailer catalog -
 * this lab uses only synthetic/fixture data (spec section 41).
 */

// Deliberately wide (30, not a dozen) - a narrow brand list caused frequent
// ACCIDENTAL cross-case-instance collisions on (brand, styleName, category)
// during corpus construction (68/146 distinct keys were reused by more than
// one generator-assigned styleId in an earlier build), which muddies the
// style-cluster-purity metric with corpus noise unrelated to resolver
// behavior. Widening the vocabulary is a pure data change with zero effect
// on any case generator's logic or intended semantics.
const BRANDS = [
  'Aritzia', 'Reformation', 'Vince', 'Theory', 'Frame', 'Ganni', 'AllSaints',
  'Sandro', 'Maje', 'Rag & Bone', 'Veronica Beard', 'Nili Lotan',
  'Toteme', 'Staud', 'Jonathan Simkhai', 'A.L.C.', 'Proenza Schouler',
  'The Row', 'Khaite', 'Isabel Marant', 'Ulla Johnson', 'Zimmermann',
  'Faithfull the Brand', 'Anine Bing', 'Joie', 'Equipment', 'Iro',
  'Acne Studios', 'Ba&sh', 'Free People',
];

const RETAILERS = [
  'Nordstrom', 'Revolve', 'Shopbop', 'Bloomingdales', 'Saks Fifth Avenue',
  'Net-a-Porter', 'FarFetch', 'Neiman Marcus', 'Zappos', 'ASOS',
];

const MARKETPLACE_RETAILERS = ['Poshmark', 'TheRealReal', 'Vestiaire Collective', 'eBay'];
const OUTLET_RETAILERS = ['Nordstrom Rack', 'Saks Off 5th'];

// styleNames widened per category (was 3-4, now 9-10) for the same collision
// reason as BRANDS above - each list still stays within one garment
// category's real vocabulary, so category-conflict test cases are unaffected.
const CATEGORY_STYLES = {
  jacket: {
    category: 'jacket',
    styleNames: [
      'Cropped Moto Jacket', 'Oversized Bomber Jacket', 'Double-Breasted Blazer', 'Quilted Puffer Jacket',
      'Belted Trench Coat', 'Shearling-Collar Aviator Jacket', 'Cropped Denim Jacket', 'Longline Wool Coat',
      'Utility Field Jacket', 'Cropped Tweed Jacket',
    ],
    colors: ['black', 'brown', 'olive', 'camel', 'navy'],
    materials: ['lambskin', 'suede', 'wool', 'cotton twill', 'nylon'],
    patterns: ['solid', 'houndstooth', 'pinstripe'],
    silhouettes: ['cropped', 'oversized', 'fitted', 'boxy'],
  },
  dress: {
    category: 'dress',
    styleNames: [
      'Wrap Midi Dress', 'Slip Maxi Dress', 'Ribbed Mini Dress', 'Pleated Shirt Dress',
      'Asymmetric Cutout Dress', 'Puff-Sleeve Tiered Dress', 'Halter Column Gown', 'Off-Shoulder Midi Dress',
      'Smocked Tank Dress', 'Cowl-Neck Slip Dress',
    ],
    colors: ['black', 'ivory', 'emerald', 'burgundy', 'sand'],
    materials: ['silk', 'ribbed knit', 'satin', 'linen'],
    patterns: ['solid', 'floral', 'polka dot'],
    silhouettes: ['wrap', 'a-line', 'bodycon', 'asymmetric'],
  },
  boot: {
    category: 'boot',
    styleNames: [
      'Pebbled Leather Ankle Boot', 'Suede Knee-High Boot', 'Patent Chelsea Boot',
      'Shearling-Lined Combat Boot', 'Block-Heel Western Boot', 'Slouchy Over-the-Knee Boot',
      'Lug-Sole Lace-Up Boot', 'Pointed-Toe Stiletto Boot', 'Woven Espadrille Boot',
    ],
    colors: ['black', 'brown', 'taupe', 'bone'],
    materials: ['pebbled leather', 'suede', 'patent leather'],
    patterns: ['solid'],
    silhouettes: ['ankle', 'knee-high', 'chelsea'],
  },
  sweater: {
    category: 'sweater',
    styleNames: [
      'Ribbed Turtleneck Sweater', 'Oversized Cable Knit Sweater', 'Embroidered Crewneck Sweater',
      'Fair Isle Crewneck Sweater', 'Cropped Mock-Neck Sweater', 'V-Neck Vest Sweater',
      'Chunky Shawl-Collar Cardigan', 'Striped Boatneck Sweater', 'Cowl-Neck Tunic Sweater',
    ],
    colors: ['cream', 'charcoal', 'forest green', 'rust'],
    materials: ['cashmere', 'merino wool', 'cotton blend'],
    patterns: ['solid', 'cable knit', 'embroidered'],
    silhouettes: ['fitted', 'oversized', 'cropped'],
  },
};

const CATEGORY_KEYS = Object.keys(CATEGORY_STYLES);

const CURRENCIES = ['USD'];

const SEASONS = ['SS24', 'FW24', 'SS25', 'FW25'];

const TRACKING_SUFFIXES = [
  '?utm_source=email&utm_medium=newsletter&utm_campaign=fall',
  '?ref=homepage_carousel',
  '?gclid=abc123XYZ',
  '/',
];

module.exports = {
  BRANDS,
  RETAILERS,
  MARKETPLACE_RETAILERS,
  OUTLET_RETAILERS,
  CATEGORY_STYLES,
  CATEGORY_KEYS,
  CURRENCIES,
  SEASONS,
  TRACKING_SUFFIXES,
};
