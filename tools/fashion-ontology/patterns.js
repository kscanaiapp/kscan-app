'use strict';

/**
 * Pattern vocabulary (spec section 11) — the task's own list, plus
 * retail-standard variants, bounded and testable.
 *
 * SEMANTIC HARDENING PASS (before this ontology becomes ground truth for
 * Real Fashion Corpus). The original V1 pass folded `houndstooth`,
 * `gingham`, `tartan`, `check`, and `pinstripe` all into one
 * `plaid_check` value. That was an unsafe collapse under the doctrine
 * ("a hard alias should not erase a distinction likely to matter to visual
 * matching"): houndstooth's broken-check silhouette, gingham's small even
 * two-tone check, and a woven multi-color tartan/plaid are visually and
 * commercially distinct patterns — a shopper (or a matching pipeline)
 * comparing a houndstooth blazer to a tartan one is comparing different
 * products, not synonyms. Likewise `pinstripe` (fine, closely-spaced
 * suiting stripes) is visually and commercially distinct from a generic
 * bold `stripe`.
 *
 * RETAINED as a justified hard alias: `plaid` merges with `tartan` — in
 * US retail usage "plaid" is near-universally used as the name for a
 * tartan-style woven check, not a visually distinct pattern from it.
 * `check`/`checked`/`checkered` stay merged with each other (pure surface
 * variants of one word), but are now their own value distinct from
 * `plaid`/`tartan` and from `gingham`'s specific small even check.
 */
const CANONICAL_PATTERNS = Object.freeze([
  { value: 'solid', aliases: ['solid', 'plain'] },
  { value: 'stripe', aliases: ['stripe', 'striped', 'stripes'] },
  // Split from `stripe`: fine, closely-spaced suiting stripes read as a
  // different pattern than a generic bold stripe.
  { value: 'pinstripe', aliases: ['pinstripe'] },
  // Split out of the old `plaid_check`: a woven multi-color crossing
  // pattern. Tartan merges in as the near-universal US retail synonym.
  { value: 'plaid', aliases: ['plaid', 'tartan'] },
  // Split out of the old `plaid_check`: a generic even check, distinct
  // from plaid's multi-color weave and from gingham's specific small
  // two-tone check.
  { value: 'check', aliases: ['check', 'checked', 'checkered'] },
  // Split out of the old `plaid_check`: a specific, commercially
  // well-known small even bi-color check — not the same pattern as a
  // generic "check" or a woven plaid.
  { value: 'gingham', aliases: ['gingham'] },
  // Split out of the old `plaid_check`: houndstooth's broken-check
  // silhouette is visually distinct from plaid, check, and gingham alike.
  { value: 'houndstooth', aliases: ['houndstooth'] },
  { value: 'floral', aliases: ['floral', 'flower print', 'flowers'] },
  { value: 'polka_dot', aliases: ['polka dot', 'polka-dot', 'polka dots', 'dots', 'dotted'] },
  {
    value: 'animal_print',
    aliases: ['animal print', 'leopard', 'leopard print', 'zebra print', 'snake print', 'python print'],
  },
  { value: 'graphic', aliases: ['graphic', 'graphic print', 'logo print'] },
  { value: 'geometric', aliases: ['geometric', 'geo print'] },
]);

function buildPatternAliasMap() {
  const map = Object.create(null);
  for (const pattern of CANONICAL_PATTERNS) {
    // A canonical value always resolves to itself, so canonicalizing an
    // already-canonical value is idempotent even when the value itself
    // isn't one of its own human-readable aliases.
    map[pattern.value] = pattern.value;
    for (const alias of pattern.aliases) {
      map[alias] = pattern.value;
    }
  }
  return Object.freeze(map);
}

const PATTERN_ALIASES = buildPatternAliasMap();

module.exports = {
  CANONICAL_PATTERNS,
  PATTERN_ALIASES,
};
