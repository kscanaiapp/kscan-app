'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { validateCorpus } = require('../schema/fixtureSchema');
const { buildCorpusManifest } = require('../fixtures/manifest');

const SYNTHETIC_DIR = path.join(__dirname, '..', 'fixtures', 'synthetic');
const REAL_DIR = path.join(__dirname, 'real'); // spec section 16C - schema ready, empty until owner-approved

function readFixtureDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== '_manifest.json')
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
    .sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0));
}

/** Load the committed synthetic corpus from disk. */
function loadSyntheticCorpus() {
  return readFixtureDir(SYNTHETIC_DIR);
}

/**
 * Load the approved-real corpus, if any has been placed by the owner under
 * corpus/real/*.json. Returns [] (not an error) when none exists - spec
 * section 4/16C: "No real corpus is required to complete this autonomous
 * build."
 */
function loadApprovedRealCorpus() {
  return readFixtureDir(REAL_DIR);
}

/** Load and validate the full lab corpus (synthetic + any approved-real). */
function loadFullCorpus() {
  const fixtures = [...loadSyntheticCorpus(), ...loadApprovedRealCorpus()];
  const { valid, errors } = validateCorpus(fixtures);
  if (!valid) {
    throw new Error(`CORPUS_VALIDATION_FAILED:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  }
  return fixtures;
}

/** Stable (non-random-per-run) 0..1 bucket value derived from a fixture id. */
function stableBucket(fixtureId) {
  const digest = crypto.createHash('sha256').update(fixtureId).digest();
  return digest.readUInt32BE(0) / 0xffffffff;
}

/**
 * Split a corpus into development/holdout partitions (spec section 17).
 * Deterministic (hash-based on fixtureId, not Math.random), stable across
 * runs and across corpus growth (adding a fixture never reassigns another
 * fixture's partition). Default split: 70% development / 30% holdout.
 * Paired fixtures (pairedFixtureId) are always assigned to the SAME
 * partition as their pair, so platform-parity evaluation is never split
 * across development/holdout.
 */
function splitDevelopmentHoldout(fixtures, developmentRatio = 0.7) {
  const byId = new Map(fixtures.map((f) => [f.fixtureId, f]));
  const partitionOf = new Map();

  function assign(fixture) {
    if (partitionOf.has(fixture.fixtureId)) return partitionOf.get(fixture.fixtureId);
    // A pair takes the partition of whichever id sorts first, so both
    // members converge on one decision regardless of iteration order.
    const pairId = fixture.pairedFixtureId;
    const anchorId = pairId && byId.has(pairId) && pairId < fixture.fixtureId ? pairId : fixture.fixtureId;
    const bucket = stableBucket(anchorId);
    const partition = bucket < developmentRatio ? 'development' : 'holdout';
    partitionOf.set(fixture.fixtureId, partition);
    if (pairId && byId.has(pairId)) partitionOf.set(pairId, partition);
    return partition;
  }

  const development = [];
  const holdout = [];
  for (const fixture of fixtures) {
    const partition = assign(fixture);
    (partition === 'development' ? development : holdout).push(fixture);
  }

  return { development, holdout, developmentRatio };
}

module.exports = {
  loadSyntheticCorpus,
  loadApprovedRealCorpus,
  loadFullCorpus,
  splitDevelopmentHoldout,
  buildCorpusManifest,
  SYNTHETIC_DIR,
  REAL_DIR,
};
