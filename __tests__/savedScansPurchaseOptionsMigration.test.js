const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MIGRATION_NAME = '20260717201524_20260716035943_add_purchase_options_to_saved_scans.sql';
const migrationPath = path.join(ROOT, 'supabase', 'migrations', MIGRATION_NAME);
const migration = fs.readFileSync(migrationPath, 'utf8');

test('purchase-options migration restores the applied production history version', () => {
  assert.ok(fs.existsSync(migrationPath));
  assert.ok(MIGRATION_NAME.startsWith('20260717201524_'));
});

test('purchase-options migration is additive and preserves legacy rows', () => {
  assert.match(migration, /alter table public\.saved_scans[\s\S]*add column if not exists purchase_options jsonb/i);
  assert.match(migration, /not null[\s\S]*default '\[\]'::jsonb/i);
  assert.doesNotMatch(migration, /drop\s+(?:table|column)|truncate|delete\s+from|update\s+public\.saved_scans/i);
});

test('purchase-options migration constrains snapshots to JSON arrays', () => {
  assert.match(migration, /saved_scans_purchase_options_is_array/);
  assert.match(migration, /check \(jsonb_typeof\(purchase_options\) = 'array'\)/i);
});

test('purchase-options migration does not alter RLS, grants, auth, or storage', () => {
  assert.doesNotMatch(migration, /policy|row level security|\bgrant\b|\brevoke\b|auth\.|storage\./i);
});
