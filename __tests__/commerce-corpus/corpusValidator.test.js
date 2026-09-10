/**
 * Commerce Corpus V1 — structural validation (spec section 42).
 *
 * Wraps tools/commerce-corpus/validateCorpus.js's independent checks as
 * node:test assertions, so `node --test __tests__/commerce-corpus` fails
 * the way any other governed test does, without requiring a separate CLI
 * invocation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const { validateManifest } = require('../../tools/commerce-corpus/lib/validateManifest');
const { validateFixtureFiles } = require('../../tools/commerce-corpus/lib/validateFixtureFiles');
const { scanCorpusPrivacy } = require('../../tools/commerce-corpus/lib/scanCorpusPrivacy');
const { loadCorpus } = require('../../tools/commerce-corpus/lib/loadCorpus');
const { checkNoOrphanedRecords, checkMutationsReferenceRealScenarios } = require('../../tools/commerce-corpus/validateCorpus');

test('manifest.json is structurally valid (unique kebab-case IDs, valid enums, resolvable pointers)', () => {
  const { valid, errors } = validateManifest();
  assert.equal(valid, true, `manifest errors:\n  ${errors.join('\n  ')}`);
});

test('every fixture file is well-formed (required fields, no duplicate scenarioIds, no OBSERVED-SHAPE claims)', () => {
  const { valid, errors } = validateFixtureFiles();
  assert.equal(valid, true, `fixture errors:\n  ${errors.join('\n  ')}`);
});

test('no fixture record is orphaned (unreferenced by the manifest)', () => {
  const errors = checkNoOrphanedRecords();
  assert.deepEqual(errors, []);
});

test('every mutation record references a real scenarioId', () => {
  const errors = checkMutationsReferenceRealScenarios();
  assert.deepEqual(errors, []);
});

test('the corpus contains no PII/secrets anywhere (manifest + every fixture file)', () => {
  const result = scanCorpusPrivacy();
  assert.equal(
    result.safe,
    true,
    `privacy violations:\n  ${result.violations.map((v) => `${v.file} at ${v.path}: ${v.reason}`).join('\n  ')}`,
  );
  assert.ok(result.filesScanned > 15, 'sanity check: expected to scan the manifest plus every category file');
});

test('the corpus loads end-to-end and every scenario resolves to its fixture record', () => {
  const { manifest, scenarios } = loadCorpus();
  assert.equal(scenarios.length, manifest.scenarios.length);
  for (const { manifestEntry, record } of scenarios) {
    assert.equal(record.scenarioId, manifestEntry.scenarioId);
  }
});

test('corpus size is within the governed target range, or the excess is explained', () => {
  const { manifest } = loadCorpus();
  const total = manifest.scenarios.length;
  // Section 47 targets 60-100 "meaningful" scenarios. This corpus is 112,
  // driven by explicit mandatory per-category lists (Sections 16, 28, 35, 39
  // each enumerate specific required cases) rather than filler - see
  // docs/commerce-corpus/02-final-report.md "Corpus size" note. This test
  // pins the number so an unreviewed, silent increase is caught.
  assert.equal(total, 112, `scenario count drifted to ${total}; update this pin and the final report's size note together`);
});

test('the manifest schema file and validator enums stay in sync (single source of truth)', () => {
  const { loadSchemaEnums } = require('../../tools/commerce-corpus/lib/validateManifest');
  const enums = loadSchemaEnums();
  assert.ok(enums.evidenceClasses.has('SOURCE-SHAPE'));
  assert.ok(enums.evidenceClasses.has('SYNTHETIC'));
  assert.ok(enums.evidenceClasses.has('OBSERVED-SHAPE'), 'OBSERVED-SHAPE must remain a valid enum value even though no scenario may use it yet');
  assert.equal(path.basename(require.resolve('../../__tests__/fixtures/commerce/manifest.schema.json')), 'manifest.schema.json');
});
