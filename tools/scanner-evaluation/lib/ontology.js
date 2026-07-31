'use strict';

/**
 * Versioned evaluation ontology loader and comparison engine.
 *
 * WHY THIS EXISTS: the Phase 0A harness compared taxonomy values with substring
 * matching (`truth.includes(pred)`). That both under- and over-credited. "top"
 * matched "tank top" by accident, and "boot" matched "bootcut jeans" — a
 * cross-category match scored as acceptably broad. Comparison is now driven by
 * an explicit hierarchy imported from production sources.
 *
 * The four outcomes are fixed by the Phase 0B contract:
 *   exact_match | one_level_broader | unrelated | invalid_comparison
 *
 * one_level_broader means moving exactly one level UP the hierarchy. Sideways
 * (peer) and downward (narrower) moves are never acceptably broad.
 */

const fs = require('fs');
const path = require('path');

const ONTOLOGY_DIR = path.join(__dirname, '..', 'ontology');

function loadJson(file) {
  return JSON.parse(fs.readFileSync(path.join(ONTOLOGY_DIR, file), 'utf8'));
}

const TAXONOMY = loadJson('fashion-taxonomy.v1.json');
const COLORS = loadJson('color-families.v1.json');
const MATERIALS = loadJson('material-families.v1.json');
const BRANDS = loadJson('brand-normalization.v1.json');

const OUTCOMES = Object.freeze({
  EXACT: 'exact_match',
  BROADER: 'one_level_broader',
  UNRELATED: 'unrelated',
  INVALID: 'invalid_comparison',
});

const ONTOLOGY_VERSIONS = Object.freeze({
  taxonomy: TAXONOMY.ontologyVersion,
  color: COLORS.ontologyVersion,
  material: MATERIALS.ontologyVersion,
  brand: BRANDS.ontologyVersion,
});

const UNCERTAINTY = new Set(['unknown', 'not_visible', 'not_applicable']);

