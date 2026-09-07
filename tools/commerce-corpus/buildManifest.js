#!/usr/bin/env node
'use strict';

/**
 * Assembles __tests__/fixtures/commerce/manifest.json from every fixture
 * file under __tests__/fixtures/commerce/ (spec section 8).
 *
 * Deliberately generated, not hand-maintained: with ~110 scenarios across
 * ~20 files, hand-transcribing scenarioId/category/tags/evidenceClass into a
 * second file would drift from the fixture files themselves. This script is
 * the single source that turns "the fixture files on disk" into "the
 * manifest," so the two can never silently disagree - re-run this after
 * adding/editing any fixture file and commit the regenerated manifest.json.
 *
 * Usage: node tools/commerce-corpus/buildManifest.js
 */

const fs = require('node:fs');
const path = require('node:path');

const CORPUS_ROOT = path.resolve(__dirname, '../../__tests__/fixtures/commerce');
const MANIFEST_PATH = path.join(CORPUS_ROOT, 'manifest.json');
const COMMERCE_CORPUS_VERSION = 1;

function listFixtureFiles() {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (full === MANIFEST_PATH || entry.name === 'manifest.schema.json') continue;
        out.push(full);
      }
    }
  }
  walk(CORPUS_ROOT);
  return out;
}

function describeMutation(record) {
  return `Mutation of '${record.mutationOf}': ${record.violationType || record.mutatedField} must be flagged, not silently accepted.`;
}

function buildManifest() {
  const scenarios = [];

  for (const file of listFixtureFiles()) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const relPath = path.relative(CORPUS_ROOT, file).split(path.sep).join('/');
    const isMutation = parsed.category === 'mutation-negative-control';

    for (const record of parsed.records || []) {
      scenarios.push({
        scenarioId: record.scenarioId,
        category: parsed.category,
        description: isMutation ? describeMutation(record) : record.description,
        inputFixture: `${relPath}#${record.scenarioId}`,
        expectedOutcome: record.expected,
        tags: record.tags,
        evidenceClass: isMutation ? 'SYNTHETIC' : record.evidenceClass,
        ...(isMutation ? { mutationOf: record.mutationOf } : {}),
      });
    }
  }

  scenarios.sort((a, b) => (a.category === b.category ? a.scenarioId.localeCompare(b.scenarioId) : a.category.localeCompare(b.category)));

  return {
    commerceCorpusVersion: COMMERCE_CORPUS_VERSION,
    generatedBy: 'tools/commerce-corpus/buildManifest.js',
    scenarios,
  };
}

/**
 * Serializes the manifest with one scenario object per line rather than
 * fully pretty-printed nested objects. manifest.json is a generated index
 * that duplicates each fixture record's own `expected` object (by design -
 * see README "Manifest schema"); at 112 scenarios, multi-line pretty-printing
 * that duplication makes the file (and every PR touching it) far larger than
 * its actual information content. One scenario per line keeps the file valid
 * JSON, keeps every field visible without opening a viewer that collapses
 * objects, and keeps future diffs to the one or two lines that actually
 * changed instead of the whole file reflowing.
 */
function serializeManifest(manifest) {
  const header = `{\n  "commerceCorpusVersion": ${manifest.commerceCorpusVersion},\n  "generatedBy": ${JSON.stringify(manifest.generatedBy)},\n  "scenarios": [\n`;
  const lines = manifest.scenarios.map((s, i) => {
    const comma = i < manifest.scenarios.length - 1 ? ',' : '';
    return `    ${JSON.stringify(s)}${comma}`;
  });
  return `${header}${lines.join('\n')}\n  ]\n}\n`;
}

function main() {
  const manifest = buildManifest();
  fs.writeFileSync(MANIFEST_PATH, serializeManifest(manifest));
  console.log(`wrote ${MANIFEST_PATH}`);
  console.log(`  scenarios: ${manifest.scenarios.length}`);
}

if (require.main === module) {
  main();
}

module.exports = { buildManifest };
