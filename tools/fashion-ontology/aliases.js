'use strict';

/**
 * Thin aggregator over each domain module's alias table. Nothing here is a
 * second source of truth — every map is re-exported from the module that
 * owns it (categories.js, colors.js, materials.js, patterns.js,
 * silhouettes.js). This exists so tooling (tests, the negative-control
 * mutation, future consumers) has one place to enumerate every alias
 * without importing five modules.
 */

const { CATEGORY_ALIASES, SUBTYPE_ALIASES } = require('./categories');
const { COLOR_ALIASES } = require('./colors');
const { MATERIAL_ALIASES } = require('./materials');
const { PATTERN_ALIASES } = require('./patterns');
const { SILHOUETTE_ALIASES } = require('./silhouettes');

const ALL_ALIASES = Object.freeze({
  category: CATEGORY_ALIASES,
  subtype: SUBTYPE_ALIASES,
  color: COLOR_ALIASES,
  material: MATERIAL_ALIASES,
  pattern: PATTERN_ALIASES,
  silhouette: SILHOUETTE_ALIASES,
});

/**
 * Flattens every alias table into a deterministic, sorted list of
 * { field, raw, canonical } tuples. `canonical` is the resolved value for
 * simple fields, or `${value}:${family}` for color aliases. Sorted by
 * (field, raw) so callers get the same order on every run.
 */
function listAllAliases() {
  const rows = [];
  for (const [field, table] of Object.entries(ALL_ALIASES)) {
    for (const [raw, canonical] of Object.entries(table)) {
      const canonicalDescriptor = field === 'color' ? `${canonical.value}:${canonical.family}` : canonical;
      rows.push({ field, raw, canonical: canonicalDescriptor });
    }
  }
  rows.sort((a, b) => (a.field === b.field ? a.raw.localeCompare(b.raw) : a.field.localeCompare(b.field)));
  return rows;
}

module.exports = {
  ALL_ALIASES,
  listAllAliases,
};
