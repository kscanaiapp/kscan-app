const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

test('full-suite failure preserves report beyond pipe buffer and final failure identity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kscan-suite-output-'));
  try {
    fs.mkdirSync(path.join(root, 'config'));
    fs.writeFileSync(path.join(root, 'config/test-failure-baseline.json'), JSON.stringify({ failures: [] }));
    fs.writeFileSync(path.join(root, 'large.test.js'), `
      const test = require('node:test');
      test('large output before failure', () => console.log('x'.repeat(200000)));
      test('final failure identity after pipe buffer', () => { throw new Error('intentional fixture failure'); });
    `);
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const result = spawnSync(process.execPath, [path.resolve(__dirname, '../scripts/run-all-tests.js'), root],
      { cwd: root, env, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    assert.equal(result.status, 1);
    assert.ok(result.stdout.length > 200000);
    assert.match(result.stdout, /final failure identity after pipe buffer/);
    assert.match(result.stderr, /unexpected: 1/);
    assert.match(result.stderr, /Unexpected failing tests/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
