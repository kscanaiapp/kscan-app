const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const migrationPath = path.join(
  ROOT,
  'supabase',
  'migrations',
  '20260718151651_include_inspiration_uploads_in_shared_room_preview.sql',
);
const migration = fs.readFileSync(migrationPath, 'utf8');
const screen = fs.readFileSync(path.join(ROOT, 'app', '(public)', 'rooms', '[token].tsx'), 'utf8');
const preview = fs.readFileSync(path.join(ROOT, 'services', 'sharedRoomPreview.js'), 'utf8');
const resolver = fs.readFileSync(path.join(ROOT, 'services', 'sharedRoomImageResolver.ts'), 'utf8');
const edge = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'shared-room-image-url', 'index.ts'),
  'utf8',
);

test('repair is a forward-only RPC replacement with no table, policy, or data destruction', () => {
  assert.match(migration, /create or replace function public\.get_public_room_preview/);
  assert.doesNotMatch(migration, /\b(drop table|truncate|delete from|update public\.|alter table|drop policy)\b/i);
  assert.match(migration, /revoke all on function public\.get_public_room_preview\(text\) from public/);
  assert.match(migration, /grant execute on function public\.get_public_room_preview\(text\) to anon, authenticated/);
});

test('share validation retains malformed, active, view-only, revoked, and expiry gates', () => {
  assert.match(migration, /normalized_token !~\* '\^\[0-9a-f\]/);
  assert.match(migration, /'status', 'malformed'/);
  assert.match(migration, /rs\.access_level = 'view'/);
  assert.match(migration, /rs\.is_active = true/);
  assert.match(migration, /rs\.revoked_at is null/);
  assert.match(migration, /rs\.expires_at is null or rs\.expires_at > now\(\)/);
  assert.match(migration, /'status', 'unavailable'/);
});

test('preview union supports scanned-only, inspiration-only, and mixed rooms', () => {
  const combined = migration.slice(migration.indexOf('with combined_items as'));
  assert.match(combined, /from public\.dressing_room_items dri/);
  assert.match(combined, /union all/);
  assert.match(combined, /from public\.dressing_room_inspiration_items drii/);
  assert.match(combined, /join public\.inspiration_items ii/);
  assert.match(combined, /'dressing_room_item'::text as source_type/);
  assert.match(combined, /'inspiration_item'::text as source_type/);
});

test('inspirations must be active, attached to this room, and owned consistently', () => {
  assert.match(migration, /drii\.room_id = shared_room\.room_id/);
  assert.match(migration, /drii\.user_id = shared_room\.room_owner_id/);
  assert.match(migration, /ii\.user_id = drii\.user_id/);
  assert.match(migration, /drii\.deleted_at is null/);
  assert.match(migration, /ii\.deleted_at is null/);
});

test('one combined deterministic ordering and one 24-item cap apply after deduplication', () => {
  const combinedIndex = migration.indexOf('with combined_items as');
  const dedupeIndex = migration.indexOf('deduplicated_items as');
  const rankedIndex = migration.indexOf('ranked_items as');
  const capIndex = migration.indexOf('filter (where preview_position <= preview_item_limit)');
  assert.ok(combinedIndex >= 0 && combinedIndex < dedupeIndex);
  assert.ok(dedupeIndex < rankedIndex && rankedIndex < capIndex);
  assert.match(migration, /preview_item_limit integer := 24/);
  assert.match(migration, /order by created_at desc, source_rank asc, source_id asc/);
  assert.match(migration, /'isCapped', public_item_count > preview_item_limit/);
  assert.match(migration, /'maxItemsReturned', preview_item_limit/);
  assert.doesNotMatch(migration.slice(combinedIndex, dedupeIndex), /limit preview_item_limit/);
});

test('duplicate media is suppressed once, preferring the legacy scanned record', () => {
  assert.match(migration, /partition by media_identity/);
  assert.match(migration, /order by source_rank asc, created_at desc, source_id asc/);
  assert.match(migration, /where duplicate_rank = 1/);
  assert.match(migration, /0 as source_rank/);
  assert.match(migration, /1 as source_rank/);
});

test('public item contract exposes typed source UUIDs but no private coordinates', () => {
  const itemJson = migration.slice(
    migration.indexOf("'id', source_id"),
    migration.indexOf('order by preview_position', migration.indexOf("'id', source_id")),
  );
  assert.match(itemJson, /'id', source_id/);
  assert.match(itemJson, /'sourceId', source_id/);
  assert.match(itemJson, /'sourceType', source_type/);
  assert.match(itemJson, /'imageStorageBucket', null/);
  assert.match(itemJson, /'imageStoragePath', null/);
  assert.doesNotMatch(itemJson, /room_owner_id|user_id|storage_bucket|storage_path/);
});

test('normalizer keeps source identity and strips any injected private fields', () => {
  assert.match(preview, /sourceId: rawItem\.sourceId \?\? rawItem\.id \?\? null/);
  assert.match(preview, /rawItem\.sourceType === 'inspiration_item'/);
  assert.doesNotMatch(preview, /imageStorageBucket/);
  assert.doesNotMatch(preview, /imageStoragePath/);
});

test('build 15 sends typed refs while the Edge Function retains build 14 itemIds fallback', () => {
  assert.match(resolver, /body: \{ shareToken, itemRefs \}/);
  assert.match(edge, /const isLegacyRequest = body\.itemRefs === undefined/);
  assert.match(edge, /sanitizeItemIds\(body\.itemIds\)/);
  assert.match(edge, /sourceType: 'dressing_room_item' as const/);
  assert.match(edge, /isLegacyRequest \? itemRef\.sourceId : typedKey/);
});

test('recipient image resolution is typed, refreshable, and never renders private paths', () => {
  assert.match(screen, /itemRefsNeedingResolution/);
  assert.match(screen, /getSharedRoomImageKey/);
  assert.match(screen, /imageResolutionGuard\.current = null/);
  assert.match(screen, /item\.imageUrl \?\? resolvedImageUrls\[imageKey\]/);
  assert.doesNotMatch(screen, /imageStorageBucket|imageStoragePath/);
});

test('inspiration cards render in the same one-or-many grid but never enter reaction RPCs', () => {
  assert.match(screen, /<View style=\{styles\.itemGrid\}>/);
  assert.match(screen, /style=\{\{ width: ITEM_GRID_CELL_W \}\}/);
  assert.match(screen, /item\.sourceType === 'dressing_room_item'/);
  assert.match(screen, /reactionItemId \? \(/);
});
