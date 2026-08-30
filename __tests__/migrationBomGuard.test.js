// Repository-wide UTF-8 BOM guard for supabase/migrations (Build 25 Phase 1
// addendum — INFRA-01).
//
// A leading EF BB BF byte sequence makes the Supabase CLI migration applier
// fail at statement zero with a syntax error near the invisible BOM
// character, which blocks a clean replay from an empty database. This test
// protects the entire migrations directory, not just the three files that
// were known to be affected — any future migration saved with a BOM-emitting
// editor must fail this test.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/** Pure detector: true if the given buffer starts with a UTF-8 BOM. */
function hasLeadingUtf8Bom(buffer) {
  return (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
  );
}

function listMigrationSqlFiles() {
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.sql'))
    .map((entry) => entry.name)
    .sort();
}

// -- Negative-control: the detector itself must actually detect a BOM ------

test('detector rejects a BOM-prefixed buffer (negative control)', () => {
  const bomPrefixed = Buffer.concat([UTF8_BOM, Buffer.from('-- select 1;\n', 'utf8')]);
  assert.equal(hasLeadingUtf8Bom(bomPrefixed), true);
});

test('detector accepts a normal UTF-8 buffer with no BOM (negative control)', () => {
  const clean = Buffer.from('-- select 1;\n', 'utf8');
  assert.equal(hasLeadingUtf8Bom(clean), false);
});

test('detector does not false-positive on bytes that merely start with 0xef', () => {
  // 0xEF alone (or 0xEF followed by non-BOM bytes) must not trigger a match —
  // only the exact three-byte EF BB BF sequence counts.
  const notABom = Buffer.from([0xef, 0x00, 0x00, 0x2d, 0x2d]);
  assert.equal(hasLeadingUtf8Bom(notABom), false);
});

test('detector handles a buffer shorter than 3 bytes safely', () => {
  assert.equal(hasLeadingUtf8Bom(Buffer.from([0xef, 0xbb])), false);
  assert.equal(hasLeadingUtf8Bom(Buffer.alloc(0)), false);
});

// -- Real coverage: every migration file in the repository -----------------

test('every migration under supabase/migrations exists and is enumerable', () => {
  const files = listMigrationSqlFiles();
  assert.ok(files.length > 0, 'expected at least one migration file');
});

test('no migration file begins with a UTF-8 BOM', () => {
  const files = listMigrationSqlFiles();
  const offenders = [];
  for (const name of files) {
    const fullPath = path.join(MIGRATIONS_DIR, name);
    const buffer = fs.readFileSync(fullPath);
    if (hasLeadingUtf8Bom(buffer)) {
      offenders.push(path.relative(ROOT, fullPath));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `migration file(s) with a leading UTF-8 BOM (breaks clean replay from an empty database): ${offenders.join(', ')}`,
  );
});

// -- Regression pin: the three specific files this repair targeted ---------

test('the three previously-affected migrations no longer carry a BOM', () => {
  const affected = [
    '202607200001_elise_generation_quota_idempotency.sql',
    '202607210001_elise_generation_resilience_e2.sql',
    '20260721090920_fix_elise_quota_after_generation_reservation.sql',
  ];
  for (const name of affected) {
    const fullPath = path.join(MIGRATIONS_DIR, name);
    assert.ok(fs.existsSync(fullPath), `expected migration to still exist: ${name}`);
    const buffer = fs.readFileSync(fullPath);
    assert.equal(hasLeadingUtf8Bom(buffer), false, `${name} must not begin with a BOM`);
    // The file must still start with a normal SQL comment, not garbage —
    // proves this was a clean 3-byte strip, not truncation.
    assert.match(buffer.subarray(0, 2).toString('utf8'), /^--$/);
  }
});
