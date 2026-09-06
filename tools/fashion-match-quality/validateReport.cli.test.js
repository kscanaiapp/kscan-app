'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const CLI = path.join(__dirname, 'validateReport.js');
const { RUBRIC_VERSION } = require('./evaluator/rubric');

function tmpJson(content) {
  const file = path.join(os.tmpdir(), `fmql-validate-cli-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(file, content);
  return file;
}

function goodReport() {
  return {
    reportSchemaVersion: 'fmql-report-schema-v1',
    sourceSha: 'a'.repeat(40),
    fixtureManifestHash: 'deadbeef',
    rubricVersion: RUBRIC_VERSION,
    corpusTier: ['SYNTHETIC'],
    generatedAt: new Date().toISOString(),
    metrics: {
      sampleCounts: { totalFixturesEvaluated: 1 },
      identityDistribution: { EXACT: 1 },
      substituteDistribution: { STRONG_SUBSTITUTE: 1 },
      fashionComponentAverages: {},
      duplicateMetrics: {},
      retailerNeutralityMetrics: {},
      captureProfileStratification: {},
    },
    controls: [{ name: 'x', verdict: 'PASS' }],
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

function run(file) {
  return spawnSync(process.execPath, [CLI, file], { encoding: 'utf8' });
}

test('REPORT VALIDATOR CLI: missing report file exits non-zero', () => {
  const result = run(path.join(os.tmpdir(), 'fmql-does-not-exist.json'));
  assert.notEqual(result.status, 0);
});

test('REPORT VALIDATOR CLI: empty report file is rejected (non-zero exit)', () => {
  const file = tmpJson('');
  const result = run(file);
  assert.notEqual(result.status, 0);
  fs.unlinkSync(file);
});

test('REPORT VALIDATOR CLI: malformed JSON is rejected (non-zero exit)', () => {
  const file = tmpJson('{ this is not valid json ');
  const result = run(file);
  assert.notEqual(result.status, 0);
  fs.unlinkSync(file);
});

test('REPORT VALIDATOR CLI: a well-formed report passes (zero exit)', () => {
  const file = tmpJson(JSON.stringify(goodReport()));
  const result = run(file);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  fs.unlinkSync(file);
});

test('REPORT VALIDATOR CLI: a report containing a FAILing control exits non-zero (does not trust a green summary alone)', () => {
  const report = goodReport();
  report.controls.push({ name: 'broken_control', verdict: 'FAIL', detail: 'simulated failure' });
  const file = tmpJson(JSON.stringify(report));
  const result = run(file);
  assert.notEqual(result.status, 0);
  fs.unlinkSync(file);
});

test('REPORT VALIDATOR CLI: a stale rubricVersion claim is rejected independently of what the report itself asserts', () => {
  const report = goodReport();
  report.rubricVersion = 'fmql-rubric-v0-stale';
  const file = tmpJson(JSON.stringify(report));
  const result = run(file);
  assert.notEqual(result.status, 0);
  fs.unlinkSync(file);
});
