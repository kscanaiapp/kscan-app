'use strict';

/**
 * Deterministic fashion vocabulary the corpus generator draws from. Values
 * are illustrative, not references to any specific real retailer catalog -
 * this lab uses only synthetic/fixture data (spec section 41).
 */

const BRANDS = [
  'Aritzia', 'Reformation', 'Vince', 'Theory', 'Frame', 'Ganni', 'AllSaints',
  'Sandro', 'Maje', 'Rag & Bone', 'Veronica Beard', 'Nili Lotan',
];

const RETAILERS = [
  'Nordstrom', 'Revolve', 'Shopbop', 'Bloomingdales', 'Saks Fifth Avenue',
  'Net-a-Porter', 'FarFetch', 'Neiman Marcus', 'Zappos', 'ASOS',
];

const MARKETPLACE_RETAILERS = ['Poshmark', 'TheRealReal', 'Vestiaire Collective', 'eBay'];
const OUTLET_RETAILERS = ['Nordstrom Rack', 'Saks Off 5th'];

const CATEGORY_STYLES = {
  jacket: {
    category: 'jacket',
    styleNames: ['Cropped Moto Jacket', 'Oversized Bomber Jacket', 'Double-Breasted Blazer', 'Quilted Puffer Jacket'],
    colors: ['black', 'brown', 'olive', 'camel', 'navy'],
    materials: ['lambskin', 'suede', 'wool', 'cotton twill', 'nylon'],
    patterns: ['solid', 'houndstooth', 'pinstripe'],
    silhouettes: ['cropped', 'oversized', 'fitted', 'boxy'],
  },
  dress: {
    category: 'dress',
    styleNames: ['Wrap Midi Dress', 'Slip Maxi Dress', 'Ribbed Mini Dress', 'Pleated Shirt Dress'],
    colors: ['black', 'ivory', 'emerald', 'burgundy', 'sand'],
    materials: ['silk', 'ribbed knit', 'satin', 'linen'],
    patterns: ['solid', 'floral', 'polka dot'],
    silhouettes: ['wrap', 'a-line', 'bodycon', 'asymmetric'],
  },
  boot: {
    category: 'boot',
    styleNames: ['Pebbled Leather Ankle Boot', 'Suede Knee-High Boot', 'Patent Chelsea Boot'],
    colors: ['black', 'brown', 'taupe', 'bone'],
    materials: ['pebbled leather', 'suede', 'patent leather'],
    patterns: ['solid'],
    silhouettes: ['ankle', 'knee-high', 'chelsea'],
  },
  sweater: {
    category: 'sweater',
    styleNames: ['Ribbed Turtleneck Sweater', 'Oversized Cable Knit Sweater', 'Embroidered Crewneck Sweater'],
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
