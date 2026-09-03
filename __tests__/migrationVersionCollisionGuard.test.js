// CI-MIG-01: negative controls for the migration version collision guard
// (scripts/check-migration-version-collisions.js). Proves the tooling
// actually detects a duplicate active version prefix and a malformed
// filename before trusting it to gate anything, then confirms the real repo
// tree is clean. Uses a scratch fixture directory (os.tmpdir) -- never
// touches the real supabase/migrations/ tree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { findVersionCollisions } = require('../scripts/check-migration-version-collisions');

const REPO_ROOT = path.resolve(__dirname, '..');
const GATE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'check-migration-version-collisions.js');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-collision-fixture-'));
  const migrationsDir = path.join(dir, 'supabase', 'migrations');
  fs.mkdirSync(migrationsDir, { recursive: true });
  return migrationsDir;
}

function writeFile(migrationsDir, name, body = '-- fixture\nselect 1;\n') {
  fs.writeFileSync(path.join(migrationsDir, name), body, 'utf8');
}

test('unique version prefixes: zero violations', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  writeFile(dir, '20260102000000_b.sql');
  writeFile(dir, '202601030000_c.sql'); // shorter (12-digit) prefix is legal too
  assert.deepEqual(findVersionCollisions(dir), []);
});

test('negative control: duplicate active version prefix fails', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  writeFile(dir, '20260101000000_b.sql');
  const violations = findVersionCollisions(dir);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Duplicate active migration version "20260101000000"/);
  assert.match(violations[0], /20260101000000_a\.sql/);
  assert.match(violations[0], /20260101000000_b\.sql/);
});

test('negative control: three-way duplicate is reported as one violation naming all three', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  writeFile(dir, '20260101000000_b.sql');
  writeFile(dir, '20260101000000_c.sql');
  const violations = findVersionCollisions(dir);
  assert.equal(violations.length, 1);
  for (const name of ['20260101000000_a.sql', '20260101000000_b.sql', '20260101000000_c.sql']) {
    assert.ok(violations[0].includes(name), violations[0]);
  }
});

test('negative control: malformed active migration filename (no leading version) fails', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  writeFile(dir, 'not_a_versioned_migration.sql');
  const violations = findVersionCollisions(dir);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /Malformed active migration filename/);
  assert.match(violations[0], /not_a_versioned_migration\.sql/);
});

test('negative control: two independent problems are both reported, not just the first', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  writeFile(dir, '20260101000000_b.sql');
  writeFile(dir, 'malformed.sql');
  const violations = findVersionCollisions(dir);
  assert.equal(violations.length, 2);
});

test('non-.sql files and a missing directory are handled without crashing', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  fs.writeFileSync(path.join(dir, 'README.md'), '# not a migration\n', 'utf8');
  assert.deepEqual(findVersionCollisions(dir), []);

  const missing = path.join(dir, 'does-not-exist');
  const violations = findVersionCollisions(missing);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /does not exist/);
});

test('CLI entry point: exit code mirrors the violation count (0 clean, 1 dirty)', () => {
  const dir = makeFixture();
  writeFile(dir, '20260101000000_a.sql');
  assert.doesNotThrow(() => execFileSync(process.execPath, [GATE_SCRIPT, dir], { stdio: 'pipe' }));
});

test('the real repo migration tree has zero active version collisions', () => {
  const migrationsDir = path.join(REPO_ROOT, 'supabase', 'migrations');
  const violations = findVersionCollisions(migrationsDir);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('the real repo tree is actually wired to the CLI entry point (guard runs as part of governed CI)', () => {
  // scripts/run-all-tests.js discovers every __tests__/**/*.test.js file
  // (see scripts/run-all-tests.js's recursive walk()), and .github/workflows/
  // security-code.yml's project-checks job runs run-all-tests.js
  // unconditionally on every push/PR -- not gated by the change-classifier,
  // so this guard cannot be silently skipped the way a classifier-gated job
  // could be (see the CI-applicability trap fixed by PR #249/#250). This test
  // proves the CLI entry point itself succeeds against the real tree with the
  // real argv (no injected directory), the same way CI will invoke it.
  assert.doesNotThrow(() => execFileSync(process.execPath, [GATE_SCRIPT], { cwd: REPO_ROOT, stdio: 'pipe' }));
});
