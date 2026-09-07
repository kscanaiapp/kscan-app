#!/usr/bin/env node
'use strict';

/**
 * Build step: materialize the deterministic synthetic corpus to disk as
 * committed JSON files under fixtures/synthetic/, plus a manifest. Re-run
 * this only when the generator itself changes (a change in output here
 * without a generator change would indicate non-determinism and should
 * fail fixtures/generator.test.js first).
 */

const fs = require('node:fs');
const path = require('node:path');

const { generateSyntheticCorpus } = require('./generator');
const { buildCorpusManifest } = require('./manifest');
const { validateCorpus } = require('../schema/fixtureSchema');

const OUT_DIR = path.join(__dirname, 'synthetic');

function main() {
  const fixtures = generateSyntheticCorpus();

  const { valid, errors } = validateCorpus(fixtures);
  if (!valid) {
    console.error('Generated synthetic corpus failed validation:');
    errors.forEach((e) => console.error(`  - ${e}`));
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  // Clear stale fixture files (but leave the directory itself and any
  // non-generated files alone) so a shrinking generator doesn't leave orphans.
  for (const entry of fs.readdirSync(OUT_DIR)) {
    if (entry.endsWith('.json') && entry !== '_manifest.json') {
      fs.unlinkSync(path.join(OUT_DIR, entry));
    }
  }

  for (const fixture of fixtures) {
    const file = path.join(OUT_DIR, `${fixture.fixtureId}.json`);
    fs.writeFileSync(file, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  }

  const manifest = buildCorpusManifest(fixtures);
  fs.writeFileSync(path.join(OUT_DIR, '_manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log(`Wrote ${fixtures.length} synthetic fixtures to ${OUT_DIR}`);
  console.log(`Manifest hash: ${manifest.manifestHash}`);
}

main();
