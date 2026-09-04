#!/usr/bin/env node
'use strict';

/**
 * Regenerates the synthetic BodyFrame series for each manifest in
 * manifests/*.json (via the same seeded generator each one names) and
 * writes a real metrics report per sequence to reports/<sequenceId>.json
 * using @kscan-live-vto/evaluation's golden-sequence runner.
 *
 * This is the "golden-sequence runner" Section 17/P1-A calls for, applied
 * to the only sequences this cloud sandbox session could actually back
 * with data (synthetic — no camera/device/subject available; see
 * fixtures/people/README.md). 17 of Section 17's 20 required categories
 * have no manifest here yet — see fixtures/sequences/README.md.
 *
 * Requires @kscan-live-vto/evaluation to be built first:
 *   npm run build -w @kscan-live-vto/evaluation
 * Run from kscan-live-vto/:
 *   node fixtures/sequences/generate-reports.js
 */

const fs = require('node:fs');
const path = require('node:path');

const evaluationDist = path.resolve(__dirname, '..', '..', 'packages', 'evaluation', 'dist', 'index.js');
const { generateCenteredStandingSequence, runGoldenSequence } = require(evaluationDist);

const GENERATORS = {
  generateCenteredStandingSequence,
};

const manifestsDir = path.join(__dirname, 'manifests');
const reportsDir = path.join(__dirname, 'reports');
fs.mkdirSync(reportsDir, { recursive: true });

const manifestFiles = fs.readdirSync(manifestsDir).filter((f) => f.endsWith('.json'));

for (const file of manifestFiles) {
  const manifest = JSON.parse(fs.readFileSync(path.join(manifestsDir, file), 'utf8'));
  const gen = GENERATORS[manifest.generator.fn];
  if (!gen) throw new Error(`Unknown generator "${manifest.generator.fn}" in ${file}`);

  const { fn, ...generatorOptions } = manifest.generator;
  const frames = gen({ frameCount: manifest.frameCount, frameRateHz: manifest.nominalFrameRateHz, ...generatorOptions });

  const report = runGoldenSequence(manifest, frames);
  const outPath = path.join(reportsDir, `${manifest.sequenceId}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
  console.log(`[generate-reports] wrote ${path.relative(process.cwd(), outPath)}`);
}
