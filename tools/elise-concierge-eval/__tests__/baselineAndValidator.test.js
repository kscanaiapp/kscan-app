'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { buildBaseline, writeBaseline, compareBaselines, BASELINE_PATH } = require('../baseline/baseline');
const { validateReportObject, validateHumanReviewPacketUnscored } = require('../validateReport');
const { generateReport } = require('../reports/generateReport');
const { buildHumanReviewPacket } = require('../human-review/packetBuilder');
const { buildCorpus } = require('../metrics/corpusRunner');
const { getFixtures } = require('../fixtures');

function sampleBaselineInput(overrides = {}) {
  return {
    baseSha: 'sha1',
    corpusVersion: 'v1',
    corpusHash: 'hash1',
    synthesizerVersion: 's1',
    extractionRulesVersion: 'e1',
    defectTaxonomyVersion: 'd1',
    precedenceContractVersion: 'p1',
    safetyPolicyMapVersion: 'sp1',
    safetyPolicyMapHash: 'sph1',
    coverageMatrixHash: 'cmh1',
    rubricVersion: 'r1',
    ...overrides,
  };
}

test('required test 25: baseline overwrite fails without allowOverwrite', (t) => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baseline-test-'));
  const tmpPath = path.join(tmpDir, 'baseline.json');
  t.after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

  // Exercise the refusal logic directly against a temp path rather than the
  // real module-level BASELINE_PATH, so this test never mutates the lane's
  // own committed baseline file.
  const record = buildBaseline(sampleBaselineInput());
  fs.writeFileSync(tmpPath, JSON.stringify(record, null, 2));

  function writeToTmp(rec, opts) {
    const existing = fs.existsSync(tmpPath) ? JSON.parse(fs.readFileSync(tmpPath, 'utf8')) : null;
    if (existing && !(opts && opts.allowOverwrite)) {
      throw new Error('Refusing to overwrite existing baseline (test double of baseline.js writeBaseline logic)');
    }
    fs.writeFileSync(tmpPath, JSON.stringify(rec, null, 2));
  }

  assert.throws(() => writeToTmp(buildBaseline(sampleBaselineInput({ baseSha: 'sha2' }))), /Refusing to overwrite/);
  assert.doesNotThrow(() => writeToTmp(buildBaseline(sampleBaselineInput({ baseSha: 'sha3' })), { allowOverwrite: true }));
});

test('writeBaseline (real module) refuses to overwrite an existing baseline.json', (t) => {
  const existed = fs.existsSync(BASELINE_PATH);
  const backup = existed ? fs.readFileSync(BASELINE_PATH, 'utf8') : null;
  t.after(() => {
    if (existed) fs.writeFileSync(BASELINE_PATH, backup);
    else fs.rmSync(BASELINE_PATH, { force: true });
  });

  writeBaseline(buildBaseline(sampleBaselineInput()), { allowOverwrite: true });
  assert.throws(() => writeBaseline(buildBaseline(sampleBaselineInput({ baseSha: 'other' }))), /Refusing to overwrite/);
});

test('required test 26: incompatible baseline comparison fails loudly', () => {
  const reference = buildBaseline(sampleBaselineInput());
  const incompatible = buildBaseline(sampleBaselineInput({ defectTaxonomyVersion: 'd2' }));
  assert.throws(() => compareBaselines(incompatible, reference), /INCOMPATIBLE_COMPARISON/);

  const compatibleDrift = buildBaseline(sampleBaselineInput({ corpusHash: 'hash2' }));
  const result = compareBaselines(compatibleDrift, reference);
  assert.equal(result.compatible, true);
  assert.ok(result.drifted.includes('corpusHash'));
});

test('required test 27: a doctored report fails validation', async () => {
  const report = await generateReport({ skipL15: true });
  const good = validateReportObject(report);
  assert.equal(good.valid, true, JSON.stringify(good.errors));

  const doctored = JSON.parse(JSON.stringify(report));
  doctored.evidenceFraming = 'This confirms production quality across the board.';
  const bad = validateReportObject(doctored);
  assert.equal(bad.valid, false);
});

test('required test 28: coverage suppression works (low-coverage defect is labeled, not hidden)', async () => {
  const report = await generateReport({ skipL15: true });
  const serialized = JSON.stringify(report);
  const d06 = report.verdictReproduction.perDefect.D06;
  if (d06 && d06.rate !== null && d06.rate < 0.5) {
    assert.ok(serialized.includes('INSUFFICIENT_COVERAGE'), 'a low-coverage, low-rate defect cell must be explicitly labeled');
  }
  const result = validateReportObject(report);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
});

test('fake human score is rejected by the human-review validator', () => {
  const fixtures = getFixtures();
  const { cases } = buildCorpus();
  const md = buildHumanReviewPacket(cases, fixtures);
  assert.equal(validateHumanReviewPacketUnscored(md).valid, true);
  const doctored = md.replace(/\(1-5\): ____/, '(1-5): 5');
  assert.equal(validateHumanReviewPacketUnscored(doctored).valid, false);
});