function norm(value) {
  if (value == null) return '';
  return String(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Underscore and hyphen are interchangeable separators in label vocabularies. */
function slug(value) {
  return norm(value).replace(/[\s-]+/g, '_');
}

function isUncertaintyToken(value) {
  return UNCERTAINTY.has(norm(value));
}

// ── Taxonomy index ───────────────────────────────────────────────────────────

/**
 * Flatten the hierarchy into value -> { level, category, clothingType }.
 * A value may legitimately appear at two levels (e.g. "blazer" is both a
 * category and a clothingType, "skirt" likewise). The index keeps every
 * placement so comparison can consider all of them.
 */
function buildTaxonomyIndex() {
  const index = new Map();

  const add = (value, placement) => {
    const key = slug(value);
    if (!key) return;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(placement);
  };

  for (const [category, node] of Object.entries(TAXONOMY.hierarchy)) {
    add(category, { level: 'category', category, clothingType: null, subtype: null });
    const types = (node && node.clothingTypes) || {};
    for (const [clothingType, subtypes] of Object.entries(types)) {
      add(clothingType, { level: 'clothingType', category, clothingType, subtype: null });
      for (const subtype of subtypes) {
        add(subtype, { level: 'subtype', category, clothingType, subtype });
      }
    }
  }
  return index;
}

const TAXONOMY_INDEX = buildTaxonomyIndex();

const CATEGORY_ALIASES = new Map(
  Object.entries(TAXONOMY.evaluationOnlyAliases.categoryAliases).map(([k, v]) => [slug(k), slug(v)])
);
const CLOTHING_TYPE_ALIASES = new Map(
  Object.entries(TAXONOMY.evaluationOnlyAliases.clothingTypeAliases).map(([k, v]) => [
    slug(k),
    slug(v),
  ])
);

/** Resolve an eval-vocabulary label to production-canonical form. */
function resolveTaxonomyValue(value) {
  const key = slug(value);
  if (!key) return { key: '', aliased: false };
  if (TAXONOMY_INDEX.has(key)) return { key, aliased: false };
  if (CATEGORY_ALIASES.has(key)) return { key: CATEGORY_ALIASES.get(key), aliased: true };
  if (CLOTHING_TYPE_ALIASES.has(key)) return { key: CLOTHING_TYPE_ALIASES.get(key), aliased: true };
  return { key, aliased: false };
}

const DISPUTED_PAIRS = new Set(['blazer>outerwear', 'outerwear>blazer']);

/**
 * Compare two taxonomy values.
 *
 * @param {string} groundTruth
 * @param {string} prediction
 * @param {{ level?: 'category'|'clothingType'|'subtype' }} [options]
 */
function compareTaxonomy(groundTruth, prediction, options = {}) {
  const gtResolved = resolveTaxonomyValue(groundTruth);
  const predResolved = resolveTaxonomyValue(prediction);

  if (!gtResolved.key || !predResolved.key) {
    return { outcome: OUTCOMES.INVALID, reason: 'empty value on one side' };
  }
  if (isUncertaintyToken(groundTruth) || isUncertaintyToken(prediction)) {
    return { outcome: OUTCOMES.INVALID, reason: 'uncertainty token is not a taxonomy comparison' };
  }

  const gtPlacements = TAXONOMY_INDEX.get(gtResolved.key);
  const predPlacements = TAXONOMY_INDEX.get(predResolved.key);

  if (!gtPlacements) {
    return {
      outcome: OUTCOMES.INVALID,
      reason: `ground-truth value not in ontology: ${gtResolved.key}`,
      unmappedGroundTruth: true,
    };
  }
  if (!predPlacements) {
    // An out-of-ontology PREDICTION is a real model output, not a harness fault.
    // It is unrelated (scoreable), never invalid (unscoreable), so the model is
    // not silently excused for inventing a value.
    return {
      outcome: OUTCOMES.UNRELATED,
      reason: `prediction not in ontology: ${predResolved.key}`,
      unmappedPrediction: true,
    };
  }

  if (gtResolved.key === predResolved.key) {
    return {
      outcome: OUTCOMES.EXACT,
      reason: gtResolved.aliased || predResolved.aliased ? 'exact after alias resolution' : 'exact',
      aliasApplied: gtResolved.aliased || predResolved.aliased,
    };
  }

  const disputeKey = `${gtResolved.key}>${predResolved.key}`;
  if (DISPUTED_PAIRS.has(disputeKey)) {
    return {
      outcome: OUTCOMES.UNRELATED,
      reason: 'disputed relationship; production treats these as sibling categories',
      disputed: true,
    };
  }

  // one_level_broader: prediction is the immediate parent of ground truth.
  for (const gt of gtPlacements) {
    for (const pred of predPlacements) {
      if (gt.level === 'subtype' && pred.level === 'clothingType') {
        if (gt.clothingType === pred.clothingType && gt.category === pred.category) {
          return { outcome: OUTCOMES.BROADER, reason: 'subtype -> its clothingType' };
        }
      }
      if (gt.level === 'clothingType' && pred.level === 'category') {
        if (gt.category === pred.category) {
          return { outcome: OUTCOMES.BROADER, reason: 'clothingType -> its category' };
        }
      }
    }
  }

  // Two levels up (subtype -> category) is NOT one level broader.
  for (const gt of gtPlacements) {
    for (const pred of predPlacements) {
      if (gt.level === 'subtype' && pred.level === 'category' && gt.category === pred.category) {
        return {
          outcome: OUTCOMES.UNRELATED,
          reason: 'two levels broader; only one level is acceptable',
          twoLevelsBroader: true,
        };
      }
    }
  }

  const sameCategory = gtPlacements.some((gt) =>
    predPlacements.some((pred) => gt.category === pred.category)
  );
  return {
    outcome: OUTCOMES.UNRELATED,
    reason: sameCategory ? 'peer within the same category' : 'different category',
    crossCategory: !sameCategory,
  };
}

// ── Color ────────────────────────────────────────────────────────────────────

const COLOR_FAMILY = new Map(
  Object.entries(COLORS.importedFamilyMap)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => [norm(k), norm(v)])
);
const COLOR_BASE = new Set(COLORS.baseFamilies.map(norm));
const COLOR_SPELLING = new Map(Object.entries(COLORS.spellingVariants).map(([k, v]) => [norm(k), norm(v)]));
const COLOR_COMPOUND = new Map(
  Object.entries(COLORS.compoundProductionTokens)
    .filter(([k]) => !k.startsWith('_'))
    .map(([k, v]) => [norm(k), norm(v)])
);
const COLOR_TERMINAL = new Set(
  COLORS.disputedMappings.filter((d) => /own terminal family/i.test(d.chosenRule || '')).map((d) => norm(d.value))
);

function resolveColor(value) {
  let key = norm(value).replace(/_/g, ' ');
  if (COLOR_SPELLING.has(key)) key = COLOR_SPELLING.get(key);
  if (COLOR_COMPOUND.has(key)) return { key, family: COLOR_COMPOUND.get(key), compound: true };
  if (COLOR_TERMINAL.has(key)) return { key, family: key, terminal: true };
  if (COLOR_FAMILY.has(key)) return { key, family: COLOR_FAMILY.get(key), shade: true };
  if (COLOR_BASE.has(key)) return { key, family: key, base: true };
  return { key, family: null, unmapped: true };
}

function compareColor(groundTruth, prediction) {
  if (isUncertaintyToken(groundTruth) || isUncertaintyToken(prediction)) {
    return { outcome: OUTCOMES.INVALID, reason: 'uncertainty token' };
  }
  const gt = resolveColor(groundTruth);
  const pred = resolveColor(prediction);
  if (!gt.key || !pred.key) return { outcome: OUTCOMES.INVALID, reason: 'empty color' };

  if (gt.key === pred.key) return { outcome: OUTCOMES.EXACT, reason: 'exact color' };

  if (gt.unmapped) {
    return { outcome: OUTCOMES.INVALID, reason: `ground-truth color not in ontology: ${gt.key}`, unmappedGroundTruth: true };
  }
  if (pred.unmapped) {
    return { outcome: OUTCOMES.UNRELATED, reason: `prediction color not in ontology: ${pred.key}`, unmappedPrediction: true };
  }

  // Broader: prediction is the FAMILY of a ground-truth shade. navy -> blue.
  if (gt.shade && pred.base && gt.family === pred.key) {
    return { outcome: OUTCOMES.BROADER, reason: 'shade -> its family' };
  }
  if (gt.compound && pred.base && gt.family === pred.key) {
    return { outcome: OUTCOMES.BROADER, reason: 'compound token -> its family' };
  }

  // Narrower: ground truth is a family, prediction asserts a specific shade.
  if (gt.base && pred.shade && pred.family === gt.key) {
    return {
      outcome: OUTCOMES.UNRELATED,
      reason: 'prediction asserts a narrower shade than the label supports',
      narrower: true,
    };
  }

  if (gt.family && pred.family && gt.family === pred.family) {
    return { outcome: OUTCOMES.UNRELATED, reason: 'same-family peer shades', peer: true };
  }
  return { outcome: OUTCOMES.UNRELATED, reason: 'different color families' };
}

// ── Material ─────────────────────────────────────────────────────────────────

const MATERIAL_SUPPORTED = new Set(MATERIALS.importedSupportedMaterials.map(norm));
const MATERIAL_COMPOUND = new Map(
  Object.entries(MATERIALS.compoundProductionTokens).map(([k, v]) => [norm(k), norm(v)])
);

const MATERIAL_PARENT = new Map();
for (const [family, node] of Object.entries(MATERIALS.families)) {
  if (family.startsWith('_')) continue;
  for (const member of node.members) MATERIAL_PARENT.set(norm(member), family);
}

/** Pairs that must never be scored as related, in either direction. */
const MATERIAL_FORBIDDEN = new Set();
for (const entry of MATERIALS.explicitNonEquivalences) {
  if (!/NEVER equivalent/i.test(entry.rule || '')) continue;
  const [a, b] = entry.pair.map(norm);
  MATERIAL_FORBIDDEN.add(`${a}|${b}`);
  MATERIAL_FORBIDDEN.add(`${b}|${a}`);
}

/** denim has no parent by explicit governed decision. */
const MATERIAL_TERMINAL = new Set(['denim']);

function resolveMaterial(value) {
  let key = norm(value).replace(/_/g, ' ');
  if (MATERIAL_COMPOUND.has(key)) key = MATERIAL_COMPOUND.get(key);
  const family = MATERIAL_TERMINAL.has(key) ? null : MATERIAL_PARENT.get(key) || null;
  return { key, family, supported: MATERIAL_SUPPORTED.has(key) };
}

function compareMaterial(groundTruth, prediction) {
  if (isUncertaintyToken(groundTruth) || isUncertaintyToken(prediction)) {
    return { outcome: OUTCOMES.INVALID, reason: 'uncertainty token' };
  }
  const gt = resolveMaterial(groundTruth);
  const pred = resolveMaterial(prediction);
  if (!gt.key || !pred.key) return { outcome: OUTCOMES.INVALID, reason: 'empty material' };

  if (gt.key === pred.key) return { outcome: OUTCOMES.EXACT, reason: 'exact material' };

  if (MATERIAL_FORBIDDEN.has(`${gt.key}|${pred.key}`)) {
    return {
      outcome: OUTCOMES.UNRELATED,
      reason: 'materially different substances; never equated',
      forbiddenPair: true,
    };
  }

  // Prediction is the family name itself (e.g. GT cashmere, pred wool_family).
  if (gt.family && slug(pred.key) === slug(gt.family)) {
    return { outcome: OUTCOMES.BROADER, reason: 'material -> its family' };
  }
  // Production-real collapse: cashmere -> wool. Only for families imported from
  // production, never for evaluation-only groupings.
  if (gt.family && pred.family === gt.family) {
    const node = MATERIALS.families[gt.family];
    if (node && node.evaluationOnly === false) {
      const familyHead = norm(node.members[0]);
      if (pred.key === familyHead) {
        return { outcome: OUTCOMES.BROADER, reason: `production collapse within ${gt.family}` };
      }
    }
    return {
      outcome: OUTCOMES.UNRELATED,
      reason: `peer members of evaluation-only grouping ${gt.family}`,
      peer: true,
    };
  }
  return { outcome: OUTCOMES.UNRELATED, reason: 'different material families' };
}

// ── Brand ────────────────────────────────────────────────────────────────────

const LEGAL_SUFFIXES = new Set(BRANDS.verifiedLegalSuffixes.values.map(norm));

/** Formatting-only normalization. Never merges distinct brands. */
function normalizeBrand(value) {
  if (value == null) return '';
  let out = String(value).trim().toLowerCase();
  out = out.replace(/[®™©℗]/g, '');
  out = out.replace(/\((?:r|tm|c)\)/g, '');
  out = out.replace(/[.,'’´`]/g, '');
  out = out.replace(/[-&]+/g, ' ');
  out = out.replace(/\s+/g, ' ').trim();

  const tokens = out.split(' ').filter(Boolean);
  if (tokens.length > 1 && LEGAL_SUFFIXES.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

function compareBrand(groundTruth, prediction) {
  if (isUncertaintyToken(groundTruth) || isUncertaintyToken(prediction)) {
    return { outcome: OUTCOMES.INVALID, reason: 'uncertainty token' };
  }
  const gt = normalizeBrand(groundTruth);
  const pred = normalizeBrand(prediction);
  if (!gt || !pred) return { outcome: OUTCOMES.INVALID, reason: 'empty brand' };
  if (gt === pred) return { outcome: OUTCOMES.EXACT, reason: 'exact brand after formatting normalization' };
  return { outcome: OUTCOMES.UNRELATED, reason: 'different brands; no alias inference performed' };
}

module.exports = {
  OUTCOMES,
  ONTOLOGY_VERSIONS,
  TAXONOMY,
  COLORS,
  MATERIALS,
  BRANDS,
  compareTaxonomy,
  compareColor,
  compareMaterial,
  compareBrand,
  normalizeBrand,
  resolveTaxonomyValue,
  resolveColor,
  resolveMaterial,
  isUncertaintyToken,
};
