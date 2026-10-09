'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { zapRetryContractViolations } = require('../security/scripts/validate-zap-target');

const ROOT = path.resolve(__dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github/workflows/zap-baseline-staging.yml'), 'utf8');

function mutated(from, to) {
  assert.ok(WORKFLOW.includes(from), `fragment missing: ${from}`);
  return WORKFLOW.replace(from, to);
}

test('the shipped ZAP baseline workflow satisfies the bounded-retry contract', () => {
  assert.deepEqual(zapRetryContractViolations(WORKFLOW), []);
});

test('the validator self-test (run in CI before the scan) reports the retry contract as PASS', () => {
  const result = spawnSync(process.execPath, [path.join(ROOT, 'security/scripts/validate-zap-target.js'), '--self-test'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS ZAP baseline retries only an operational \(no-report\) failure, once, and still fails closed/);
});

// Negative controls: each way the retry could become a fail-open or a result-shopping loop is rejected.
const MUTANTS = [
  ['more than one retry', () => mutated('MAX_ATTEMPTS=2', 'MAX_ATTEMPTS=3'), /MAX_ATTEMPTS/],
  ['unbounded loop (attempt cap removed)', () => mutated('[ "${ATTEMPT}" -ge "${MAX_ATTEMPTS}" ]', 'false'), /loop must leave only/],
  ['retry on the scan exit code instead of a missing report', () => mutated('if [ -f zap-out/zap-baseline-report.json ] ||', 'if [ "${CODE}" -eq 0 ] ||'), /loop must leave only/],
  ['stale report not removed before an attempt', () => mutated('rm -f zap-out/zap-baseline-report.json zap-out/zap-baseline-report.md zap-out/zap-baseline-report.html\n', ''), /stale reports/],
  ['a second unguarded docker run', () => mutated('cp .zap/baseline-rules.tsv zap-out/baseline-rules.tsv', 'docker run --rm "${ZAP_IMAGE}" true\n          cp .zap/baseline-rules.tsv zap-out/baseline-rules.tsv'), /exactly one docker run/],
  ['missing report no longer fails closed', () => mutated('echo "Operational failure: zap-baseline-report.json missing"\n            exit 2', 'echo "Operational failure: zap-baseline-report.json missing"\n            exit 0'), /fail closed/],
  ['report no longer parsed as JSON before acceptance', () => mutated('print("zap-baseline-report.json: valid JSON")', 'print("skipped")'), /parsed as JSON/],
  ['a failure swallowed with || true', () => mutated('set -e\n            if [ -f', 'set -e\n            true || true\n            if [ -f'), /swallow/],
  ['continue-on-error on the job', () => mutated('timeout-minutes: 45', 'timeout-minutes: 45\n    continue-on-error: true'), /swallow/],
];
for (const [name, build, expected] of MUTANTS) {
  test(`MUTATION: ${name} is rejected`, () => {
    assert.match(zapRetryContractViolations(build()).join('\n'), expected);
  });
}
