'use strict';

/**
 * Quality distribution report (Real Fashion Corpus V2, spec section 14).
 *
 * Deterministic and read-only: it never mutates the corpus, and calling it
 * twice against the same corpus state produces byte-identical output
 * (canonical key ordering via sorted Object.entries at print time is the
 * caller's concern - this module returns plain objects, keyed by the exact
 * canonical/failure-taxonomy strings, which are already stable).
 *
 * Respects the holdout seal (design DM-03): HOLDOUT cases are counted
 * (`holdoutCases`), never read for their content - `loadCorpus()` itself
 * never returns holdout case records outside `lib/holdout.js#openHoldout`,
 * so every per-dimension breakdown below is computed over DEVELOPMENT
 * cases only, by construction.
 */

const { FAILURE_TAXONOMY } = require('./constants');

function bump(counts, key) {
  counts[key] = (counts[key] || 0) + 1;
}

/**
 * Flags a category/dimension value that dominates or is thin relative to
 * the total, so an imbalance like "80% outerwear, 2% footwear" is visible
 * rather than hidden inside a table nobody reads closely (spec section 14's
 * own worked example).
 */
function detectImbalance(dimension, counts, total) {
  if (total === 0) return [];
  const warnings = [];
  for (const [key, count] of Object.entries(counts)) {
    if (key === 'unknown') continue;
    const pct = (count / total) * 100;
    if (pct >= 60) {
      warnings.push(`${dimension}=${key} is ${pct.toFixed(1)}% of development cases - dominant, may skew headline metrics`);
    } else if (pct > 0 && pct < 5) {
      warnings.push(`${dimension}=${key} is only ${pct.toFixed(1)}% of development cases - thin coverage`);
    }
  }
  return warnings.sort();
}

/**
 * @param {object} corpus  the object returned by corpusStore.js#loadCorpus():
 *   { garments, cases (development partition only), garmentsById, holdoutCaseCount }
 */
function buildDistributionReport(corpus) {
  const devCases = corpus.cases.length;
  const holdoutCases = corpus.holdoutCaseCount || 0;

  const casesByCategory = {};
  const casesBySubtype = {};
  const casesByColorFamily = {};
  const casesByMaterial = {};
  const casesByPattern = {};
  const casesBySilhouette = {};
  const casesByFailureTaxonomy = {};

  let singleGarmentCases = 0;
  let multiGarmentCases = 0;
  let occludedCases = 0;
  let smallGarmentCases = 0;
  let spatiallyAnnotatedCases = 0;
  let polygonCases = 0;

  for (const record of corpus.cases) {
    const garment = corpus.garmentsById.get(record.garmentId);
    const ontology = garment && garment.ontology;

    bump(casesByCategory, (ontology && ontology.category.value) || 'unknown');
    bump(casesBySubtype, (ontology && ontology.subtype.value) || 'unknown');
    bump(casesByColorFamily, (ontology && ontology.primaryColor.family) || 'unknown');
    bump(casesByMaterial, (ontology && ontology.material.value) || 'unknown');
    bump(casesByPattern, (ontology && ontology.pattern.value) || 'unknown');
    bump(casesBySilhouette, (ontology && ontology.silhouette.value) || 'unknown');

    for (const label of record.failureTaxonomy || []) bump(casesByFailureTaxonomy, label);

    if (Array.isArray(record.garments)) {
      spatiallyAnnotatedCases += 1;
      if (record.multiGarment) multiGarmentCases += 1;
      else singleGarmentCases += 1;
      if (record.garments.some((g) => g.occlusion && g.occlusion !== 'none')) occludedCases += 1;
      if (record.garments.some((g) => g.relativeSize === 'small')) smallGarmentCases += 1;
      if (record.garments.some((g) => Array.isArray(g.polygon))) polygonCases += 1;
    }
  }

  const failureTaxonomyGaps = FAILURE_TAXONOMY.filter((label) => !casesByFailureTaxonomy[label]).sort();

  return {
    totalCases: devCases + holdoutCases,
    totalGarments: corpus.garments.length,
    devCases,
    holdoutCases,

    casesByCategory,
    casesBySubtype,
    casesByColorFamily,
    casesByMaterial,
    casesByPattern,
    casesBySilhouette,
    casesByFailureTaxonomy,

    spatiallyAnnotatedCases,
    singleGarmentCases,
    multiGarmentCases,
    occludedCases,
    smallGarmentCases,
    polygonCases,

    imbalanceWarnings: detectImbalance('category', casesByCategory, devCases),
    failureTaxonomyGaps,
  };
}

module.exports = { buildDistributionReport, detectImbalance };
