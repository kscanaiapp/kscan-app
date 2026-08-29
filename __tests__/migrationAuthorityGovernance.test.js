// Negative controls for the central migration-authority validator
// (scripts/verify-migration-authority.js). Proves the tooling actually
// detects corruption before trusting it to gate anything, then confirms
// the real repo state is clean. Uses a scratch fixture directory (os.tmpdir)
// -- never touches the real supabase/migrations/ tree or the real manifest.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { verifyMigrationAuthority, sha256 } = require('../scripts/verify-migration-authority');

const REPO_ROOT = path.resolve(__dirname, '..');

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-authority-fixture-'));
  fs.mkdirSync(path.join(dir, 'supabase', 'migrations'), { recursive: true });
  return dir;
}

function writeMigrationFile(dir, relPath, body) {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, `-- provenance header\n-- more header\n\n${body}`, 'utf8');
  return sha256(body);
}

function baseManifestAndFixture() {
  const dir = makeFixture();
  const bodyA = 'create table public.a (id uuid primary key);';
  const bodyB = 'create table public.b (id uuid primary key);';
  const hashA = writeMigrationFile(dir, 'supabase/migrations/20260101000000_a.sql', bodyA);
  const hashB = writeMigrationFile(dir, 'supabase/migrations/20260102000000_b.sql', bodyB);
  const manifest = {
    knownSourceRepos: ['kscan-app', 'kscan-glasses-webapp'],
    entries: [
      {
        ledgerVersion: '20260101000000', logicalName: 'a', sourceRepo: 'kscan-app',
        canonicalFilename: 'supabase/migrations/20260101000000_a.sql', canonicalSqlHash: hashA,
      },
      {
        ledgerVersion: '20260102000000', logicalName: 'b', sourceRepo: 'kscan-glasses-webapp',
        canonicalFilename: 'supabase/migrations/20260102000000_b.sql', canonicalSqlHash: hashB,
      },
    ],
  };
  return { dir, manifest, bodyA, bodyB, hashA, hashB };
}

test('clean fixture passes with zero violations', () => {
  const { dir, manifest } = baseManifestAndFixture();
  assert.deepEqual(verifyMigrationAuthority(manifest, dir), []);
});

test('negative control 1: missing canonical ledger version (file absent)', () => {
  const { dir, manifest } = baseManifestAndFixture();
  fs.unlinkSync(path.join(dir, 'supabase/migrations/20260102000000_b.sql'));
  const violations = verifyMigrationAuthority(manifest, dir);
  assert.ok(violations.some((v) => v.includes('does not exist on disk')), violations.join('\n'));
});

test('negative control 2: altered canonical SQL hash (file content changed after manifest was written)', () => {
  const { dir, manifest } = baseManifestAndFixture();
  fs.writeFileSync(
    path.join(dir, 'supabase/migrations/20260101000000_a.sql'),
    '-- provenance header\n-- more header\n\ncreate table public.a (id uuid primary key, injected_column text);',
    'utf8',
  );
  const violations = verifyMigrationAuthority(manifest, dir);
  assert.ok(violations.some((v) => v.includes('canonicalSqlHash mismatch')), violations.join('\n'));
});

test('negative control 3: duplicate ledger version', () => {
  const { dir, manifest, hashA } = baseManifestAndFixture();
  manifest.entries.push({
    ledgerVersion: '20260101000000', logicalName: 'a-duplicate', sourceRepo: 'kscan-app',
    canonicalFilename: 'supabase/migrations/20260101000000_a.sql', canonicalSqlHash: hashA,
  });
  const violations = verifyMigrationAuthority(manifest, dir);
  assert.ok(violations.some((v) => v.includes('Duplicate ledgerVersion')), violations.join('\n'));
});

test('negative control 4: wrong source repository metadata (not in knownSourceRepos)', () => {
  const { dir, manifest } = baseManifestAndFixture();
  manifest.entries[0].sourceRepo = 'some-unrelated-repo';
  const violations = verifyMigrationAuthority(manifest, dir);
  assert.ok(violations.some((v) => v.includes('unknown sourceRepo')), violations.join('\n'));
});

test('negative control 5: provenance entry pointing at the wrong canonical file (version prefix mismatch)', () => {
  const { dir, manifest } = baseManifestAndFixture();
  manifest.entries[0].canonicalFilename = 'supabase/migrations/20260102000000_b.sql';
  const violations = verifyMigrationAuthority(manifest, dir);
  assert.ok(
    violations.some((v) => v.includes('version prefix') && v.includes('does not equal ledgerVersion')),
    violations.join('\n'),
  );
  assert.ok(violations.some((v) => v.includes('Duplicate canonicalFilename')), violations.join('\n'));
});

test('negative control 6: undeclared foreign-repository migration (extra file on disk with no manifest entry is not itself a violation, but a manifest entry claiming a nonexistent file is)', () => {
  // The validator's contract is "every manifest entry must be backed by a
  // real, hash-matching file" -- it does not scan supabase/migrations/ for
  // extra undeclared files (that is `supabase db push`'s own job). What it
  // DOES catch is the inverse and more dangerous case: a manifest entry
  // that claims to centralize a foreign migration but points at a file
  // that was never actually added -- i.e. "declared but not backed."
  const { dir, manifest } = baseManifestAndFixture();
  manifest.entries.push({
    ledgerVersion: '20260824175813', logicalName: 'create_investor_inquiries', sourceRepo: 'kscan-website',
    canonicalFilename: 'supabase/migrations/20260824175813_create_investor_inquiries.sql',
    canonicalSqlHash: '0000000000000000000000000000000000000000000000000000000000000000',
  });
  const violations = verifyMigrationAuthority(manifest, dir);
  assert.ok(violations.some((v) => v.includes('does not exist on disk')), violations.join('\n'));
});

test('the real repo manifest and migration tree pass with zero violations', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'config', 'migration-authority-manifest.json'), 'utf8'),
  );
  const violations = verifyMigrationAuthority(manifest, REPO_ROOT);
  assert.deepEqual(violations, [], violations.join('\n'));
});

test('the real manifest accounts for exactly 22 entries, 18 kscan-app-owned + 3 kscan-glasses-webapp + 1 kscan-website', () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'config', 'migration-authority-manifest.json'), 'utf8'),
  );
  assert.equal(manifest.entries.length, 22);
  const byOwner = manifest.entries.reduce((acc, e) => {
    acc[e.logicalOwner] = (acc[e.logicalOwner] || 0) + 1;
    return acc;
  }, {});
  assert.equal(byOwner['kscan-app'], 18);
  assert.equal(byOwner['kscan-glasses-webapp'], 3);
  assert.equal(byOwner['kscan-website'], 1);
});
