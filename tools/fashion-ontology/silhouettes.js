'use strict';

/**
 * Silhouette vocabulary (spec section 12) — fashion-specific garment shape,
 * not generic computer-vision shape classification.
 *
 * Evidence base: `cropped`/`oversized`/`fitted`/`boxy` come directly from
 * CPI's corpus generator (tools/canonical-product-identity/lib/fashionWorld.js
 * jacket silhouettes). `a_line`/`bodycon` are standard dress-silhouette
 * retail terms; `straight`/`wide_leg`/`flare`/`skinny` are standard
 * bottom-silhouette terms; `relaxed` is a general cross-category term.
 *
 * SEMANTIC HARDENING PASS (before this ontology becomes ground truth for
 * Real Fashion Corpus):
 *
 *   `tailored` was folded into `fitted` — split out. "Tailored" describes a
 *   structured construction/finish (a tailored blazer can be structured
 *   without being body-skimming); "fitted" describes closeness to the
 *   body. They are not the same concept and a hard alias erased a real
 *   distinction. `slim fit` stays merged with `fitted` (it genuinely
 *   describes the same body-closeness concept, unlike `tailored`).
 *
 *   `flare`/`flared` were folded into `wide_leg` — split out. A flared leg
 *   widens progressively from the knee; a wide-leg is uniformly wide from
 *   hip to hem. These are visually and commercially distinct cuts (the
 *   silhouette doctrine's own worked example) and stay separate, alongside
 *   `straight` and `skinny`, which were already distinct and remain so.
 *
 * DOCUMENTED COMPROMISE: `cropped` is arguably a length/proportion
 * attribute rather than a garment "shape" the way `a_line`/`bodycon`/
 * `boxy` are — Scanner's own contract keeps a separate `attributes.length`
 * field for exactly this reason. V1 has no such field (out of the seven
 * approved fields for this workstream), and `cropped` is real,
 * evidence-grounded signal (CPI's own corpus vocabulary classifies it
 * alongside `oversized`/`fitted`/`boxy` as a jacket silhouette) that would
 * otherwise have nowhere to live in this contract. It is kept here as a
 * considered compromise, not an oversight — a future length/proportion
 * field, if this ontology grows one, should absorb it and this comment
 * should be revisited then.
 */
const CANONICAL_SILHOUETTES = Object.freeze([
  { value: 'fitted', aliases: ['fitted', 'slim fit'] },
  // Split from `fitted`: a structured construction/finish, not the same
  // concept as closeness-to-body.
  { value: 'tailored', aliases: ['tailored'] },
  { value: 'oversized', aliases: ['oversized', 'oversize'] },
  { value: 'relaxed', aliases: ['relaxed', 'relaxed fit'] },
  // See DOCUMENTED COMPROMISE above — kept as silhouette in V1 for lack of
  // a length/proportion field, not because it is genuinely a "shape."
  { value: 'cropped', aliases: ['cropped', 'crop'] },
  { value: 'boxy', aliases: ['boxy', 'boxy fit'] },
  { value: 'a_line', aliases: ['a-line', 'a line', 'aline'] },
  { value: 'bodycon', aliases: ['bodycon', 'body-con', 'body con'] },
  { value: 'straight', aliases: ['straight', 'straight leg', 'straight-leg'] },
  { value: 'wide_leg', aliases: ['wide leg', 'wide-leg'] },
  // Split from `wide_leg`: a flare widens progressively from the knee; a
  // wide-leg is uniformly wide from hip to hem — different cuts.
  { value: 'flare', aliases: ['flare', 'flared'] },
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
