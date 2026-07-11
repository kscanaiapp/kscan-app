// Looks data-model extension contract tests (AI Stylist expansion).
// Static contract checks over migration source + services, in the same style
// as styleObjectsContract.test.js. The migration is source-only in this build;
// live RPC behavior is exercised in the hostile-audit pass with a database.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const legacyMigration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '202605200001_persistent_style_objects.sql'),
  'utf8',
);
const migration = fs.readFileSync(
  path.join(ROOT, 'supabase', 'migrations', '20260711000001_ai_stylist_looks_extension.sql'),
  'utf8',
);
const service = fs.readFileSync(path.join(ROOT, 'services', 'styleObjects.ts'), 'utf8');
const types = fs.readFileSync(path.join(ROOT, 'types', 'styleObjects.ts'), 'utf8');

test('existing Looks remain compatible: legacy columns, RPC, and NULL-source rows preserved', () => {
  // Legacy migration untouched and its RPC still present in repo history/file.
  assert.match(legacyMigration, /create or replace function public\.create_look_from_dressing_room_items/);
  // Extension only adds nullable columns; no drops, no destructive backfill.
  assert.doesNotMatch(migration, /drop column/i);
  assert.doesNotMatch(migration, /drop table/i);
  assert.doesNotMatch(migration, /update public\.looks\s+set source/i);
  assert.match(migration, /add column if not exists source text/);
  assert.match(migration, /source is null or source in \('dressing_room', 'manual', 'ai'\)/);
  // Legacy NULL-source rows are treated as dressing_room in the app.
  assert.match(migration, /legacy rows are NULL and treated as dressing_room/i);
  // Service still exposes the legacy creation path.
  assert.match(service, /create_look_from_dressing_room_items/);
});

test('manual and ai sources are accepted; dressing_room cannot be forged through the new RPC', () => {
  assert.match(migration, /p_source not in \('manual', 'ai'\)/);
  assert.match(service, /source: 'manual' \| 'ai'/);
});

test('two-item minimum and six-item maximum enforced in SQL and client', () => {
  assert.match(migration, /item_count < 2 or item_count > 6/);
  assert.match(service, /LOOK_MIN_ITEMS = 2/);
  assert.match(service, /LOOK_MAX_ITEMS = 6/);
  assert.match(service, /items\.length < LOOK_MIN_ITEMS/);
  assert.match(service, /items\.length > LOOK_MAX_ITEMS/);
});

test('duplicate items are rejected during create and update', () => {
  const duplicateChecks = migration.match(/distinct_count <> item_count/g) ?? [];
  assert.ok(duplicateChecks.length >= 2, 'both RPCs must reject duplicates');
  assert.match(service, /keys\.size !== items\.length/);
});

test('ownership of every remote source is validated server-side', () => {
  assert.match(migration, /user_id = p_owner_id/);
  assert.match(migration, /deleted_at is null/);
  assert.match(migration, /One or more selected items are unavailable/);
});

test('ordering is deterministic (array position becomes zero-based sort order)', () => {
  assert.match(migration, /entry_index integer := 0/);
  assert.match(migration, /entry_index \+ 1/);
  assert.match(migration, /sort_order/);
});

test('create/update are atomic RPCs; a failed item insert aborts the whole Look', () => {
  assert.match(migration, /create or replace function public\.create_look_from_owned_items/);
  assert.match(migration, /create or replace function public\.update_look_owned_items/);
  // Errors raised inside the function roll the transaction back — no empty Look.
  assert.match(migration, /raise exception 'One or more selected items are unavailable'/);
  assert.match(service, /createLookFromOwnedItems/);
  assert.match(service, /updateLookOwnedItems/);
});

test('source deletion preserves rendering: SET NULL refs + bounded v2 snapshots', () => {
  assert.match(migration, /source_saved_scan_id uuid\s*\n?\s*references public\.saved_scans\(id\) on delete set null/);
  assert.match(migration, /source_inspiration_item_id uuid\s*\n?\s*references public\.inspiration_items\(id\) on delete set null/);
  assert.match(migration, /'snapshotVersion', 2/);
  assert.match(service, /OWNED_ITEM_SNAPSHOT_VERSION = 2/);
  assert.match(service, /version === SNAPSHOT_VERSION \|\| version === OWNED_ITEM_SNAPSHOT_VERSION/);
});

test('snapshots are bounded: no analysis_result blobs, products, prompts, or account metadata', () => {
  const builder = migration.slice(
    migration.indexOf('build_owned_item_snapshot'),
    migration.indexOf('create_look_from_owned_items'),
  );
  assert.ok(builder.length > 0);
  assert.doesNotMatch(builder, /'analysis_result'|analysis_result,/);
  assert.doesNotMatch(builder, /products/);
  assert.doesNotMatch(builder, /prompt/i);
  // Only display fields via targeted metadata extraction.
  assert.match(builder, /'category'/);
  assert.match(builder, /'color'/);
  assert.match(builder, /'silhouette'/);
  // No image binary duplication: storage references only.
  assert.match(builder, /'storageBucket', inspiration_row\.storage_bucket/);
  assert.doesNotMatch(migration, /storage\.upload|\.upload\(/);
});

test('deleting a Look never deletes closet items (no cascades into source tables)', () => {
  assert.doesNotMatch(migration, /references public\.saved_scans\(id\) on delete cascade/);
  assert.doesNotMatch(migration, /references public\.inspiration_items\(id\) on delete cascade/);
  assert.doesNotMatch(migration, /delete from public\.saved_scans/);
  assert.doesNotMatch(migration, /delete from public\.inspiration_items/);
});

test('cover rule: first ordered item with a safe remote reference; no generated composite', () => {
  assert.match(migration, /cover_url is null and \(entry_snapshot ->> 'imageUri'\) ~\* '\^https\?:\/\/'/);
  assert.doesNotMatch(migration, /composite|collage/i);
});

test('single owned source per item is enforced', () => {
  assert.match(migration, /look_items_single_owned_source/);
  assert.match(migration, /source_type in \('dressing_room_item', 'saved_scan', 'inspiration_item'\)/);
});

test('legacy Dressing Room-derived Look rendering path is untouched in types', () => {
  assert.match(types, /sourceDressingRoomItemId\?: string \| null/);
  assert.match(types, /export type LookSource = 'dressing_room' \| 'manual' \| 'ai'/);
});

test('RPC grants exclude anon and public', () => {
  assert.match(migration, /revoke all on function public\.create_look_from_owned_items[\s\S]*?from anon/);
  assert.match(migration, /grant execute on function public\.create_look_from_owned_items[\s\S]*?to authenticated/);
  assert.match(migration, /revoke all on function public\.update_look_owned_items[\s\S]*?from anon/);
});
