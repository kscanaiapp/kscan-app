'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { validateCorpus } = require('../schema/identitySchema');
const { canonicalHash, stripVolatile } = require('../../fashion-match-quality/lib/canonicalJson');

const SYNTHETIC_PATH = path.join(__dirname, 'fixtures', 'synthetic', 'corpus.json');
const REAL_DIR = path.join(__dirname, 'real'); // ready, empty until an owner supplies an approved real corpus (section 23)

/** Load and validate the committed synthetic corpus from disk. */
function loadSyntheticCorpus() {
  if (!fs.existsSync(SYNTHETIC_PATH)) {
    throw new Error(`SYNTHETIC_CORPUS_NOT_FOUND: ${SYNTHETIC_PATH} - run corpus/buildSyntheticCorpus.js first`);
  }
  const corpus = JSON.parse(fs.readFileSync(SYNTHETIC_PATH, 'utf8'));
  const { valid, errors } = validateCorpus(corpus);
  if (!valid) {
    throw new Error(`CORPUS_VALIDATION_FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return corpus;
}

/**
 * Load an approved-real corpus if an owner has placed one at
 * corpus/real/corpus.json. Returns null (not an error) when none exists -
 * spec section 23: "If no suitable identity corpus exists:
 * REAL PRODUCT IDENTITY CORPUS: READY_NO_CORPUS".
 */
function loadApprovedRealCorpus() {
  const realPath = path.join(REAL_DIR, 'corpus.json');
  if (!fs.existsSync(realPath)) return null;
  const corpus = JSON.parse(fs.readFileSync(realPath, 'utf8'));
  const { valid, errors } = validateCorpus(corpus);
  if (!valid) {
    throw new Error(`REAL_CORPUS_VALIDATION_FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return corpus;
}

/** Deterministic manifest for a corpus: offer/case/style counts + a content hash (generatedAt excluded). */
function buildCorpusManifest(corpus) {
  return {
    corpusId: corpus.corpusId,
    generatorVersion: corpus.generatorVersion,
    seed: corpus.seed,
    corpusTier: corpus.corpusTier,
    offerCount: corpus.offers.length,
    styleCount: corpus.canonicalStyles.length,
    variantCount: corpus.canonicalStyles.reduce((sum, s) => sum + s.variants.length, 0),
    caseCount: corpus.cases.length,
    overrideCount: corpus.pairOverrides.length,
    manifestHash: canonicalHash(stripVolatile(corpus, ['generatedAt'])),
  };
}

module.exports = {
  loadSyntheticCorpus,
  loadApprovedRealCorpus,
  buildCorpusManifest,
  SYNTHETIC_PATH,
  REAL_DIR,
};
