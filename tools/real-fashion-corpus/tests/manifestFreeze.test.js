'use strict';

/**
 * Negative control: the "split/freeze mutant" (spec section 19).
 *
 * "Change a case assignment or corpus record after manifest generation.
 *  Manifest/freeze validation must detect the mutation."
 *
 * Two independent mechanisms exist to catch exactly this, and this file
 * proves both:
 *
 *   1. `corpusStore.js#buildCorpusManifest` binds every record's FULL content
 *      (via `canonicalHash`) into each entry's `contentHash`, which in turn
 *      feeds `corpusHash`. Any later mutation - including a V2-only field
 *      like `ontology` or `failureTaxonomy` that has nothing to do with the
 *      legacy schema - changes the manifest's identity. This extends
 *      INVARIANT 42.10 in tests/invariants.test.js (which already proves
 *      this for a plain attribute change) to the new V2 surface.
 *
 *   2. `validator.js#validateCorpusOnDisk` independently RE-DERIVES each
 *      case's expected partition from `assignPartition(garmentId,
 *      holdoutFraction)` and fails loudly (`PARTITION_INCONSISTENT`) if the
 *      record stored on disk disagrees - so a case whose `partition` field
 *      is tampered with after the manifest was generated cannot silently
 *      pass as still belonging to the partition the freeze recorded.
 *
 * The on-disk half uses a real temp corpus directory (fs.mkdtempSync) and
 * calls the real `validateCorpusOnDisk`, not a mock - this is deliberately
 * the more expensive, more honest proof, mirroring controlArmFidelity.test.js
 * and fmqIntegrationV2.test.js's own choice to exercise real production code
 * paths rather than reimplementing their behavior in the test.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildCorpusManifest, loadCorpusConfig } = require('../lib/corpusStore');
const { validateCorpusOnDisk } = require('../lib/validator');
const { assignPartition } = require('../lib/holdout');
const { makeGarment, makeCase } = require('./fixtures/sampleRecords');

/* ================================================================== *
 * 1. Manifest hash binds the new V2 surface
 * ================================================================== */

test('MANIFEST FREEZE: mutating a garment\'s ontology block after manifest generation changes the corpus hash', () => {
  const config = loadCorpusConfig();
  const category = 'outerwear';
  const original = makeGarment({ category, attributes: { colorFamily: 'navy' } });
  // A hand-tampered ontology - not recomputed from attributes, exactly the
  // shape of corruption the freeze must catch (a record edited in place
  // after the manifest already vouched for it).
  const tampered = makeGarment({
    category,
    attributes: { colorFamily: 'navy' },
    ontology: { ...original.ontology, primaryColor: { value: 'black', family: 'black', raw: 'navy' } },
  });

  const before = buildCorpusManifest({ config, garments: [original], cases: [] });
  const after = buildCorpusManifest({ config, garments: [tampered], cases: [] });
  assert.notEqual(before.corpusHash, after.corpusHash);
  assert.notEqual(before.garments[0].contentHash, after.garments[0].contentHash);
});

test('MANIFEST FREEZE: mutating a case\'s V2 spatial annotations or failure taxonomy after manifest generation changes the corpus hash', () => {
  const config = loadCorpusConfig();
  const garment = makeGarment();
  const original = makeCase({ assetTier: 'REAL_CAPTURE', pipelineTestPurpose: undefined });
  const mutated = makeCase({
    assetTier: 'REAL_CAPTURE',
    pipelineTestPurpose: undefined,
    failureTaxonomy: ['BLACK_NAVY_CONFUSION'],
  });

  const before = buildCorpusManifest({ config, garments: [garment], cases: [original] });
  const after = buildCorpusManifest({ config, garments: [garment], cases: [mutated] });
  assert.notEqual(before.corpusHash, after.corpusHash);
  assert.notEqual(before.cases[0].contentHash, after.cases[0].contentHash);
});

test('MANIFEST FREEZE: the manifest itself declares the ontology contract version it was frozen against', () => {
  const config = loadCorpusConfig();
  const manifest = buildCorpusManifest({ config, garments: [], cases: [] });
  assert.equal(manifest.ontologyVersion, 'canonical-fashion-attributes-v1');
});

/* ================================================================== *
 * 2. The independent on-disk validator re-derives partition assignment
 * ================================================================== */

function writeTempCorpus() {
  const corpusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rfc-freeze-mutant-'));
  fs.mkdirSync(path.join(corpusDir, 'garments'));
  fs.mkdirSync(path.join(corpusDir, 'cases'));

  const holdoutFraction = 0.25;
  fs.writeFileSync(
    path.join(corpusDir, 'corpus.json'),
    JSON.stringify({
      corpusId: 'freeze-mutant-test-corpus',
      corpusVersion: '0.0.0-test',
      policyVersions: loadCorpusConfig().policyVersions,
      holdout: { fractionTarget: holdoutFraction },
    }),
  );

  const garment = makeGarment();
  fs.writeFileSync(path.join(corpusDir, 'garments', `${garment.garmentId}.json`), JSON.stringify(garment));

  // The deterministic split is the only source of truth for where this
  // garment's cases belong - computed here exactly as validateCorpusOnDisk
  // computes it, so this fixture is never accidentally testing the wrong
  // starting condition.
  const correctPartition = assignPartition(garment.garmentId, holdoutFraction);
  const record = makeCase({
    assetTier: 'REAL_CAPTURE',
    pipelineTestPurpose: undefined,
    partition: correctPartition,
  });
  const casePath = path.join(corpusDir, 'cases', `${record.caseId}.json`);
  fs.writeFileSync(casePath, JSON.stringify(record));

  return { corpusDir, casePath, record, correctPartition };
}

test('FREEZE MUTANT: a correctly-partitioned corpus validates clean', () => {
  const { corpusDir } = writeTempCorpus();
  try {
    const result = validateCorpusOnDisk({ corpusDir });
    assert.equal(result.passed, true, JSON.stringify(result.findings, null, 2));
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
});

test('FREEZE MUTANT: tampering with a case\'s stored partition after manifest generation is caught by the independent validator', () => {
  const { corpusDir, casePath, record, correctPartition } = writeTempCorpus();
  try {
    // Simulate the exact mutation the spec describes: a case's assignment is
    // changed after the fact, as if a record were hand-edited or a bug in
    // some future migration silently rewrote it.
    const tamperedPartition = correctPartition === 'development' ? 'holdout' : 'development';
    fs.writeFileSync(casePath, JSON.stringify({ ...record, partition: tamperedPartition }));

    const result = validateCorpusOnDisk({ corpusDir });
    assert.equal(result.passed, false);
    assert.ok(
      result.findings.some((f) => f.code === 'PARTITION_INCONSISTENT' && f.caseId === record.caseId),
      JSON.stringify(result.findings),
    );
  } finally {
    fs.rmSync(corpusDir, { recursive: true, force: true });
  }
});
