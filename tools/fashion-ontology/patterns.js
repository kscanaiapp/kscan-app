'use strict';

/**
 * Pattern vocabulary (spec section 11) — the task's own list, almost
 * verbatim, plus retail-standard aliases (evidence:
 * tools/canonical-product-identity/lib/fashionWorld.js uses 'houndstooth'
 * and 'pinstripe' as jacket patterns, both folded into `plaid_check` /
 * `graphic` respectively per common retail taxonomy rather than given their
 * own canonical values — V1 does not overbuild ahead of evidence).
 */
const CANONICAL_PATTERNS = Object.freeze([
  { value: 'solid', aliases: ['solid', 'plain'] },
  { value: 'stripe', aliases: ['stripe', 'striped', 'stripes', 'pinstripe'] },
  { value: 'plaid_check', aliases: ['plaid', 'check', 'checked', 'checkered', 'tartan', 'gingham', 'houndstooth'] },
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
    // (e.g. 'plaid_check') isn't one of its own human-readable aliases.
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
