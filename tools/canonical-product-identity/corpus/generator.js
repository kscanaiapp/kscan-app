'use strict';

/**
 * Deterministic synthetic corpus generator (spec sections 20-22, Addendum
 * A.4/A.6). Builds a full corpus (offers + canonical style/variant graph +
 * ground-truth overrides + per-case traceability) from the REGISTRY of named
 * case generators, at a configurable instantiation count per case.
 *
 * Determinism: everything derives from a single string seed via
 * lib/seededRandom.js (mulberry32). The same seed + GENERATOR_VERSION always
 * produces byte-identical output (spec section 43#1/#23).
 */

const { createRng } = require('../lib/seededRandom');
const { resetOfferCounter } = require('../lib/offerFactory');
const { REGISTRY } = require('./caseGenerators');

const GENERATOR_VERSION = 'cpil-generator-v1';
const DEFAULT_SEED = 'canonical-product-identity-lab-v1-synthetic';
const DEFAULT_INSTANCES_PER_CASE = 8;

function generateCorpus({ seed = DEFAULT_SEED, instancesPerCase = DEFAULT_INSTANCES_PER_CASE } = {}) {
  resetOfferCounter();
  const rng = createRng(seed);

  const offers = [];
  const canonicalStyles = [];
  const pairOverrides = [];
  const cases = [];

  for (const { caseId, requirementRef, fn } of REGISTRY) {
    const caseRng = rng.child(caseId);
    for (let idx = 0; idx < instancesPerCase; idx += 1) {
      const instanceRng = caseRng.child(String(idx));
      const result = fn(instanceRng, idx);
      offers.push(...result.offers);
      canonicalStyles.push(...result.styles);
      pairOverrides.push(...result.pairOverrides);
      cases.push({
        caseId,
        requirementRef,
        instanceIndex: idx,
        offerIds: result.offers.map((o) => o.offerId),
        styleIds: result.styles.map((s) => s.styleId),
        overrideCount: result.pairOverrides.length,
      });
    }
  }

  return {
    corpusId: `cpil-synthetic-${seed}`,
    generatorVersion: GENERATOR_VERSION,
    seed,
    corpusTier: 'SYNTHETIC',
    groundTruthSource: 'synthetic_generator_construction',
    instancesPerCase,
    generatedAt: new Date().toISOString(),
    offers,
    canonicalStyles,
    pairOverrides,
    cases,
  };
}

module.exports = { generateCorpus, GENERATOR_VERSION, DEFAULT_SEED, DEFAULT_INSTANCES_PER_CASE };
