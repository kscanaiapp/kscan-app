'use strict';

/**
 * Silhouette vocabulary (spec section 12) — fashion-specific garment shape,
 * not generic computer-vision shape classification.
 *
 * Evidence base: `cropped`/`oversized`/`fitted`/`boxy` come directly from
 * CPI's corpus generator (tools/canonical-product-identity/lib/fashionWorld.js
 * jacket silhouettes). `a_line`/`bodycon` are standard dress-silhouette
 * retail terms; `straight`/`wide_leg`/`skinny` are standard bottom-silhouette
 * terms; `relaxed` is a general cross-category term already distinct from
 * Scanner's separate `attributes.fit` field (fit describes how a garment
 * sits on the body at the size level; silhouette describes the garment's
 * own cut) — this ontology does not attempt to model `fit` in V1, it is out
 * of the seven-field scope.
 */
const CANONICAL_SILHOUETTES = Object.freeze([
  { value: 'fitted', aliases: ['fitted', 'slim fit', 'tailored'] },
  { value: 'oversized', aliases: ['oversized', 'oversize'] },
  { value: 'relaxed', aliases: ['relaxed', 'relaxed fit'] },
  { value: 'cropped', aliases: ['cropped', 'crop'] },
  { value: 'boxy', aliases: ['boxy', 'boxy fit'] },
  { value: 'a_line', aliases: ['a-line', 'a line', 'aline'] },
  { value: 'bodycon', aliases: ['bodycon', 'body-con', 'body con'] },
  { value: 'straight', aliases: ['straight', 'straight leg', 'straight-leg'] },
  { value: 'wide_leg', aliases: ['wide leg', 'wide-leg', 'flare', 'flared'] },
  { value: 'skinny', aliases: ['skinny', 'skinny fit'] },
]);

function buildSilhouetteAliasMap() {
  const map = Object.create(null);
  for (const silhouette of CANONICAL_SILHOUETTES) {
    // Idempotent: a canonical value always resolves to itself.
    map[silhouette.value] = silhouette.value;
    for (const alias of silhouette.aliases) {
      map[alias] = silhouette.value;
    }
  }
  return Object.freeze(map);
}

const SILHOUETTE_ALIASES = buildSilhouetteAliasMap();

module.exports = {
  CANONICAL_SILHOUETTES,
  SILHOUETTE_ALIASES,
};
