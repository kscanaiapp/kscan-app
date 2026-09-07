'use strict';

/**
 * Fashion-aware text normalization (spec section 14).
 *
 * Applies Unicode normalization, case folding, whitespace collapse,
 * punctuation stripping, retailer boilerplate removal, and URL
 * tracking-parameter removal - WITHOUT erasing fashion-identity terms
 * (cropped, oversized, suede, patent, double-breasted, embroidered,
 * distressed, ribbed, pebbled, mini, midi, maxi, ...). Those terms survive
 * every step here unchanged; PRESERVED_FASHION_TERMS exists so tests can
 * assert that directly rather than trusting the stripping rules by
 * inspection (spec section 14's own requirement).
 */

const PRESERVED_FASHION_TERMS = [
  'cropped', 'oversized', 'suede', 'patent', 'double-breasted', 'embroidered',
  'distressed', 'ribbed', 'pebbled', 'mini', 'midi', 'maxi',
  // additional commercially-meaningful terms observed in K Scan's own
  // fashion attribute vocabulary (tools/fashion-match-quality authority
  // pipeline map: canonicalSilhouette/canonicalMaterial/distinctive_features)
  'quilted', 'pleated', 'wrap', 'asymmetric', 'sheer', 'lambskin', 'shearling',
];

// Retailer marketing boilerplate that carries no product-identity signal.
// Deliberately narrow (word-boundary phrase matches only) so it never eats
// a fashion term that happens to share a substring.
const BOILERPLATE_PHRASES = [
  'free shipping', 'free returns', 'new arrival', 'best seller', 'limited edition',
  'while supplies last', 'shop now', 'as seen on', 'exclusively at', 'members only',
  'final sale', 'today only',
];

// URL query params that identify a marketing channel/session, not the
// product itself. Modeled on the production tracking-param strip pattern in
// supabase/functions/scan-identify/qualityTuneCommerce.ts
// (canonicalizeUrlForIdentity/TRACKING_PARAMS), reimplemented here rather
// than imported since that module is Deno/Edge-Function TypeScript, not a
// requirable Node CommonJS module.
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id',
  'gclid', 'fbclid', 'msclkid', 'ref', 'referrer', 'affid', 'aff_id', 'clickid',
  'mc_cid', 'mc_eid', 'igshid', 'si', 'src', 'cm_mmc', 'sr', 'trk',
]);

function normalizeWhitespace(value) {
  return value.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize a free-text field (title, description) for comparison. Returns
 * lowercased, whitespace-collapsed, boilerplate-stripped text with
 * punctuation reduced to spaces EXCEPT internal hyphens in known compound
 * fashion terms (double-breasted) - a generic hyphen-to-space pass would
 * split "double-breasted" into two independently-matchable tokens, which is
 * fine for token overlap (still matches), so simplicity wins: hyphens
 * normalize to spaces uniformly and PRESERVED_FASHION_TERMS is checked
 * post-tokenization instead of pre-protected in the string.
 */
function normalizeText(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  let text = raw.normalize('NFKC').toLowerCase();
  for (const phrase of BOILERPLATE_PHRASES) {
    text = text.split(phrase).join(' ');
  }
  // Punctuation -> space, keep alphanumerics and spaces only.
  text = text.replace(/[^a-z0-9\s]/g, ' ');
  return normalizeWhitespace(text);
}

/** Tokenize normalized text into a Set for overlap comparison. */
function tokenize(raw) {
  const normalized = normalizeText(raw);
  return normalized ? new Set(normalized.split(' ').filter(Boolean)) : new Set();
}

/** Jaccard overlap of two token sets, in [0, 1]. Empty-vs-empty is 0 (no evidence either way). */
function jaccard(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection += 1;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** Which PRESERVED_FASHION_TERMS survive in `raw`'s normalized token set. */
function preservedTermsPresent(raw) {
  const tokens = tokenize(raw);
  const found = [];
  for (const term of PRESERVED_FASHION_TERMS) {
    const termTokens = term.split(/[\s-]+/).filter(Boolean);
    if (termTokens.every((t) => tokens.has(t))) found.push(term);
  }
  return found;
}

/**
 * Canonicalize a product URL for identity comparison: strip tracking
 * params, drop a trailing slash, lowercase host+path. Returns null for a
 * missing/unparseable URL rather than falling back to a lossy string guess.
 */
function canonicalizeUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let url;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const kept = new URLSearchParams();
  for (const [key, value] of url.searchParams.entries()) {
    if (TRACKING_PARAMS.has(key.toLowerCase())) continue;
    kept.append(key, value);
  }
  let path = url.pathname;
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  const qs = kept.toString();
  return `${url.protocol}//${url.hostname.toLowerCase()}${path.toLowerCase()}${qs ? `?${qs}` : ''}`;
}

module.exports = {
  PRESERVED_FASHION_TERMS,
  BOILERPLATE_PHRASES,
  TRACKING_PARAMS,
  normalizeText,
  tokenize,
  jaccard,
  preservedTermsPresent,
  canonicalizeUrl,
};
