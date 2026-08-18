/**
 * Backend Commerce Retrieval Enrichment control (v125).
 *
 * Builds on v124 commerce identity:
 *   retrieval OFF → exact v124 behavior (queries byte-identical)
 *   retrieval ON  → confidence-aware query strategy selection that spends the
 *                   same bounded query budget on commercial identity first
 *
 * Rollback without redeploy: set BACKEND_COMMERCE_RETRIEVAL_V125_ENABLED=false.
 *
 * Independent of the v124 flag on purpose: `v124 ON + v125 OFF` must stay a
 * valid configuration, so identity-aware *ranking* can ship without
 * identity-aware *retrieval*. v125 additionally requires v124 (it consumes
 * v124's graded evidence), but never the reverse.
 *
 * Scope boundary — v125 changes WHAT is asked, not HOW MANY times:
 *   one primary query plus the existing conditional fallback, same providers,
 *   same order, same timeouts, same concurrency, same early-exit threshold.
 *   Multi-hypothesis fan-out is a later Fix #9 phase.
 */

export const COMMERCE_RETRIEVAL_VERSION = 'v125';

/**
 * Default OFF: this layer has not yet completed staging validation, and the env
 * override is the documented activation path. Flip this constant (or set the
 * env var) once v125 has been validated on App Staging.
 *
 *   BACKEND_COMMERCE_RETRIEVAL_V125_ENABLED=true  → enabled
 *   BACKEND_COMMERCE_RETRIEVAL_V125_ENABLED=false → disabled (exact v124 queries)
 */
export const COMMERCE_RETRIEVAL_DEFAULT_ENABLED = false;

/**
 * Bounded query-strategy classification. Used for tests and scrubbed telemetry;
 * never emitted to the client and never part of a provider request.
 *
 *   exact_identity    — a supported product/model hypothesis drives the query
 *   brand_distinctive — brand is usable but the model hypothesis is not
 *   attribute_only    — no usable commercial identity; fashion attributes only
 *   fallback          — the brand-neutral secondary query
 */
export type CommerceQueryStrategy =
  | 'exact_identity'
  | 'brand_distinctive'
  | 'attribute_only'
  | 'fallback';

/**
 * Distinctive construction terms are high-signal but expensive: each one spends
 * scarce query budget. Two is the most that can earn its place alongside brand,
 * model, garment, and material.
 */
export const MAX_QUERY_DISTINCTIVE_FEATURES = 2;

/** A feature phrase longer than this is prose, not a search term. */
export const MAX_QUERY_FEATURE_WORDS = 3;

/**
 * Construction / hardware / closure vocabulary. A distinctive feature earns a
 * place in the query only if it contains one of these — an asymmetric zipper
 * discriminates between listings; clean lines do not.
 *
 * NOTE: keep quoted example phrases out of these comments. The governed
 * edge-function manifest generator scrapes import specifiers with a regex that
 * does not skip comments, so a quoted phrase following the import keyword is
 * recorded as a bogus module specifier and fails the parity gate.
 */
export const HIGH_SIGNAL_FEATURE_TOKENS: ReadonlySet<string> = new Set([
  // closures and fastening
  'zipper', 'zip', 'zips', 'asymmetric', 'asymmetrical', 'buckle', 'buckles',
  'clasp', 'turnlock', 'toggle', 'snap', 'drawstring', 'lace-up', 'button',
  'double-breasted', 'single-breasted', 'wrap', 'corset',
  // hardware and trim
  'hardware', 'stud', 'studs', 'studded', 'grommet', 'grommets', 'eyelet',
  'eyelets', 'chain', 'ring', 'o-ring', 'd-ring', 'rivet', 'rivets',
  // construction and paneling
  'quilted', 'quilting', 'paneled', 'panelled', 'paneling', 'panelling',
  'panel', 'panels', 'stitching', 'topstitching', 'seam', 'seams', 'pleated',
  'ruched', 'gathered', 'cutout', 'cutouts', 'patchwork', 'fringe', 'fringed',
  'embossed', 'woven', 'intrecciato', 'perforated', 'padded',
  // silhouette-defining details
  'belted', 'hem', 'cuffs', 'cuff', 'collar', 'lapel', 'lapels', 'notch',
  'peak', 'epaulette', 'epaulettes', 'halter', 'peplum',
  // pockets and handles
  'pocket', 'pockets', 'welt', 'flap', 'cargo', 'patch', 'handle', 'handles',
  'top-handle', 'strap', 'straps', 'crossbody',
  // footwear-specific construction
  'platform', 'lug', 'cap-toe', 'wingtip', 'slingback', 'ankle-strap',
  'stiletto', 'kitten', 'sole', 'welted',
  // print / monogram identity
  'monogram', 'monogrammed', 'logo', 'jacquard', 'intarsia',
]);

/**
 * Marketing adjectives that must never consume query budget. Deliberately wider
 * than the shared FILLER set, which exists to clean up phrasing rather than to
 * reject low-value search terms.
 */
export const GENERIC_FEATURE_TOKENS: ReadonlySet<string> = new Set([
  'stylish', 'luxury', 'luxurious', 'designer', 'fashionable', 'premium',
  'trendy', 'chic', 'elegant', 'modern', 'classic', 'versatile', 'timeless',
  'beautiful', 'gorgeous', 'quality', 'sophisticated', 'refined', 'sleek',
  'contemporary', 'statement', 'iconic', 'signature', 'essential', 'everyday',
  'clean', 'simple', 'minimal', 'minimalist', 'aesthetic', 'vibes', 'look',
  'inspired', 'vintage', 'high-end', 'oversized', 'boyfriend',
]);

/**
 * Patterns that genuinely narrow a commerce search. "solid" is excluded by
 * design: it describes the absence of a pattern and only wastes budget.
 */
export const DISCRIMINATING_PATTERN_TOKENS: ReadonlySet<string> = new Set([
  'houndstooth', 'monogram', 'paisley', 'checkerboard', 'checked', 'check',
  'gingham', 'plaid', 'tartan', 'striped', 'stripe', 'stripes', 'pinstripe',
  'floral', 'polka', 'dot', 'dots', 'leopard', 'zebra', 'snakeskin', 'python',
  'croc', 'crocodile', 'camo', 'camouflage', 'argyle', 'herringbone', 'tweed',
  'quilted', 'colorblock', 'color-block', 'ombre', 'tie-dye', 'animal',
  'geometric', 'chevron', 'jacquard', 'damask', 'toile', 'logo',
]);

/** Catalog categories `normalizeCategory` can resolve to. */
export const KNOWN_CATALOG_CATEGORIES: ReadonlySet<string> = new Set([
  'blazer', 'outerwear', 'dress', 'pants', 'top', 'footwear', 'bag', 'accessory',
]);

export function isCommerceRetrievalEnabled(
  envGet: (key: string) => string | undefined = (key) => {
    try {
      return Deno.env.get(key);
    } catch {
      return undefined;
    }
  },
): boolean {
  const raw = envGet('BACKEND_COMMERCE_RETRIEVAL_V125_ENABLED')?.trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') return true;
  return COMMERCE_RETRIEVAL_DEFAULT_ENABLED;
}

export function commerceRetrievalTreatmentBucket(
  enabled: boolean,
): 'commerce_retrieval_on' | 'commerce_retrieval_off' {
  return enabled ? 'commerce_retrieval_on' : 'commerce_retrieval_off';
}
