const express = require('express');
const cors = require('cors');
const {
  secretsMatch,
  validateWaitlistWelcomeRequest,
  validateAccountDeletionRestorationRequest,
  sendWaitlistWelcomeEmail,
  sendAccountDeletionRestorationEmail,
} = require('./services/transactionalEmail');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3001;
const CATALOG_IMAGE_BASE_URL =
  process.env.CATALOG_IMAGE_BASE_URL || 'https://kscan-app-1.onrender.com';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'meta-llama/llama-4-scout';
const USE_OPENROUTER =
  process.env.USE_OPENROUTER === 'true' && !!OPENROUTER_API_KEY;
const ALLOW_DEV_FALLBACK = process.env.ALLOW_DEV_FALLBACK === 'true';
// Gate verbose per-request logs (body details, raw AI text) behind this flag.
// Set KSCAN_DEBUG=true in .env for local debugging; leave unset in production.
const DEBUG = process.env.KSCAN_DEBUG === 'true';
const DEV_PROVIDER_LOGS = process.env.NODE_ENV !== 'production';

// Render injects RENDER_GIT_COMMIT automatically. Falls back to GIT_COMMIT
// (manual CI env) or a placeholder so the header is always a non-empty string.
const DEPLOYED_COMMIT = (
  process.env.RENDER_GIT_COMMIT ||
  process.env.GIT_COMMIT        ||
  '(commit-unavailable)'
).slice(0, 12); // 12-char short hash is sufficient for convergence checks

// Secure validation handshake: in production, diagnostic response headers are
// emitted ONLY when the incoming request carries a valid X-KScan-Validation-Auth
// header that matches the VALIDATION_SECRET_KEY env var exactly.
// In non-production, diagnostics are emitted unconditionally.
// The secret is NEVER reflected back into responses or logged.
function isValidationRequest(req) {
  const secret = process.env.VALIDATION_SECRET_KEY;
  if (!secret) return false;
  const provided = req.headers['x-kscan-validation-auth'];
  return typeof provided === 'string' && provided === secret;
}

function shouldEmitDiagnostics(req) {
  return process.env.NODE_ENV !== 'production' || isValidationRequest(req);
}

console.log('[K-SCAN] Startup config:');
console.log('[K-SCAN]   has GEMINI_API_KEY    :', !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 0);
console.log('[K-SCAN]   has OPENROUTER_API_KEY:', !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 0);
console.log('[K-SCAN]   USE_OPENROUTER        :', process.env.USE_OPENROUTER);
console.log('[K-SCAN]   OPENROUTER_MODEL      :', OPENROUTER_MODEL);
console.log('[K-SCAN]   ALLOW_DEV_FALLBACK    :', process.env.ALLOW_DEV_FALLBACK ?? 'unset');

const DEV_FALLBACK = {
  result: '[DEV FALLBACK] Gemini unavailable. This is a stub response for UI testing.',
  metadata: {
    category: 'Streetwear',
    color: 'Monochrome',
    silhouette: 'Oversized',
  },
  products: [],
};

// ─── Product catalog ─────────────────────────────────────────────────────────
function loadCatalog() {
  try {
    const catalog = require('./data/catalog.json');
    if (!Array.isArray(catalog)) {
      console.warn('[K-SCAN MATCH] catalog.json is not an array; product matching disabled');
      return [];
    }
    if (catalog.length === 0) {
      console.warn('[K-SCAN MATCH] catalog.json is empty; product matching disabled');
    }
    return catalog;
  } catch (error) {
    console.warn('[K-SCAN MATCH] catalog load failed; product matching disabled:', error?.message);
    return [];
  }
}

const CATALOG = loadCatalog();

// Demo/synthetic catalog rows must not surface in release builds. They are
// preserved in data/catalog.json for local layout testing and can be re-enabled
// server-side by setting INCLUDE_DEMO_CATALOG=true.
const INCLUDE_DEMO_CATALOG = process.env.INCLUDE_DEMO_CATALOG === 'true';

function isDemoCatalogProduct(product) {
  if (!product || typeof product !== 'object' || Array.isArray(product)) return false;
  const id = String(product.id || '').toLowerCase();
  const retailer = String(product.retailer || '').toLowerCase();
  const name = String(product.name || product.title || product.displayName || '').toLowerCase();
  return (
    id.startsWith('demo-') ||
    retailer.includes('k-scan demo') ||
    retailer.includes('k scan demo') ||
    name.includes('demo catalog')
  );
}

const IMAGE_PLACEHOLDER_CATEGORIES = new Set([
  'footwear',
  'outerwear',
  'tops',
  'bottoms',
  'dresses',
  'accessories',
]);

const CATEGORY_TAG_MAP = [
  { category: 'footwear', tags: ['sneakers', 'sneaker', 'boots', 'boot', 'shoe', 'shoes', 'slipper', 'loafer', 'mule', 'slide', 'sandal', 'clog'] },
  { category: 'outerwear', tags: ['jacket', 'coat', 'blazer', 'vest'] },
  { category: 'tops', tags: ['shirt', 'hoodie', 'tank', 'polo', 'bralette', 'top', 'cardigan', 'tee', 't-shirt', 'turtleneck', 'mockneck'] },
  { category: 'bottoms', tags: ['jeans', 'trousers', 'shorts', 'skirt', 'pants'] },
  { category: 'bottoms', tags: ['bottoms'] },
  { category: 'dresses', tags: ['dress', 'dresses', 'jumpsuit', 'romper', 'one-piece'] },
  { category: 'accessories', tags: ['bag', 'tote', 'beanie', 'hat', 'sunglasses', 'belt', 'scarf', 'accessories'] },
];

const CATEGORY_ALIASES = {
  footwear: 'footwear',
  shoe: 'footwear',
  shoes: 'footwear',
  sneaker: 'footwear',
  sneakers: 'footwear',
  boot: 'footwear',
  boots: 'footwear',
  slipper: 'footwear',
  slippers: 'footwear',
  loafer: 'footwear',
  loafers: 'footwear',
  outerwear: 'outerwear',
  jacket: 'outerwear',
  jackets: 'outerwear',
  coat: 'outerwear',
  coats: 'outerwear',
  blazer: 'outerwear',
  blazers: 'outerwear',
  vest: 'outerwear',
  tops: 'tops',
  top: 'tops',
  shirt: 'tops',
  shirts: 'tops',
  hoodie: 'tops',
  tee: 'tops',
  sweater: 'tops',
  knitwear: 'tops',
  bottoms: 'bottoms',
  bottom: 'bottoms',
  pants: 'bottoms',
  trousers: 'bottoms',
  jeans: 'bottoms',
  skirt: 'bottoms',
  skirts: 'bottoms',
  shorts: 'bottoms',
  dress: 'dresses',
  dresses: 'dresses',
  jumpsuit: 'dresses',
  romper: 'dresses',
  'one-piece': 'dresses',
  accessory: 'accessories',
  accessories: 'accessories',
  bag: 'accessories',
  tote: 'accessories',
  hat: 'accessories',
  belt: 'accessories',
  sunglasses: 'accessories',
};

const KNOWN_BAD_IMAGE_RE = /(?:picsum|unsplash|landscape|landscapes|ocean|oceans|bridge|bridges|building|buildings|cityscape|cityscapes|city|mountain|mountains|beach|beaches|nature|scenery|random|stock-photo|stockphoto)/i;

function canonicalCategory(value) {
  const normalized = String(value || '').toLowerCase().trim();
  return CATEGORY_ALIASES[normalized] || null;
}

