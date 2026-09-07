#!/usr/bin/env node
'use strict';

/**
 * Regenerate the committed synthetic corpus (spec sections 20-22). Fails
 * loudly (non-zero exit) if the freshly generated corpus does not validate -
 * mirrors tools/fashion-match-quality/fixtures/buildSyntheticCorpus.js.
 *
 * Usage: node tools/canonical-product-identity/corpus/buildSyntheticCorpus.js [--seed=...] [--instances=N]
 */

const fs = require('node:fs');
const path = require('node:path');

const { generateCorpus, DEFAULT_SEED, DEFAULT_INSTANCES_PER_CASE } = require('./generator');
const { validateCorpus } = require('../schema/identitySchema');
const { SYNTHETIC_PATH } = require('./corpusLoader');

function parseArg(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1] : fallback;
}

function main() {
  const seed = parseArg('seed', DEFAULT_SEED);
  const instances = Number(parseArg('instances', String(DEFAULT_INSTANCES_PER_CASE)));

  const corpus = generateCorpus({ seed, instancesPerCase: instances });
  const { valid, errors } = validateCorpus(corpus);
  if (!valid) {
    console.error('GENERATED CORPUS FAILED VALIDATION:');
    for (const e of errors) console.error(`  - ${e}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(SYNTHETIC_PATH), { recursive: true });
  fs.writeFileSync(SYNTHETIC_PATH, `${JSON.stringify(corpus, null, 2)}\n`, 'utf8');
  console.log(`Synthetic corpus written to ${SYNTHETIC_PATH}`);
  console.log(`  offers=${corpus.offers.length} styles=${corpus.canonicalStyles.length} cases=${corpus.cases.length} overrides=${corpus.pairOverrides.length}`);
  process.exit(0);
}

main();
