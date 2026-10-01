const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const migration = read(
  'supabase',
  'migrations',
  '20261001204903_canonical_closet_owned_look_support.sql',
);
const ownedTypes = read('types', 'ownedClosetItem.ts');
const ownedService = read('services', 'ownedClosetItems.ts');
const styleObjects = read('services', 'styleObjects.ts');
const styleObjectTypes = read('types', 'styleObjects.ts');
const styleOutfits = read('services', 'styleOutfits.ts');
const edgeIndex = read('supabase', 'functions', 'style-outfit-generate', 'index.ts');
const edgeValidation = read('supabase', 'functions', 'style-outfit-generate', 'validation.ts');
const builder = read('app', 'looks', 'create.tsx');
const stylist = read('app', 'stylist', 'index.tsx');

test('forward migration adds only bounded canonical owned-Look schema support', () => {
  assert.match(migration, /add column if not exists source_closet_item_id uuid/);
  assert.match(migration, /references public\.user_closet_items\(id\) on delete set null/);
  assert.match(migration, /look_items_source_closet_item_idx/);
  assert.match(migration, /source_type in \([\s\S]*?'dressing_room_item'[\s\S]*?'closet_item'/);
  assert.match(migration, /num_nonnulls\([\s\S]*source_closet_item_id[\s\S]*\) <= 1/);
  assert.doesNotMatch(migration, /drop table|drop column/i);
});

test('snapshot branch is actor-scoped, active-only, bounded, and primary-media backed', () => {
  const closetBranch = migration.slice(
    migration.indexOf("elsif p_source_type = 'closet_item'"),
    migration.indexOf("return null;\nend;", migration.indexOf("elsif p_source_type = 'closet_item'")),
  );
  assert.match(migration, /p_owner_id <> auth\.uid\(\)/);
  assert.match(closetBranch, /from public\.user_closet_items/);
  assert.match(closetBranch, /user_id = p_owner_id/);
  assert.match(closetBranch, /deleted_at is null/);
  assert.match(closetBranch, /public\.has_active_k_plus\(\)/);
  assert.match(closetBranch, /'sourceType', 'closet_item'/);
  assert.match(closetBranch, /closet_row\.clothing_type/);
  assert.match(closetBranch, /closet_row\.storage_path/);
  assert.doesNotMatch(closetBranch, /closet_row\.(?:notes|user_id|client_id|row_version)/);
  assert.doesNotMatch(closetBranch, /thumbnail_storage_path|signedUrl|createSignedUrl/);
});

test('snapshot helper remains internal and owned-Look RPC grants remain authenticated-only', () => {
  assert.match(migration, /revoke all on function public\.build_owned_item_snapshot[^;]+from authenticated/);
  for (const name of ['create_look_from_owned_items', 'update_look_owned_items']) {
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[^;]+from public`));
    assert.match(migration, new RegExp(`revoke all on function public\\.${name}[^;]+from anon`));
    assert.match(migration, new RegExp(`grant execute on function public\\.${name}[^;]+to authenticated`));
  }
});

test('create and update persist canonical FK without converting source identity', () => {
  const accepts = migration.match(/entry_source_type not in \('saved_scan', 'inspiration_item', 'closet_item'\)/g) ?? [];
  const fkWrites = migration.match(/case when entry_source_type = 'closet_item' then entry_source_id else null end/g) ?? [];
  assert.equal(accepts.length, 2);
  assert.equal(fkWrites.length, 2);
  assert.match(styleObjects, /sourceType: OwnedItemSourceType/);
  assert.match(styleObjects, /sourceClosetItemId: row\.source_closet_item_id/);
  assert.match(styleObjectTypes, /sourceClosetItemId\?: string \| null/);
});

test('canonical Closet is picker and server-pool primary without fuzzy cross-source dedupe', () => {
  assert.match(ownedTypes, /'saved_scan', 'inspiration_item', 'closet_item'/);
  assert.ok(ownedService.indexOf("from('user_closet_items')") < ownedService.indexOf("from('saved_scans')"));
  assert.match(ownedService, /normalizeClosetItemRow/);
  assert.match(ownedService, /no fuzzy dedupe/is);
  assert.ok(edgeIndex.indexOf('buildCandidatesFromClosetItems') < edgeIndex.indexOf('buildCandidatesFromSavedScans'));
  assert.match(edgeIndex, /from\('user_closet_items'\)[\s\S]*?\.eq\('user_id', userId\)[\s\S]*?\.is\('deleted_at', null\)/);
  assert.match(edgeValidation, /buildCandidatesFromClosetItems/);
});

test('closed canonical refs flow through request, response, save, and edit contracts', () => {
  assert.match(edgeValidation, /OwnedSourceType = 'saved_scan' \| 'inspiration_item' \| 'closet_item'/);
  assert.match(styleOutfits, /isOwnedItemSourceType\(sourceType\)/);
  assert.match(builder, /lookItem\.sourceClosetItemId/);
  assert.match(builder, /\? 'closet_item'/);
  assert.match(stylist, /isOwnedItemSourceType\(params\.anchorSourceType\)/);
});

test('canonical source support is shared across Android and iOS', () => {
  for (const source of [ownedTypes, ownedService, styleObjects, styleOutfits, builder, stylist]) {
    assert.doesNotMatch(source, /Platform\.OS\s*(?:===|!==).*closet_item/);
  }
});