function categoryForMetadata(metadata) {
  const words = [
    metadata?.category,
    metadata?.itemType,
    metadata?.item_type,
    metadata?.style,
    metadata?.silhouette,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
    .split(/[\s,/]+/)
    .filter(Boolean);
  for (const word of words) {
    const category = canonicalCategory(word);
    if (category) return category;
  }
  return null;
}

function imageCategoryForProduct(product) {
  const explicitCategory = canonicalCategory(product?.category);
  if (explicitCategory) return explicitCategory;

  const tags = Array.isArray(product?.tags) ? product.tags : [];
  const match = CATEGORY_TAG_MAP.find(({ tags: categoryTags }) =>
    tags.some((tag) => categoryTags.includes(tag))
  );
  return match?.category || 'accessories';
}

function isUsableProductImageUrl(imageUrl) {
  if (typeof imageUrl !== 'string' || !imageUrl.trim()) return false;
  if (KNOWN_BAD_IMAGE_RE.test(imageUrl)) return false;
  if (imageUrl.startsWith('/catalog-images/')) return true;
  try {
    const parsed = new URL(imageUrl);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch (_) {
    return false;
  }
}

function shapeProductForResponse(product) {
  const imageCategory = imageCategoryForProduct(product);
  let imageUrl = isUsableProductImageUrl(product.imageUrl) ? product.imageUrl : null;
  if (imageUrl?.startsWith('/catalog-images/')) {
    imageUrl = `${CATALOG_IMAGE_BASE_URL}${imageUrl}`;
  }

  if (product.imageUrl && !imageUrl && process.env.KSCAN_LOG_MATCH !== 'false') {
    console.log(
      `[K-SCAN MATCH] image sanitized: ${product.retailer} ${product.name}` +
      `  category:${imageCategory}`,
    );
  }

  const { tags, ...rest } = product;
  return {
    ...rest,
    imageUrl,
    imageCategory: IMAGE_PLACEHOLDER_CATEGORIES.has(imageCategory) ? imageCategory : 'accessories',
    purchaseUrl: product.purchaseUrl || product.productUrl || null,
    productUrl: product.productUrl || product.purchaseUrl || null,
  };
}

// ─── Weighted Heuristic Engine ────────────────────────────────────────────────
// TUNING GUIDE:
//   PRIMARY   – item type match. Raise to punish cross-category more harshly.
//   SECONDARY – style/aesthetic match. Raise to reward tight style alignment.
//   TERTIARY  – color, material, silhouette. Supporting signal only.
//   EXACT_MULTIPLIER – rewards tag === keyword over substring match.
//               Lower toward 1.0 to flatten exact vs. fuzzy distinction.
//   EXPAND_WEIGHT – multiplier for keywords added via normalization map.
//               0.6 = expanded keyword worth 60% of an original match.
//               Lower toward 0.3 to make expansions advisory; raise toward 1.0
//               to treat synonyms as first-class signals.
//   CATEGORY_PENALTY – multiplier when item type doesn't match. 0.0 = hard exclude.
//   CONFIDENCE_THRESHOLD – minimum score to appear in results at all.
//               4 = one secondary match. Lower to 2 to accept pure tertiary matches.
//   TIE_BAND  – score gap within which retailer diversity kicks in.
//   TOP_N     – number of products returned.
// ─────────────────────────────────────────────────────────────────────────────
// TUNING CHANGELOG (2026-04-11 — initial calibration)
//   tertiary: 2→3 | threshold: 5→7 | MULTI_TIER_2: 1.25→1.15
//   MULTI_TIER_3: 1.50→1.30 | TIE_BAND: 3→5 | SIGNAL_BONUS gated on tier quality
//
// TUNING CHANGELOG (2026-04-11 — audit v2, synthetic 10-scan analysis)
//
// Finding 1 — Scoring Plateau: any product matching one secondary + one silhouette
//   + one color (all exact) scored identically at 21.475. Score compression in
//   7/10 synthetic scans (Δ#1v#2 = 0). Plateau caused by uniform SIGNAL_BONUS
//   and SILHOUETTE_PRECISION_BONUS firing for all plateau members.
//   Fix: reduce SECONDARY 5→4 lowers ceiling; raises threshold 7→8 so style-alone
//   (6.0 pts) no longer passes unassisted.
//
// Finding 2 — SECONDARY anchor inflation: 'casual' in 46% of catalog,
//   'streetwear' in 29%. Secondary contributed >50% of total score in ~28% of
//   passing items. SECONDARY 5→4 brings contribution to ~50% (below 60% flag).
//
// Finding 3 — SILHOUETTE_PRECISION_BONUS too small to differentiate: +1.5 fires
//   uniformly for all plateau items, adding to the ceiling rather than breaking
//   it. Raised 1.5→3.5 so original-exact silhouette alignment creates a visible
//   sub-ranking within similar-scored items.
//
// Finding 4 — MULTI_TIER_3 over-reduced: 1.50→1.30 was too aggressive; genuine
//   3-tier matches lost meaningful separation. Restored to 1.40.
//
// Finding 5 — CATEGORY_PRECISION_BONUS fires in <5% of scans; when it fires
//   it should be decisive. Raised 3.0→5.0.
//
// Finding 6 — Retailer concentration (Gymshark 3/3, Free People 3/3) is a
//   CATALOG GAP (insufficient cross-retailer coverage for athleisure/bohemian),
//   not a scoring defect. TIE_BAND cannot bridge a 10.975-pt quality gap.
//   Action required: expand catalog with competing-retailer items in these styles.
// ─────────────────────────────────────────────────────────────────────────────
const WEIGHTS = { primary: 10, secondary: 4, tertiary: 3 };  // secondary: 5→4
const EXACT_MULTIPLIER     = 1.5;
const EXPAND_WEIGHT        = 0.6;  // expansion keywords score at 60% of originals
const CATEGORY_PENALTY     = 0.5;
const CONFIDENCE_THRESHOLD = 8;    // was 7: style-alone (6.0) no longer passes
const TIE_BAND             = 5;
const TOP_N                = 4;

// ── Signal Correlation constants ──────────────────────────────────────────────
const MULTI_TIER_2          = 1.15;
const MULTI_TIER_3          = 1.40;  // was 1.30: restores 3-tier separation
const EXPANSION_ONLY_PENALTY = 0.70;
const SIGNAL_BONUS          = 1.0;   // gated on tier quality — see scoring loop

// Primary tier: concrete item types.
const PRIMARY_TAGS = new Set([
  'hoodie', 'blazer', 'sneakers', 'trousers', 'boots', 'cardigan',
  'skirt', 'jeans', 'coat', 'jacket', 'dress', 'shirt', 'bag',
  'tote', 'vest', 'polo', 'tank', 'shorts', 'set', 'beanie',
  'bralette', 'top', 'pants', 'shoe', 'shoes', 'sneaker', 'boot',
  'slipper', 'slippers', 'loafer', 'loafers', 'mule', 'slide',
  'sandal', 'clog', 'tee', 't-shirt', 'turtleneck', 'mockneck',
  'jumpsuit', 'romper', 'one-piece', 'hat', 'sunglasses', 'belt',
  'scarf', 'cap', 'crossbody', 'balaclava',
]);

// Secondary tier: style and aesthetic identity.
const SECONDARY_TAGS = new Set([
  'streetwear', 'minimalist', 'classic', 'bohemian', 'athleisure',
  'preppy', 'grunge', 'romantic', 'formal', 'casual', 'elegant',
  'edgy', 'retro', 'sporty', 'earthy',
]);

// Silhouette tags: fit and form descriptors.
// Kept separate from generic tertiary so precision bonuses can target them
// specifically. Scoring tier is still TERTIARY — this set is for bonus logic only.
const SILHOUETTE_TAGS = new Set([
  'oversized', 'fitted', 'boxy', 'cropped', 'relaxed', 'wide-leg',
  'slim', 'flowy', 'straight', 'flared', 'layered', 'tailored',
  'high-rise', 'low-top',
]);

// Everything else (colors, materials) scores at TERTIARY weight.

function tagWeight(tag) {
  if (PRIMARY_TAGS.has(tag))   return WEIGHTS.primary;
  if (SECONDARY_TAGS.has(tag)) return WEIGHTS.secondary;
  return WEIGHTS.tertiary;
}

// ── Precision Tie-Breaking constants ─────────────────────────────────────────
// Flat additive bonuses applied after all multipliers are settled.
// Kept additive (not multiplicative) so they shift scores by a fixed margin
// that doesn't compound with MULTI_TIER or EXACT_MULTIPLIER.
//
// CATEGORY_PRECISION_BONUS (+3.0):
//   Fires when an original keyword is an exact string match against a PRIMARY_TAG
//   on the product. Separates "jacket" → jacket (direct) from "outerwear" → jacket
//   (via normalization). Set to ~30% of PRIMARY weight (10) so it meaningfully
//   re-ranks near-ties without overriding large score gaps.
//   Lower toward 1.5 if you want it as a subtle nudge only.
//   Raise toward 5.0 if exact item-type alignment should dominate tie-breaking.
//
// SILHOUETTE_PRECISION_BONUS (+1.5):
//   Fires when an original keyword exactly matches a SILHOUETTE_TAG on the product.
//   Worth ~75% of a TERTIARY exact hit (2 × 1.5 = 3.0) — significant enough to
//   separate "oversized jacket" from "oversized vest" when style scores are equal.
//   Lower toward 0.5 to reduce silhouette influence on final ranking.
//   Raise toward 2.5 if silhouette alignment is a priority signal for your catalog.
const CATEGORY_PRECISION_BONUS  = 5.0;
const SILHOUETTE_PRECISION_BONUS = 3.5;

// ─── Semantic Normalization Map ───────────────────────────────────────────────
// Maps AI-generated vocabulary to catalog tag equivalents.
// Each entry: 'ai_term' → ['catalog_tag', ...]
// Expansions are scored at EXPAND_WEIGHT so they boost without overmatching.
//
// TUNING: Add new entries as you discover AI terms that don't match catalog tags.
// Remove entries that produce false positives. Each key should be a word the AI
// generates but that does NOT exist as a tag in catalog.json.
const NORMALIZATION_MAP = {
  // ── Category expansions: AI uses broad nouns; catalog uses specific item types
  outerwear:   ['jacket', 'coat', 'blazer', 'vest'],
  footwear:    ['sneakers', 'boots', 'shoe', 'slipper', 'loafer', 'mule', 'slide'],
  tops:        ['shirt', 'hoodie', 'tank', 'polo', 'tee', 'cardigan'],
  bottoms:     ['jeans', 'trousers', 'shorts', 'skirt', 'pants'],
  dresses:     ['dress', 'jumpsuit', 'romper', 'one-piece'],
  accessories: ['bag', 'tote', 'beanie', 'hat', 'sunglasses', 'belt', 'scarf'],
  knitwear:    ['cardigan', 'hoodie'],
  denim:       ['jeans', 'jacket'],         // "denim" as category, not material
  suiting:     ['blazer', 'trousers'],

  // ── Silhouette synonyms: body-language words the AI uses vs. fit descriptors
  loose:       ['oversized'],
  baggy:       ['oversized'],
  boxy:        ['oversized'],               // boxy is tertiary in catalog; map to same
  voluminous:  ['oversized', 'flowy'],
  skinny:      ['fitted'],
  tight:       ['fitted'],
  slim:        ['fitted'],
  structured:  ['tailored', 'fitted'],
  unstructured:['relaxed'],
  draped:      ['flowy', 'relaxed'],
  flared:      ['wide-leg', 'relaxed'],

  // ── Footwear type expansions (missing from original map)
  slipper:     ['slipper', 'shoe'],
  slippers:    ['slipper', 'shoe'],
  mule:        ['mule', 'shoe'],
  slide:       ['slide', 'sandal'],
  loafer:      ['loafer', 'shoe'],
  sandal:      ['sandal', 'shoe'],
  clog:        ['clog', 'mule'],
  heel:        ['boots'],
  pump:        ['boots'],
  sneaker:     ['sneakers'],               // singular form
  boot:        ['boots'],                  // singular form

  // ── Style mappings: AI aesthetic words → catalog style tags
  sporty:      ['athleisure'],
  athletic:    ['athleisure', 'sporty'],
  vintage:     ['retro', 'bohemian'],
  boho:        ['bohemian'],
  smart:       ['classic', 'formal'],
  tailored:    ['classic', 'formal'],       // tailored is tertiary; expand to secondary
  workwear:    ['formal', 'classic'],
  androgynous: ['minimalist', 'classic'],
  maximalist:  ['bohemian', 'streetwear'],
  coastal:     ['casual', 'classic'],
  preppy:      ['classic', 'preppy'],       // preppy already in catalog; belt + suspenders
  dark:        ['grunge', 'streetwear'],
  moody:       ['grunge', 'edgy'],

  // ── Outdoor / adventure aesthetic
  gorpcore:    ['sporty', 'athleisure'],
  outdoor:     ['sporty', 'athleisure'],
  technical:   ['athleisure', 'sporty'],
  activewear:  ['athleisure', 'sporty'],
};

// ─── Response attribute normalization ────────────────────────────────────────
// Maps non-standard AI-generated values to accepted taxonomy terms.
// Applied in parseFashionObject so downstream keyword matching and placeholder
// logic receive canonical values.
const COLOR_ALIASES = {
  'charcoal gray':  'Charcoal',
  'charcoal grey':  'Charcoal',
  'dark gray':      'Charcoal',
  'dark grey':      'Charcoal',
  'light gray':     'Light Gray',
  'light grey':     'Light Gray',
  'off-white':      'Off-White',
  'off white':      'Off-White',
  'midnight blue':  'Navy',
  'navy blue':      'Navy',
  'dark blue':      'Navy',
  'earth tone':     'Earth Tones',
  'earth tones':    'Earth Tones',
  'earthy':         'Earth Tones',
  'nude':           'Beige',
  'forest green':   'Green',
  'olive green':    'Olive',
  'sage green':     'Sage',
};

const SILHOUETTE_ALIASES = {
  'voluminous':    'Oversized',
  'voluminous fit':'Oversized',
  'loose':         'Relaxed',
  'baggy':         'Oversized',
  'form-fitting':  'Fitted',
  'form fitting':  'Fitted',
  'body-con':      'Fitted',
  'bodycon':       'Fitted',
  'body con':      'Fitted',
  'skinny':        'Slim',
  'skinny fit':    'Slim',
  'slim fit':      'Slim',
  'wide leg':      'Wide-leg',
  'palazzo':       'Wide-leg',
  'draped':        'Flowy',
  'flowing':       'Flowy',
  'structured':    'Fitted',
  'tailored':      'Fitted',
  // compound/qualified fit descriptors (e.g. "Relaxed fit" observed in live responses)
  'relaxed fit':   'Relaxed',
  'regular fit':   'Relaxed',
  'standard fit':  'Relaxed',
  'classic fit':   'Relaxed',
  'comfort fit':   'Relaxed',
  'boyfriend fit': 'Relaxed',
  'oversized fit': 'Oversized',
  'fitted bodice': 'Fitted',
  // item-type words the AI incorrectly places in the silhouette field
  'slip-on':       'Relaxed',
  'low-top':       'Relaxed',
  'high-top':      'Relaxed',
  'mini':          'Fitted',
  'maxi':          'Flowy',
  'midi':          'Straight',
  'tote':          'Relaxed',   // "Tote or shoulder bag" fallback
  'shoulder bag':  'Relaxed',
};

function normalizeAttributeValue(value, aliases) {
  if (!value || typeof value !== 'string') return value;
  return aliases[value.toLowerCase().trim()] || value;
}

// ─── Canonical schema enforcement ────────────────────────────────────────────
// CATEGORY_CANONICAL and SILHOUETTE_CANONICAL define the ONLY values the
// frontend schema accepts. resolveCompoundValue handles compound strings,
// case-insensitive matches, and unknown values with safe fallbacks.
// These sets are the authority — they must stay aligned with app/api/analyze+api.js.
const CATEGORY_CANONICAL  = new Set(['Tops', 'Bottoms', 'Outerwear', 'Footwear', 'Accessories', 'Dresses']);
const SILHOUETTE_CANONICAL = new Set(['Oversized', 'Fitted', 'Relaxed', 'Boxy', 'Cropped', 'Wide-leg', 'Slim', 'Flowy', 'Straight', 'Layered']);

/**
 * Resolve a raw attribute value to a canonical enum value.
 * Strategy hierarchy (per task spec):
 *   1. Direct canonical match (case-insensitive)
 *   2. Alias lookup via SILHOUETTE_ALIASES / COLOR_ALIASES (done before this call)
 *   3. Split compound string on , / | " and " — take first valid token
 *   4. Emit SCHEMA_REJECTED and return safe fallback
 * NEVER hard-fails; always returns a frontend-safe value.
 */
function resolveCompoundValue(rawValue, canonicalSet, fallback, fieldName, provider) {
  if (!rawValue || typeof rawValue !== 'string') return fallback;

  // 1. Direct case-insensitive match
  for (const v of canonicalSet) {
    if (v.toLowerCase() === rawValue.toLowerCase()) return v;
  }

  // 2. Split on compound delimiters and try each token in order
  const tokens = rawValue.split(/[,\/|]+|\s+and\s+/i).map(t => t.trim()).filter(Boolean);
  for (const token of tokens) {
    const tokenLower = token.toLowerCase();
    for (const v of canonicalSet) {
      const vLower = v.toLowerCase();
      // Exact token match (case-insensitive)
      if (tokenLower === vLower) {
        logPipelineEvent('SCHEMA_NORMALIZED', {
          field: fieldName, from: rawValue, to: v, method: 'compound_split', provider,
        });
        return v;
      }
      // Prefix match at word boundary: "Fitted bodice" → "Fitted"
      // Requires token to start with the canonical value followed by a space.
      if (tokenLower.startsWith(vLower + ' ')) {
        logPipelineEvent('SCHEMA_NORMALIZED', {
          field: fieldName, from: rawValue, to: v, method: 'compound_prefix', provider,
        });
        return v;
      }
    }
  }

  // 3. No valid token — emit SCHEMA_REJECTED and return safe fallback
  logPipelineEvent('SCHEMA_REJECTED', { field: fieldName, value: rawValue, fallback, provider });
  return fallback;
}

/**
 * Apply strict canonical schema to fashion metadata after alias normalization.
 * Handles compound values ("Tops, Bottoms"), item-type leakage ("Slip-on"),
 * and any value not in the canonical enum. Always returns a frontend-safe object.
 */
function enforceCanonicalSchema(metadata, provider) {
  if (!metadata || typeof metadata !== 'object') return metadata;
  const category   = resolveCompoundValue(metadata.category,   CATEGORY_CANONICAL,   'Accessories', 'category',   provider);
  const silhouette = resolveCompoundValue(metadata.silhouette, SILHOUETTE_CANONICAL, 'Relaxed',     'silhouette', provider);
  return { ...metadata, category, silhouette };
}

// ─── Keyword preprocessing ────────────────────────────────────────────────────
// Returns { originalKeywords, expandedSet, allKeywords }
// expandedSet tracks which keywords came from normalization so scoring
// can apply EXPAND_WEIGHT selectively — originals always score at full weight.
function buildKeywords(metadata) {
  const originalKeywords = [...new Set(
    [
      metadata.category,
      metadata.itemType,
      metadata.item_type,
      metadata.material,
      metadata.style,
      metadata.color,
      metadata.silhouette,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .split(/[\s,/]+/)
      .filter((w) => w.length > 2),
  )];

  const originalSet = new Set(originalKeywords);
  const expandedSet = new Set();              // only expanded-only terms land here

  for (const kw of originalKeywords) {
    const expansions = NORMALIZATION_MAP[kw];
    if (!expansions) continue;
    for (const exp of expansions) {
      // Skip if this expansion is already an original keyword — it would score
      // at full weight from the original path; don't demote it to EXPAND_WEIGHT.
      if (!originalSet.has(exp) && !expandedSet.has(exp)) {
        expandedSet.add(exp);
      }
    }
  }

  // allKeywords = originals first, then expansions (order matters for readability)
  const allKeywords = [...originalKeywords, ...expandedSet];

  return { originalKeywords, expandedSet, allKeywords };
}

function matchProducts(metadata, options = {}) {
  const { expandedSet, allKeywords } = buildKeywords(metadata);
  const requestedCategory = categoryForMetadata(metadata);
  const eligibleCatalog = requestedCategory
    ? CATALOG.filter((product) => imageCategoryForProduct(product) === requestedCategory)
    : CATALOG;
  const catalogForScoring = (eligibleCatalog.length > 0 ? eligibleCatalog : CATALOG)
    .filter((product) => INCLUDE_DEMO_CATALOG || !isDemoCatalogProduct(product));

  // itemKeywords drawn from allKeywords so normalization activates category filter.
  // e.g. AI says "outerwear" → expands to ["jacket","coat"] → category filter fires.
  const itemKeywords = allKeywords.filter((kw) => PRIMARY_TAGS.has(kw));

  const scored = catalogForScoring
    .map((product) => {
      // ── Step 1-3: base weighted score, exact bonus, expansion weighting ──
      // Accumulate alongside per-keyword tracking for steps 4-6.
      // tiersHit: which distinct tiers contributed at least one match.
      // uniqueKwHits: count of distinct keywords that found a tag match.
      // hasOriginalHit: true if any non-expanded keyword matched (step 5).
      const tiersHit     = new Set();  // 'primary' | 'secondary' | 'tertiary'
      let uniqueKwHits        = 0;
      let hasOriginalHit      = false;
      let hasCategoryPrecision  = false; // step 7a: original exact-match on PRIMARY_TAG
      let hasSilhouettePrecision = false; // step 7b: original exact-match on SILHOUETTE_TAG

      const matchPairs = []; // collected for evaluation logging only

      let score = allKeywords.reduce((total, kw) => {
        // Each keyword contributes at most once per product (first tag match wins).
        const hit = product.tags.find((t) => t === kw || t.includes(kw) || kw.includes(t));
        if (!hit) return total;

        const isExpanded = expandedSet.has(kw);
        const isOriginal = !isExpanded;
        const weight       = tagWeight(hit);
        const exactBonus   = hit === kw ? EXACT_MULTIPLIER : 1;
        const originWeight = isExpanded ? EXPAND_WEIGHT : 1;

        // Track tier for step 4
        if (PRIMARY_TAGS.has(hit))        tiersHit.add('primary');
        else if (SECONDARY_TAGS.has(hit)) tiersHit.add('secondary');
        else                              tiersHit.add('tertiary');

        // Track signal breadth for step 6
        uniqueKwHits += 1;

        // Track origin purity for step 5
        if (isOriginal) hasOriginalHit = true;

        // Track precision alignment for steps 7a/7b.
        // Requires: original keyword + exact string match + correct tag tier.
        if (isOriginal && hit === kw) {
          if (PRIMARY_TAGS.has(hit))    hasCategoryPrecision  = true;
          if (SILHOUETTE_TAGS.has(hit)) hasSilhouettePrecision = true;
        }

        matchPairs.push(`${kw}→${hit}`);
        return total + weight * exactBonus * originWeight;
      }, 0);

      // ── Category hard-filter (applied before signal adjustments) ─────────
      if (itemKeywords.length > 0) {
        const productItemTags = product.tags.filter((t) => PRIMARY_TAGS.has(t));
        const categoryHit = itemKeywords.some((kw) =>
          productItemTags.some((t) => t === kw || t.includes(kw) || kw.includes(t))
        );
        if (!categoryHit) score *= CATEGORY_PENALTY;
      }

      // ── Step 4: multi-tier boost ──────────────────────────────────────────
      // Multiplier rewards products that align across primary + secondary +
      // tertiary signals, not just deep in one tier.
      if (tiersHit.size >= 3)      score *= MULTI_TIER_3;
      else if (tiersHit.size >= 2) score *= MULTI_TIER_2;

      // ── Step 5: isolated expansion penalty ───────────────────────────────
      // Product matched zero original keywords — all contribution came from
      // normalization expansions. Discount to prevent purely inferred matches
      // from outranking products with direct vocabulary alignment.
      if (!hasOriginalHit && score > 0) score *= EXPANSION_ONLY_PENALTY;

      // ── Step 6: signal breadth bonus ─────────────────────────────────────
      // Flat bonus for matching 3+ distinct keywords, BUT only when at least
      // one of those hits landed in PRIMARY or SECONDARY tier. Prevents 3 generic
      // color/material hits from earning the same bonus as a cross-tier alignment.
      if (uniqueKwHits >= 3 && (tiersHit.has('primary') || tiersHit.has('secondary'))) {
        score += SIGNAL_BONUS;
      }

      // ── Step 7a: category precision bonus ────────────────────────────────
      // An original keyword was an exact string match against a PRIMARY_TAG.
      // Differentiates a direct "jacket" → jacket hit from a normalized
      // "outerwear" → jacket expansion hit.
      if (hasCategoryPrecision)  score += CATEGORY_PRECISION_BONUS;

      // ── Step 7b: silhouette precision bonus ──────────────────────────────
      // An original keyword was an exact string match against a SILHOUETTE_TAG.
      // Separates "oversized jacket" from "jacket" when category scores are equal.
      if (hasSilhouettePrecision) score += SILHOUETTE_PRECISION_BONUS;

      return { score, product, matchPairs, hasCategoryPrecision, hasSilhouettePrecision };
    })
    .sort((a, b) => b.score - a.score);

  // ── Evaluation logging ────────────────────────────────────────────────────
  // `allScored` = full catalog sorted descending, pre-threshold-filter.
  // Logging here means FAIL rows are visible alongside PASS rows.
  // Cap at top 5 to keep output readable. Guard with KSCAN_LOG_MATCH env flag
  // once per-scan visibility is no longer needed in production.
  const allScored = scored; // `scored` holds the .map().sort() result at this point
  if (process.env.KSCAN_LOG_MATCH !== 'false') {
    const LOG_TOP = 5;
    const header =
      `category:${metadata.category || '—'}  ` +
      `color:${metadata.color || '—'}  ` +
      `silhouette:${metadata.silhouette || '—'}  ` +
      `| threshold:${CONFIDENCE_THRESHOLD}`;
    const rows = allScored.slice(0, LOG_TOP).map((e, i) => {
      const pass   = e.score >= CONFIDENCE_THRESHOLD ? 'PASS' : 'FAIL';
      const sc     = e.score.toFixed(2).padStart(6);
      const retail = e.product.retailer.padEnd(18);
      const name   = e.product.name.padEnd(36);
      const pairs  = e.matchPairs.length ? e.matchPairs.join('  ') : '(no matches)';
      const prec   = `precision C:${e.hasCategoryPrecision}  S:${e.hasSilhouettePrecision}`;
      return `  #${i + 1}  ${sc}  ${pass}  ${retail}${name}\n       ${pairs}\n       ${prec}`;
    });
    console.log(`[K-SCAN MATCH] ${header}\n${rows.join('\n')}`);
  }

  const passing = allScored.filter(({ score }) => score >= CONFIDENCE_THRESHOLD);

  if (passing.length === 0) {
    // Empty-shelf insight: log the highest scorer that didn't make the cut.
    // allScored is sorted descending so index 0 is always the best attempt.
    if (allScored.length > 0 && process.env.KSCAN_LOG_MATCH !== 'false') {
      const bf = allScored[0];
      console.log(
        `[K-SCAN MATCH] empty shelf — best_failed: score:${bf.score.toFixed(2)}` +
        `  ${bf.product.retailer}  ${bf.product.name}` +
        `\n  matches: ${bf.matchPairs.join('  ') || '(none)'}`,
      );
    }
    return [];
  }

  if (options.debug) {
    return passing.map(({ product, score, matchPairs, hasCategoryPrecision, hasSilhouettePrecision }) => ({
      ...product,
      finalScore: score,
      matchPairs,
      precision: {
        category: hasCategoryPrecision,
        silhouette: hasSilhouettePrecision,
      },
    }));
  }

  // ── Retailer diversity selection ──────────────────────────────────────────
  const selected = [];
  const remaining = [...passing];
  const usedRetailers = new Set();

  while (selected.length < TOP_N && remaining.length > 0) {
    const bestOverall = remaining[0];
    const bestDiverse = remaining.find((e) => !usedRetailers.has(e.product.retailer));

    let pick;
    if (
      !bestDiverse ||
      bestOverall.product.retailer === bestDiverse.product.retailer ||
      bestOverall.score - bestDiverse.score > TIE_BAND
    ) {
      pick = bestOverall;
    } else {
      pick = bestDiverse;
    }

    selected.push(pick);
    usedRetailers.add(pick.product.retailer);
    remaining.splice(remaining.indexOf(pick), 1);
  }

  return selected.map(({ product }) => shapeProductForResponse(product));
}

// JSON-first prompt — modern LLMs (Llama 4, GPT-4o, etc.) produce more reliable
// structured output than the old text-field format. The legacy text format is kept
// as a fallback inside parseAIResponse for backward compatibility with Gemini.
//
// Design notes:
//   - "Start with { / end with }" forces the model to open JSON immediately.
//   - Silhouette is constrained to fit descriptors only (not item-type words like
//     "Slip-on" or "Mini") to prevent taxonomy drift that breaks product matching.
//   - Category uses the exact values in CATEGORY_ALIASES so normalization is tight.
//   - A concrete example anchors the expected output structure.
const SYSTEM_PROMPT = `You are a high-fashion AI stylist with computer vision. Your ENTIRE response must be a single valid JSON object.

CRITICAL: Start your response with { and end with }. No markdown fences, no prose, no explanation outside the JSON.

If the image does NOT contain clothing, footwear, or accessories:
{"type":"non-fashion","message":"<one sentence describing what the image actually shows>"}

If the image DOES contain a fashion item:
{"type":"fashion","result":"<2-4 sentence professional style breakdown with one pairing suggestion>","metadata":{"category":"<EXACTLY ONE of: Footwear | Outerwear | Tops | Bottoms | Accessories>","itemType":"<specific item e.g. sneaker, hoodie, tote bag, blazer, jeans>","material":"<visible fabric/construction e.g. leather, denim, cotton, quilted nylon>","style":"<EXACTLY ONE of: Casual | Streetwear | Minimalist | Classic | Bohemian | Athleisure | Formal | Grunge>","color":"<dominant palette e.g. Black, Navy / White, Earth Tones>","silhouette":"<EXACTLY ONE fit descriptor: Oversized | Fitted | Relaxed | Boxy | Cropped | Wide-leg | Slim | Flowy | Straight | Layered>"}}

Example for a white hoodie:
{"type":"fashion","result":"A crisp white hoodie with minimal logo detailing and a relaxed cotton-blend construction. The clean silhouette makes it a versatile layering piece. Pair with slim black jeans and white sneakers for a polished casual look.","metadata":{"category":"Tops","itemType":"hoodie","material":"cotton-blend","style":"Casual","color":"White","silhouette":"Relaxed"}}`;

// Ultra-strict schema prompt used for the retry call when the first response is
// malformed or prose-only. Paired with temperature 0.1 (set in callOpenRouter).
// No conversational context is added — schema constraint only.
const REPAIR_SYSTEM_PROMPT = `Output ONLY a valid JSON object starting with {. No prose, no markdown.
Fashion: {"type":"fashion","result":"<style description>","metadata":{"category":"<Footwear|Outerwear|Tops|Bottoms|Accessories|Dresses>","itemType":"<item>","material":"<fabric>","style":"<Casual|Streetwear|Minimalist|Classic|Bohemian|Athleisure|Formal>","color":"<palette>","silhouette":"<Oversized|Fitted|Relaxed|Boxy|Cropped|Wide-leg|Slim|Flowy|Straight|Layered>"}}
Non-fashion: {"type":"non-fashion","message":"<description>"}`;

// ─── Pipeline version constants ───────────────────────────────────────────────
// Exposed in X-KScan-Debug response headers (non-production only).
// Bump each when the corresponding logic changes so deployment convergence
// checks can confirm all instances are running the same version.
// Bump PARSER_VERSION: parseAIResponse / parseFashionObject logic changes.
// Bump NORMALIZATION_VERSION: SILHOUETTE_ALIASES / COLOR_ALIASES / enforceCanonicalSchema changes.
// Bump PROMPT_VERSION: SYSTEM_PROMPT / REPAIR_SYSTEM_PROMPT changes.
const PARSER_VERSION        = '3.0';
const NORMALIZATION_VERSION = '2.0';
const PROMPT_VERSION        = '2.0';

// Structured pipeline observability — gated behind DEBUG_AI_PIPELINE env flag
// or the existing DEV_PROVIDER_LOGS flag. Silent in production unless opted in.
// Set DEBUG_AI_PIPELINE=true in .env for per-request tracing.
const DEBUG_AI_PIPELINE = process.env.DEBUG_AI_PIPELINE === 'true';

function logPipelineEvent(event, details = {}) {
  if (!DEBUG_AI_PIPELINE && !DEV_PROVIDER_LOGS) return;
  const entry = { event, ...details };
  if (entry.preview) entry.preview = String(entry.preview).slice(0, 200);
  console.log('[K-SCAN PIPELINE]', JSON.stringify(entry));
}

function aiLog(level, message, details = {}) {
  if (!DEV_PROVIDER_LOGS) return;
  const logger = level === 'error' ? console.error : console.warn;
  logger(message, details);
}

function previewProviderText(text, max = 1000) {
  return String(text || '')
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, '[image-base64-redacted]')
    .slice(0, max);
}

function collectJsonCandidates(text) {
  const candidates = [text];
  if (/^"(?:type|result|metadata|category)"\s*:/i.test(text)) {
    candidates.push(`{${text}`);
  }
  if (/^(?:type|result|metadata|category)"\s*:/i.test(text)) {
    candidates.push(`{"${text}`);
  }
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
  let fenceMatch;
  while ((fenceMatch = fenceRegex.exec(text))) {
    candidates.unshift(fenceMatch[1].trim());
  }

  const start = text.indexOf('{');
  if (start !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i += 1) {
      const char = text[i];
      if (inString) {
        escaped = char === '\\' && !escaped;
        if (char === '"' && !escaped) inString = false;
        if (char !== '\\') escaped = false;
        continue;
      }
      if (char === '"') inString = true;
      if (char === '{') depth += 1;
      if (char === '}') depth -= 1;
      if (depth === 0) {
        candidates.push(text.slice(start, i + 1).trim());
        break;
      }
    }
  }

  return [...new Set(candidates.filter(Boolean))];
}

function firstString(...values) {
  const found = values.find((value) => typeof value === 'string' && value.trim());
  return found ? found.trim() : '';
}

// ─── Prose metadata repair ─────────────────────────────────────────────────
// When all JSON-extraction and legacy-format attempts fail, extract structured
// metadata from the raw prose text before the prose-only fallback activates.
// Used as Attempt 4b inside parseAIResponse.

const PROSE_CATEGORY_PATTERNS = [
  { re: /\b(sneaker|sneakers|shoe|shoes|boot|boots|footwear|loafer|sandal|mule|slipper|pump|heel|clog)\b/i, value: 'Footwear' },
  { re: /\b(jacket|coat|blazer|outerwear|parka|trench|puffer|windbreaker|bomber|vest)\b/i, value: 'Outerwear' },
  { re: /\b(shirt|hoodie|top|blouse|tee|t-shirt|sweater|cardigan|turtleneck|tank|polo|bralette|knitwear|sweatshirt)\b/i, value: 'Tops' },
  { re: /\b(dress|gown|jumpsuit|romper|one-piece)\b/i, value: 'Bottoms' },
  { re: /\b(jeans|pants|trousers|skirt|shorts|leggings|joggers|chinos)\b/i, value: 'Bottoms' },
  { re: /\b(bag|tote|purse|backpack|clutch|satchel|crossbody|handbag|pouch)\b/i, value: 'Accessories' },
  { re: /\b(belt|hat|cap|beanie|sunglasses|jewelry|necklace|bracelet|watch|scarf|gloves)\b/i, value: 'Accessories' },
];

const PROSE_SILHOUETTE_PATTERNS = [
  { re: /\b(oversized|over-sized|baggy|loose|voluminous)\b/i,       value: 'Oversized' },
  { re: /\b(fitted|slim|skinny|tight|body-con|bodycon|form-fitting)\b/i, value: 'Fitted' },
  { re: /\b(relaxed|comfortable|easy-fit|regular fit|regular-fit)\b/i, value: 'Relaxed' },
  { re: /\b(boxy|box-cut)\b/i,                                       value: 'Boxy' },
  { re: /\b(cropped|crop top)\b/i,                                   value: 'Cropped' },
  { re: /\b(wide-leg|wide leg|palazzo|flared)\b/i,                   value: 'Wide-leg' },
  { re: /\b(flowy|flowing|draped|fluid)\b/i,                         value: 'Flowy' },
  { re: /\b(layered|layering)\b/i,                                   value: 'Layered' },
  { re: /\b(straight|straight-leg|straight-cut|classic fit)\b/i,     value: 'Straight' },
  { re: /\b(tailored|structured|slim fit)\b/i,                       value: 'Fitted' },
];

const PROSE_COLOR_PATTERNS = [
  { re: /\b(black)\b/i,                                   value: 'Black' },
  { re: /\b(white|ivory|cream|off-white)\b/i,             value: 'White' },
  { re: /\b(navy|dark blue|midnight blue)\b/i,             value: 'Navy' },
  { re: /\b(blue|cobalt|cerulean)\b/i,                    value: 'Blue' },
  { re: /\b(red|crimson|scarlet|burgundy)\b/i,             value: 'Red' },
  { re: /\b(gray|grey|charcoal|slate)\b/i,                value: 'Gray' },
  { re: /\b(brown|tan|camel|chocolate|cognac|mocha)\b/i,  value: 'Brown' },
  { re: /\b(beige|sand|nude|taupe)\b/i,                   value: 'Beige' },
  { re: /\b(green|olive|emerald|forest|sage|khaki)\b/i,   value: 'Green' },
  { re: /\b(pink|blush|rose|mauve)\b/i,                   value: 'Pink' },
  { re: /\b(purple|lavender|violet|plum)\b/i,             value: 'Purple' },
  { re: /\b(yellow|mustard|gold|butter)\b/i,              value: 'Yellow' },
  { re: /\b(orange|rust|terracotta)\b/i,                  value: 'Orange' },
  { re: /\b(monochrome|monochromatic)\b/i,                value: 'Monochrome' },
  { re: /\b(earth tone|earth tones|earthy)\b/i,           value: 'Earth Tones' },
  { re: /\b(striped|plaid|floral|patterned)\b/i,          value: 'Multi-color' },
];

// When prose extraction finds a category but no silhouette signal, use this
// category-specific default so metadata always has a non-empty silhouette.
// All values MUST be members of SILHOUETTE_CANONICAL.
const CATEGORY_DEFAULT_SILHOUETTE = {
  Footwear:    'Relaxed',
  Outerwear:   'Relaxed',
  Tops:        'Relaxed',
  Bottoms:     'Relaxed',
  Dresses:     'Flowy',
  Accessories: 'Relaxed',  // was 'Structured' — not in SILHOUETTE_CANONICAL
};

function firstProseMatch(text, patterns) {
  // Use the match whose keyword appears EARLIEST in the text rather than the
  // first pattern in the array. This correctly ignores pairing-suggestion words
  // ("Pair with a blazer") when the main subject appears before them.
  let earliestValue = '';
  let earliestIndex = Infinity;
  for (const { re, value } of patterns) {
    const m = re.exec(text);
    if (m && m.index < earliestIndex) {
      earliestIndex = m.index;
      earliestValue = value;
    }
  }
  return earliestValue;
}

/**
 * Extract structured metadata from unstructured prose AI responses.
 * Returns { category, color, silhouette } when at least category is found,
 * otherwise returns null. Called as Attempt 4b in parseAIResponse.
 */
function extractMetadataFromProse(text) {
  if (!text || typeof text !== 'string') return null;
  const category = firstProseMatch(text, PROSE_CATEGORY_PATTERNS);
  if (!category) return null;
  const color      = firstProseMatch(text, PROSE_COLOR_PATTERNS) || 'Undetermined';
  const silhouette = firstProseMatch(text, PROSE_SILHOUETTE_PATTERNS)
    || CATEGORY_DEFAULT_SILHOUETTE[category]
    || 'Relaxed';
  return { category, color, silhouette };
}

function parseFashionObject(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const type = String(parsed.type || parsed.classification || parsed.status || '').toLowerCase();
  if (type.includes('non-fashion') || type.includes('non_fashion')) {
    return {
      type:    'non-fashion',
      message: firstString(parsed.message, parsed.reason, parsed.description) || 'This does not appear to be a fashion item.',
    };
  }

  const metadataSource = parsed.metadata && typeof parsed.metadata === 'object'
    ? parsed.metadata
    : parsed;
  const category = firstString(
    metadataSource.category,
    metadataSource.primary_category,
    metadataSource.item_category,
    metadataSource.itemType,
    metadataSource.item_type,
    metadataSource.product_type,
  );
  const itemType = firstString(
    metadataSource.itemType,
    metadataSource.item_type,
    metadataSource.product_type,
    metadataSource.garment,
  );
  const color = firstString(metadataSource.color, metadataSource.colors, metadataSource.palette);
  const material = firstString(metadataSource.material, metadataSource.fabric, metadataSource.construction);
  const style = firstString(metadataSource.style, metadataSource.aesthetic);
  const silhouette = firstString(
    metadataSource.silhouette,
    metadataSource.shape,
    metadataSource.fit,
    metadataSource.closure,
  );

  const hasAttributeEvidence = Boolean(
    category || itemType || color || material || style || silhouette,
  );

  const narrative = firstString(parsed.result, parsed.analysis, parsed.description, parsed.summary);
  const hasSubstantiveNarrative = narrative.length >= 40;

  const fashionTypeKeyword =
    type.includes('fashion') &&
    !type.includes('non-fashion') &&
    !type.includes('non_fashion');

  // Model sometimes returns the JSON template with type:"fashion" but no usable
  // metadata (e.g. a coffee mug). That must not become an empty "fashion" API
  // response — normalize to explicit non-fashion per API contract.
  if (fashionTypeKeyword && !hasAttributeEvidence && !hasSubstantiveNarrative) {
    return {
      type: 'non-fashion',
      message:
        firstString(parsed.message, parsed.reason, parsed.description, narrative) ||
        'This does not appear to be a fashion item.',
    };
  }

  const hasFashionShape = hasAttributeEvidence || hasSubstantiveNarrative;

  if (!hasFashionShape) return null;

  // Step 1 — alias normalisation (fast lookup, handles exact known variants).
  const normalizedColor = normalizeAttributeValue(color, COLOR_ALIASES);
  // Apply silhouette alias BEFORE canonical enforcement so compound tokens like
  // "Relaxed fit" are resolved to "Relaxed" before the set-membership check.
  const aliasedSilhouette = normalizeAttributeValue(silhouette, SILHOUETTE_ALIASES);

  // Step 2 — canonical schema enforcement (compound resolution, enum validation).
  // resolveCompoundValue handles "Fitted bodice, Full skirt" → "Fitted",
  // "Tops, Bottoms" → "Tops", unknown values → safe fallback.
  const canonicalCategory   = resolveCompoundValue(category,        CATEGORY_CANONICAL,   'Accessories', 'category',   null);
  const canonicalSilhouette = resolveCompoundValue(aliasedSilhouette, SILHOUETTE_CANONICAL, 'Relaxed',   'silhouette', null);

  const generatedResult = [
    itemType || canonicalCategory,
    normalizedColor    && `${normalizedColor} color palette`,
    material           && `${material} construction`,
    style              && `${style} styling`,
    canonicalSilhouette && `${canonicalSilhouette} silhouette`,
  ].filter(Boolean).join(', ');

  // Confidence: clamp any AI-provided score to [0,1]; otherwise compute from
  // field population so callers always receive a deterministic value.
  const rawAiConf = parsed.confidence ?? parsed.confidence_score ?? null;
  let confidence;
  if (rawAiConf !== null) {
    const n = Number(rawAiConf);
    confidence = isFinite(n) ? Math.max(0, Math.min(1, n)) : null;
  }
  if (confidence == null) {
    const filled = [canonicalCategory, itemType, normalizedColor, material, style, canonicalSilhouette].filter(Boolean).length;
    confidence =
      filled >= 5 ? 0.95 :
      filled === 4 ? 0.85 :
      filled === 3 ? 0.75 :
      filled === 2 ? 0.60 :
      filled === 1 ? 0.45 : 0.20;
  }

  return {
    type: 'fashion',
    result: firstString(parsed.result, parsed.analysis, parsed.description, parsed.summary) || generatedResult,
    metadata: {
      category:  canonicalCategory,
      itemType,
      material,
      style,
      color:     normalizedColor,
      silhouette: canonicalSilhouette,
      confidence,
    },
  };
}

// ── AI response parser — tries JSON first, then fenced JSON, then legacy text format ──
// This makes the backend resilient to models that wrap JSON in markdown, return
// prose with JSON embedded, or fall back to the old Category:/Color:/Silhouette: format.
function parseAIResponse(rawText, context = {}) {
  if (!rawText || !rawText.trim()) return null;

  const text = rawText.trim();

  const parseFailures = [];
  for (const candidate of collectJsonCandidates(text)) {
    try {
      const parsed = JSON.parse(candidate);
      const normalized = parseFashionObject(parsed);
      if (normalized) return normalized;
    } catch (error) {
      parseFailures.push({
        message: error?.message,
        candidateLength: candidate.length,
        preview: previewProviderText(candidate, 500),
      });
      // not valid JSON — try next candidate
    }
  }
  if (parseFailures.length > 0) {
    aiLog('warn', '[K-SCAN] AI JSON parse failed for all candidates', {
      provider: context.provider,
      attempts: parseFailures.length,
      firstError: parseFailures[0],
    });
  }

  // Attempt 4: legacy text format (Category: / Color: / Silhouette: lines)
  // Kept for backward compatibility with Gemini and any model that ignores JSON prompt.
  const nonFashion = checkNonFashion(text);
  if (nonFashion) return { type: 'non-fashion', message: nonFashion };

  const metadata = parseMetadata(text);
  if (metadata.category || metadata.color || metadata.silhouette) {
    return { type: 'fashion', result: stripMetadataFromResult(text) || text, metadata };
  }

  // Attempt 4b: prose metadata repair.
  // When all JSON extraction and legacy-format attempts fail, try to extract
  // structured metadata from the prose text before the prose-only fallback fires.
  // This catches cases where the AI ignores the JSON-only instruction.
  if (text.length > 30) {
    const proseMeta = extractMetadataFromProse(text);
    if (proseMeta) {
      logPipelineEvent('PROSE_REPAIR_SUCCESS', {
        provider:   context.provider,
        category:   proseMeta.category,
        color:      proseMeta.color,
        silhouette: proseMeta.silhouette,
        preview:    previewProviderText(text, 200),
      });
      return {
        type:   'fashion',
        result: stripMetadataFromResult(text) || text,
        metadata: proseMeta,
      };
    }
  }

  // Attempt 5: prose-only fallback — emit full text as result with observability.
  // PROSE_FALLBACK fires ONLY after all structured extraction and repair attempts fail.
  if (text.length > 30) {
    logPipelineEvent('PROSE_FALLBACK', {
      provider:       context.provider,
      reason:         'NO_STRUCTURED_FIELDS',
      repairAttempts: context.repairAttempts || 0,
      preview:        previewProviderText(text, 200),
    });
    aiLog('warn', '[K-SCAN] No structured fields found in AI response; using full text as result', {
      provider: context.provider,
      responseLength: text.length,
      preview: previewProviderText(text, 500),
    });
    return {
      type:     'fashion',
      result:   text,
      metadata: { category: '', color: '', silhouette: '' },
    };
  }

  return null; // genuinely empty
}

// ── CORS: restrict in production — open for local dev ─────────────────────────
// For a hosted beta backend, replace '*' with your actual app origin
// (e.g. the Expo Go deep-link or your hosted frontend domain).
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';
app.use(cors({ origin: CORS_ORIGIN }));
app.all('/catalog-images/*', (_req, res) => res.status(410).json({
  status: 'FAILED',
  error: 'LEGACY_CATALOG_DISABLED',
}));

// Permanent tombstone for the retired public analysis surface. Keep this before
// JSON parsing so request bodies are neither parsed nor logged. This handler does
// not authenticate, invoke a provider, or call next().
app.all('/api/analyze', (_req, res) => res.status(410).json({
  status: 'FAILED',
  error: 'LEGACY_ANALYZE_DISABLED',
  message: 'This legacy analysis route is no longer available.',
}));

function requireInternalEmailAuth(req, res, next) {
  const configuredSecret = process.env.KSCAN_EMAIL_INTERNAL_SECRET;
  if (!configuredSecret || !process.env.RESEND_API_KEY) {
    return res.status(503).json({ status: 'error', code: 'EMAIL_SERVICE_NOT_CONFIGURED' });
  }
  if (!secretsMatch(req.headers['x-kscan-email-secret'], configuredSecret)) {
    return res.status(401).json({ status: 'error', code: 'UNAUTHORIZED' });
  }
  return next();
}

app.post(
  '/internal/email/waitlist-welcome',
  requireInternalEmailAuth,
  express.json({ limit: '8kb' }),
  async (req, res) => {
    const validated = validateWaitlistWelcomeRequest(req.body);
    if (!validated.ok) {
      return res.status(400).json({ status: 'error', code: validated.code });
    }
    const result = await sendWaitlistWelcomeEmail(validated.value);
    const statusCode = result.status === 'sent' ? 200 : result.status === 'failed_retryable' ? 503 : 422;
    return res.status(statusCode).json({ status: result.status, eventType: validated.value.eventType, code: result.code });
  },
);

app.use('/internal/email/waitlist-welcome', (error, _req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ status: 'error', code: 'INVALID_JSON' });
  }
  return next(error);
});

