'use strict';

/**
 * Material vocabulary (spec section 10). Bounded, and deliberately does not
 * collapse materially different concepts — leather/faux_leather/suede stay
 * three distinct canonical values (the task's own example), matching real
 * matching-quality stakes: a faux-leather substitute for a leather query is
 * a materially different product, not a synonym.
 *
 * Evidence base: task's explicit list, plus CPI's corpus generator
 * vocabulary (lib/fashionWorld.js jacket materials: lambskin, suede, wool,
 * cotton twill, nylon).
 *
 * SEMANTIC HARDENING PASS: every alias below was hostile-reviewed against
 * the same doctrine applied to colors.js/patterns.js/silhouettes.js/
 * categories.js ("similarity/relatedness is not sufficient for hard
 * aliasing"). No change was made here, because every merge in this file
 * passes a stronger test than a same-family color or a related silhouette:
 * each is the literal same base material, named by source, weave, or brand
 * rather than a different substance — `lambskin` is still animal leather
 * (source variant, not a different material, unlike `faux_leather` which
 * genuinely is a different material and stays split), `merino wool`/
 * `lambswool` are still wool, `cotton twill`/`organic cotton` are still
 * cotton, and `elastane`/`lycra` are literally alternate generic/brand
 * names for the same synthetic fiber as `spandex`. None of these are a
 * "shared family, distinct value" case the way `royal_blue`/`blue` is —
 * there is no second material concept being erased.
 */
const CANONICAL_MATERIALS = Object.freeze([
  { value: 'leather', aliases: ['leather', 'lambskin', 'genuine leather', 'real leather'] },
  { value: 'faux_leather', aliases: ['faux leather', 'vegan leather', 'pleather', 'synthetic leather'] },
  { value: 'suede', aliases: ['suede'] },
  { value: 'denim', aliases: ['denim'] },
  { value: 'cotton', aliases: ['cotton', 'cotton twill', 'organic cotton'] },
  { value: 'wool', aliases: ['wool', 'merino wool', 'lambswool'] },
  { value: 'silk', aliases: ['silk', 'mulberry silk'] },
  { value: 'polyester', aliases: ['polyester', 'poly'] },
  { value: 'nylon', aliases: ['nylon'] },
  { value: 'linen', aliases: ['linen'] },
  { value: 'cashmere', aliases: ['cashmere'] },
  { value: 'spandex', aliases: ['spandex', 'elastane', 'lycra'] },
  { value: 'canvas', aliases: ['canvas'] },
]);

function buildMaterialAliasMap() {
  const map = Object.create(null);
  for (const material of CANONICAL_MATERIALS) {
    // Idempotent: a canonical value always resolves to itself.
    map[material.value] = material.value;
    for (const alias of material.aliases) {
      map[alias] = material.value;
    }
  }
  return Object.freeze(map);
}

const MATERIAL_ALIASES = buildMaterialAliasMap();

module.exports = {
  CANONICAL_MATERIALS,
  MATERIAL_ALIASES,
};
