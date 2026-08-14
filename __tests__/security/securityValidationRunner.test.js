const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');

test('security validation reports the expected hostile ZAP rejection as a passing check', () => {
  const result = spawnSync('node', ['security/scripts/run-security-validation.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 60_000,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout);
  assert.equal(report.failed, 0);
  assert.equal(report.results.find(
    (entry) => entry.name === 'ZAP target validation matrix localhost reject',
  )?.ok, true);
});