app.post(
  '/internal/email/account-deletion-restoration',
  requireInternalEmailAuth,
  express.json({ limit: '16kb' }),
  async (req, res) => {
    const validated = validateAccountDeletionRestorationRequest(req.body);
    if (!validated.ok) {
      return res.status(400).json({ status: 'error', code: validated.code });
    }
    const result = await sendAccountDeletionRestorationEmail(validated.value);
    const statusCode = result.status === 'sent' ? 200 : result.status === 'failed_retryable' ? 503 : 422;
    return res.status(statusCode).json({
      status: result.status,
      eventType: validated.value.eventType,
      kind: validated.value.kind,
      code: result.code,
    });
  },
);

app.use('/internal/email/account-deletion-restoration', (error, _req, res, next) => {
  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ status: 'error', code: 'INVALID_JSON' });
  }
  return next(error);
});

// Body size: 15 MB hard cap. Raw image from expo-image-manipulator at 1024px
// JPEG quality 0.7 is ~200–400 KB base64-encoded (~1.3× raw), so 15 MB provides
// ample headroom while preventing abuse.
app.use(express.json({ limit: '15mb' }));

function extractImageParts(imageInput) {
  if (!imageInput || typeof imageInput !== 'string') {
    return { mimeType: '', data: '' };
  }
  const match = imageInput.match(/^data:(image\/[\w.+-]+);base64,(.+)$/);
  if (match) {
    return { mimeType: match[1], data: match[2] };
  }
  return { mimeType: 'image/jpeg', data: imageInput };
}

