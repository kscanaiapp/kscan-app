'use strict';

/**
 * Loads the Commerce Corpus manifest and resolves each scenario's
 * `inputFixture` pointer ("relative/path.json#scenarioId") into the actual
 * fixture record.
 *
 * Every fixture file under __tests__/fixtures/commerce/ shares one shape:
 *   { commerceCorpusFixtureVersion: 1, category: "...", records: [ { scenarioId, ... } ] }
 * A record's own `scenarioId` must match the manifest scenario that points
 * to it (validateManifest.js checks this cross-reference).
 */

const fs = require('node:fs');
const path = require('node:path');

const CORPUS_ROOT = path.resolve(__dirname, '../../../__tests__/fixtures/commerce');
const MANIFEST_PATH = path.join(CORPUS_ROOT, 'manifest.json');

function readJson(absPath) {
  const raw = fs.readFileSync(absPath, 'utf8');
  return JSON.parse(raw);
}

function parsePointer(inputFixture) {
  const hashIndex = inputFixture.indexOf('#');
  if (hashIndex === -1) {
    throw new Error(`inputFixture pointer missing '#scenarioId' suffix: ${inputFixture}`);
  }
  return {
    relPath: inputFixture.slice(0, hashIndex),
    scenarioId: inputFixture.slice(hashIndex + 1),
  };
}

/** Recursively list every *.json fixture data file under the corpus root, excluding the manifest and its schema. */
function listFixtureFiles() {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.json')) {
        if (full === MANIFEST_PATH) continue;
        if (entry.name === 'manifest.schema.json') continue;
        out.push(full);
      }
    }
  }
  walk(CORPUS_ROOT);
  return out;
}

function loadManifest() {
  return readJson(MANIFEST_PATH);
}

/**
 * Loads the manifest and, for every scenario, the fixture record it points
 * to. Throws if a pointer cannot be resolved (dangling reference).
 */
function loadCorpus() {
  const manifest = loadManifest();
  const fileCache = new Map();

  const scenarios = manifest.scenarios.map((scenario) => {
    const { relPath, scenarioId } = parsePointer(scenario.inputFixture);
    const absPath = path.join(CORPUS_ROOT, relPath);

    if (!fileCache.has(absPath)) {
      if (!fs.existsSync(absPath)) {
        throw new Error(`scenario '${scenario.scenarioId}' points to a missing file: ${relPath}`);
      }
      fileCache.set(absPath, readJson(absPath));
    }
    const fixtureFile = fileCache.get(absPath);
    const record = (fixtureFile.records || []).find((r) => r.scenarioId === scenarioId);
    if (!record) {
      throw new Error(
        `scenario '${scenario.scenarioId}' points to '${relPath}#${scenarioId}' but no record with that scenarioId exists there`,
      );
    }
    if (record.scenarioId !== scenario.scenarioId) {
      throw new Error(
        `scenario '${scenario.scenarioId}' resolves to a record whose own scenarioId ('${record.scenarioId}') pointed at via a different id ('${scenarioId}') - pointer and record disagree`,
      );
    }

    return { manifestEntry: scenario, record, fixtureFileCategory: fixtureFile.category, relPath };
  });

  return { manifest, scenarios, fileCache };
}

module.exports = { loadCorpus, loadManifest, listFixtureFiles, parsePointer, CORPUS_ROOT, MANIFEST_PATH };