function parseMetadata(text) {
  const category = (text.match(/Category:\s*(.+?)(?=\n|$)/i) || [])[1]?.trim() || '';
  const color    = (text.match(/Color:\s*(.+?)(?=\n|$)/i)    || [])[1]?.trim() || '';
  const silhouette = (text.match(/Silhouette:\s*(.+?)(?=\n|$)/i) || [])[1]?.trim() || '';
  return { category, color, silhouette };
}

function stripMetadataFromResult(text) {
  return text
    .replace(/\n\s*Category:\s*[^\n]+/gi, '')
    .replace(/\n\s*Color:\s*[^\n]+/gi, '')
    .replace(/\n\s*Silhouette:\s*[^\n]+/gi, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function checkNonFashion(text) {
  const match = text.match(/^NON_FASHION:\s*(.+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Call OpenRouter and return { parsed, rawText } or null on error.
 * options.temperature  – passed to the model (default 0.4; use 0.1 for repair).
 * options.systemPrompt – overrides SYSTEM_PROMPT (use REPAIR_SYSTEM_PROMPT for retry).
 * options.isRetry      – for logging only; does not affect the API call.
 *
 * Retry policy (enforced by caller): at most 1 additional call per request,
 * only when first response produces empty metadata. No conversational context added.
 */
async function callOpenRouter(mimeType, data, options = {}) {
  const {
    temperature  = 0.4,
    systemPrompt = SYSTEM_PROMPT,
    isRetry      = false,
    // Budget-based timeout: primary gets 11 s; retry gets whatever remains
    // (capped at 3 s). Both combined stay within the 14.5 s server budget.
    timeoutMs    = 11000,
  } = options;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      },
      body: JSON.stringify({
        model:       OPENROUTER_MODEL,
        temperature,
        messages: [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Analyze this garment image.' },
              { type: 'image_url', image_url: { url: `data:${mimeType || 'image/jpeg'};base64,${data}` } },
            ],
          },
        ],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    console.log('[K-SCAN] OpenRouter HTTP status:', res.status);

    if (!res.ok) {
      let errBody;
      try { errBody = await res.json(); } catch (_) { errBody = {}; }
      const errMsg = errBody?.error?.message || errBody?.error || `OpenRouter HTTP ${res.status}`;
      console.error('[K-SCAN] OpenRouter error response:', JSON.stringify(errBody).slice(0, 400));
      throw new Error(String(errMsg));
    }

    const json = await res.json();
    // content may be a string (standard) or array of parts (some providers).
    const contentRaw = json?.choices?.[0]?.message?.content;
    const rawText = (
      typeof contentRaw === 'string'
        ? contentRaw
        : Array.isArray(contentRaw)
          ? contentRaw
              .map((part) => part?.text ?? part?.content ?? '')
              .filter(Boolean)
              .join('\n')
          : ''
    ).trim();

    const finishReason = json?.choices?.[0]?.finish_reason ?? 'unknown';
    console.log(`[K-SCAN] OpenRouter rawText length: ${rawText.length}  finish_reason: ${finishReason}`);
    if (DEV_PROVIDER_LOGS && DEBUG) console.warn('[K-SCAN] OpenRouter rawText preview:', previewProviderText(rawText, 1000));

    if (!rawText) {
      console.warn('[K-SCAN] OpenRouter returned empty content. finish_reason:', finishReason,
        '  model:', OPENROUTER_MODEL,
        '  usage:', JSON.stringify(json?.usage ?? {}));
      return null;
    }

    const parsed = parseAIResponse(rawText, { provider: 'OpenRouter', isRetry });
    if (!parsed) {
      aiLog('warn', '[K-SCAN] parseAIResponse returned null for non-empty OpenRouter rawText', {
        provider: 'OpenRouter',
        responseLength: rawText.length,
        preview: previewProviderText(rawText, 1000),
      });
    }
    // Return both the parsed result and the raw text so the caller can decide
    // whether a retry is warranted (e.g. empty metadata despite non-null parse).
    return { parsed, rawText };
  } catch (err) {
    clearTimeout(timeout);
    aiLog('error', '[K-SCAN] OpenRouter provider exception', {
      provider: 'OpenRouter',
      model: OPENROUTER_MODEL,
      message: err?.message,
      name: err?.name,
    });
    throw err;
  }
}

app.get('/api/health', (req, res) => {
  // Diagnostic headers on health endpoint — required by qa:convergence.
  // In production, emitted only when X-KScan-Validation-Auth is correct.
  if (shouldEmitDiagnostics(req)) {
    res.set({
      'X-KScan-Parser-Version':        PARSER_VERSION,
      'X-KScan-Normalization-Version': NORMALIZATION_VERSION,
      'X-KScan-Prompt-Version':        PROMPT_VERSION,
      'X-KScan-Deployed-Commit':       DEPLOYED_COMMIT,
    });
  }

  if (process.env.NODE_ENV === 'production') {
    return res.json({ ok: true });
  }
  return res.json({
    ok: true,
    service: 'kscan-backend',
    hasGeminiKey: !!process.env.GEMINI_API_KEY && process.env.GEMINI_API_KEY.length > 0,
    hasOpenRouterKey: !!process.env.OPENROUTER_API_KEY && process.env.OPENROUTER_API_KEY.length > 0,
    useOpenRouter: USE_OPENROUTER,
    allowDevFallback: ALLOW_DEV_FALLBACK,
  });
});

// ── Request validation helpers ────────────────────────────────────────────────
const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);
// Base64-encoded limit: 15 MB raw ≈ 20 MB base64. Express 15 MB body limit is
// the effective cap; this validator catches malformed requests that bypass it.
const MAX_BASE64_BYTES = 20 * 1024 * 1024; // 20 MB base64 character budget

function validateImageInput(image) {
  if (!image || typeof image !== 'string') {
    return 'No image data received. Please try taking the photo again.';
  }
  if (image.length > MAX_BASE64_BYTES) {
    return 'Image is too large. Please try again with a smaller photo.';
  }
  const { mimeType, data } = extractImageParts(image);
  if (!data) {
    return 'Image data could not be read. Please try taking the photo again.';
  }
  if (mimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
    return `Unsupported image format (${mimeType}). Please use JPEG or PNG.`;
  }
  return null; // valid
}

// Historical implementation retained temporarily as non-exported evidence only.
// It is not registered with Express and cannot receive requests.
async function retiredAnalyzeHandler(req, res) {
  try {
    console.log('[K-SCAN] /api/analyze hit');
    if (DEBUG) {
      console.log('[K-SCAN] body keys:', Object.keys(req.body || {}));
      console.log('[K-SCAN] image type:', typeof req.body?.image);
      console.log('[K-SCAN] image length:', req.body?.image?.length || 0);
    }

    const { image } = req.body;

    const validationError = validateImageInput(image);
    if (validationError) {
      return res.status(400).json({
        result: validationError,
        metadata: { category: '', color: '', silhouette: '' },
        products: [],
      });
    }

    const { mimeType, data } = extractImageParts(image);

    if (DEBUG) {
      console.log('[K-SCAN] extracted mimeType:', mimeType);
      console.log('[K-SCAN] extracted data length:', data?.length || 0);
    }

    // ── Always log the image receipt so failures are diagnosable ───────────────
    console.log(`[K-SCAN] image received — mimeType: ${mimeType || '(none)'}  dataLen: ${data?.length ?? 0}`);

    // ── Diagnostic response headers ───────────────────────────────────────────
    // Never in response body. In production: only when VALIDATION_SECRET_KEY auth
    // header matches. In non-production: always emitted. See shouldEmitDiagnostics().
    const emitDiag = shouldEmitDiagnostics(req);
    if (emitDiag) {
      res.set({
        'X-KScan-Parser-Version':        PARSER_VERSION,
        'X-KScan-Normalization-Version': NORMALIZATION_VERSION,
        'X-KScan-Prompt-Version':        PROMPT_VERSION,
        'X-KScan-Deployed-Commit':       DEPLOYED_COMMIT,
      });
    }

    // ── Server-side latency tracking ──────────────────────────────────────────
    // Measures request_entry → response_send to exclude client network variability.
    const reqStart  = Date.now();
    let   retried   = false;
    res.on('finish', () => {
      const latencyMs = Date.now() - reqStart;
      console.log(
        `[K-SCAN METRICS] latency=${latencyMs}ms status=${res.statusCode}` +
        ` retry=${retried ? 1 : 0} provider=${USE_OPENROUTER ? 'OpenRouter' : 'Gemini'}`
      );
      if (retried) logPipelineEvent('RETRY_METRIC', { latencyMs, status: res.statusCode });
      if (latencyMs > 15000) console.warn('[K-SCAN METRICS] WARNING: p95 exceeded 15 s ceiling');
    });

    // ── Budget constants ──────────────────────────────────────────────────────
    // Primary gets 11 s; retry gets what remains up to a 3 s cap.
    // Combined max: 14 s + overhead, safely within the 15 s server ceiling.
    const SERVER_BUDGET_MS = 14500;
    const PRIMARY_TIMEOUT_MS = 11000;

    if (USE_OPENROUTER) {
      console.log('[K-SCAN] Provider: OpenRouter  model:', OPENROUTER_MODEL);

      // First attempt — normal temperature, standard system prompt.
      const firstCall = await callOpenRouter(mimeType, data, { timeoutMs: PRIMARY_TIMEOUT_MS });
      let orResult = firstCall?.parsed;

      // Conditional retry — at most 1 additional call per request.
      // Triggered when the first response produces empty metadata (prose fallback
      // fired or parse returned null). Uses lower temperature + strict schema prompt.
      // Retry only runs if the remaining time budget allows >= 2 s.
      const hasEmptyMeta = !orResult || (!orResult.metadata?.category && !orResult.metadata?.color);
      const elapsed      = Date.now() - reqStart;
      const retryBudget  = SERVER_BUDGET_MS - elapsed - 200; // 200 ms overhead reserve
      if (hasEmptyMeta && retryBudget >= 2000) {
        retried = true;
        logPipelineEvent('RETRY_TRIGGERED', {
          provider:     'OpenRouter',
          reason:       'EMPTY_METADATA_AFTER_REPAIR',
          retryBudget:  retryBudget,
          preview:      previewProviderText(firstCall?.rawText, 200),
        });
        console.log(`[K-SCAN] OpenRouter retry: temperature=0.1 budget=${retryBudget}ms`);
        const retryCall = await callOpenRouter(mimeType, data, {
          temperature:  0.1,
          systemPrompt: REPAIR_SYSTEM_PROMPT,
          isRetry:      true,
          timeoutMs:    Math.min(retryBudget, 3000),
        });
        if (retryCall?.parsed &&
            (retryCall.parsed.type === 'non-fashion' || retryCall.parsed.metadata?.category)) {
          orResult = retryCall.parsed;
        }
      }

      if (emitDiag) {
        res.set('X-KScan-Retry-Triggered', retried ? '1' : '0');
      }

      if (orResult) {
        if (orResult.type === 'non-fashion') {
          console.log('[K-SCAN] Result: NON_FASHION — suppressing product matching');
          console.log('[K-SCAN] Final response status: 200 NON_FASHION');
          return res.status(200).json({ ...orResult, products: [] });
        }
        console.log('[K-SCAN] Result: fashion  category:', orResult.metadata?.category, ' color:', orResult.metadata?.color);
        console.log('[K-SCAN] Final response status: 200 fashion');
        return res.status(200).json({ ...orResult, products: matchProducts(orResult.metadata) });
      }
      // All attempts produced no usable content
      console.warn('[K-SCAN] FAILED: OpenRouter returned no usable content for this image');
      if (ALLOW_DEV_FALLBACK) return res.status(200).json(DEV_FALLBACK);
      console.warn('[K-SCAN] Final response status: 503 FAILED AI_PROVIDER_UNAVAILABLE');
      return res.status(503).json({ status: 'FAILED', error: 'AI_PROVIDER_UNAVAILABLE', message: 'Style-Parse could not complete.' });
    }

    console.log('[K-SCAN] Provider: Gemini');
    if (!GEMINI_API_KEY) {
      console.error('[K-SCAN] Missing GEMINI_API_KEY');
      if (ALLOW_DEV_FALLBACK) return res.status(200).json(DEV_FALLBACK);
      return res.status(503).json({ status: 'FAILED', error: 'AI_PROVIDER_UNAVAILABLE', message: 'Style-Parse could not complete.' });
    }

    const geminiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;

    const geminiController = new AbortController();
    const geminiTimeout = setTimeout(() => geminiController.abort(), 20000);

    const geminiRes = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: SYSTEM_PROMPT },
              { inline_data: { mime_type: mimeType || 'image/jpeg', data } },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1024,
          topP:          0.95,
        },
      }),
      signal: geminiController.signal,
    });
    clearTimeout(geminiTimeout);

    const geminiJson = await geminiRes.json();
    console.log('[K-SCAN] Gemini HTTP status:', geminiRes.status);

    if (!geminiRes.ok) {
      const message = geminiJson?.error?.message || `Gemini API error: ${geminiRes.status}`;
      console.error('[K-SCAN] Gemini error:', message);
      if (ALLOW_DEV_FALLBACK) return res.status(200).json(DEV_FALLBACK);
      console.warn('[K-SCAN] Final response status: 503 FAILED AI_PROVIDER_UNAVAILABLE');
      return res.status(503).json({ status: 'FAILED', error: 'AI_PROVIDER_UNAVAILABLE', message: 'Style-Parse could not complete.' });
    }

    const textPart = geminiJson?.candidates?.[0]?.content?.parts?.[0];
    const rawText  = typeof textPart?.text === 'string' ? textPart.text.trim() : '';
    const blockReason =
      geminiJson?.promptFeedback?.blockReason ||
      geminiJson?.candidates?.[0]?.finishReason;

    console.log(`[K-SCAN] Gemini rawText length: ${rawText.length}  blockReason: ${blockReason ?? 'none'}`);
    if (DEV_PROVIDER_LOGS && DEBUG) console.warn('[K-SCAN] Gemini rawText preview:', previewProviderText(rawText, 1000));

    if (rawText) {
      const parsed = parseAIResponse(rawText, { provider: 'Gemini' });
      if (parsed) {
        if (parsed.type === 'non-fashion') {
          console.log('[K-SCAN] Result: NON_FASHION');
          console.log('[K-SCAN] Final response status: 200 NON_FASHION');
          return res.status(200).json({ ...parsed, products: [] });
        }
        console.log('[K-SCAN] Result: fashion  metadata:', JSON.stringify(parsed.metadata));
        console.log('[K-SCAN] Final response status: 200 fashion');
        return res.status(200).json({ ...parsed, products: matchProducts(parsed.metadata) });
      }
      aiLog('warn', '[K-SCAN] parseAIResponse returned null for non-empty Gemini rawText', {
        provider: 'Gemini',
        responseLength: rawText.length,
        preview: previewProviderText(rawText, 1000),
      });
    }

    if (blockReason && blockReason !== 'STOP') {
      console.warn('[K-SCAN] Final response status: 200 blocked', blockReason);
      return res.status(200).json({
        result:   `Analysis was not generated (${blockReason}). Try a different photo.`,
        metadata: { category: '', color: '', silhouette: '' },
        products: [],
      });
    }

    console.warn('[K-SCAN] Final response status: 200 empty-analysis-fallback');
    return res.status(200).json({
      result:   "AI couldn't describe this look. Try a clearer, full-outfit photo.",
      metadata: { category: '', color: '', silhouette: '' },
      products: [],
    });

  } catch (error) {
    if (error.name === 'AbortError') {
      console.warn('[K-SCAN] Final response status: 504 timeout');
      return res.status(504).json({
        result: 'Analysis timed out on the server. Please try again.',
        metadata: { category: '', color: '', silhouette: '' },
        products: [],
      });
    }
    console.error('[K-SCAN] Server error message:', error?.message);
    console.log('[K-SCAN] DEV_FALLBACK branch: OUTER_SERVER_EXCEPTION');
    if (ALLOW_DEV_FALLBACK) return res.status(200).json(DEV_FALLBACK);
    console.warn('[K-SCAN] Final response status: 500 FAILED AI_PROVIDER_UNAVAILABLE');
    return res.status(500).json({ status: 'FAILED', error: 'AI_PROVIDER_UNAVAILABLE', message: 'Style-Parse could not complete.' });
  }
}

if (require.main === module) {
  // Bind to 0.0.0.0 so the server is reachable from:
  //   - Android emulator via 10.0.2.2
  //   - Physical devices on the same LAN via the machine's LAN IP
  //   - localhost for iOS simulator
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`[K-SCAN] Server listening on 0.0.0.0:${PORT}`);
    console.log(`[K-SCAN]   iOS simulator:    http://localhost:${PORT}`);
    console.log(`[K-SCAN]   Android emulator: http://10.0.2.2:${PORT}`);
    console.log(`[K-SCAN]   Physical device:  http://<YOUR-LAN-IP>:${PORT}`);
    console.log('[K-SCAN]   Set EXPO_PUBLIC_API_URL in .env to match your target.');
  });
}

module.exports = {
  app,
  parseAIResponse,
  extractMetadataFromProse,
  normalizeAttributeValue,
  enforceCanonicalSchema,
  resolveCompoundValue,
  CATEGORY_CANONICAL,
  SILHOUETTE_CANONICAL,
  COLOR_ALIASES,
  SILHOUETTE_ALIASES,
  PARSER_VERSION,
  NORMALIZATION_VERSION,
  PROMPT_VERSION,
  DEPLOYED_COMMIT,
  matchProducts,
  CONFIDENCE_THRESHOLD,
  WEIGHTS,
};
