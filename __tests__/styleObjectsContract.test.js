const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const migration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '202605200001_persistent_style_objects.sql'),
  'utf8',
);

const storageMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '202605200002_style_library_images_storage.sql'),
  'utf8',
);

const reactionsMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '202606050001_dressing_room_item_reactions.sql'),
  'utf8',
);

const publicPreviewItemIdMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '202606050002_public_room_preview_item_ids.sql'),
  'utf8',
);

const service = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'styleObjects.ts'),
  'utf8',
);

const types = fs.readFileSync(
  path.join(__dirname, '..', 'types', 'styleObjects.ts'),
  'utf8',
);

const productShelf = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'ProductShelf.tsx'),
  'utf8',
);

const addScanModal = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'AddScanToDressingRoomModal.tsx'),
  'utf8',
);

const analysisCard = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'AnalysisCard.tsx'),
  'utf8',
);

const publicRoomScreen = fs.readFileSync(
  path.join(__dirname, '..', 'app', '(public)', 'rooms', '[token].tsx'),
  'utf8',
);

test('persistent style object migration creates required tables', () => {
  for (const table of ['dressing_rooms', 'dressing_room_items', 'looks', 'look_items']) {
    assert.match(migration, new RegExp(`create table if not exists public\\.${table}`));
    assert.match(migration, new RegExp(`alter table public\\.${table} enable row level security`));
  }
});

test('child table policies follow parent ownership', () => {
  assert.match(migration, /from public\.dressing_rooms dr/);
  assert.match(migration, /dr\.user_id = auth\.uid\(\)/);
  assert.match(migration, /from public\.looks l/);
  assert.match(migration, /l\.user_id = auth\.uid\(\)/);
  assert.match(migration, /dressing_room_id is null/);
});

test('relationship deletion behavior is encoded in foreign keys', () => {
  assert.match(migration, /references public\.dressing_rooms\(id\) on delete cascade/);
  assert.match(migration, /references public\.dressing_rooms\(id\) on delete set null/);
  assert.match(migration, /references public\.looks\(id\) on delete cascade/);
  assert.match(migration, /references public\.dressing_room_items\(id\) on delete set null/);
});

test('atomic look creation RPC copies room item snapshots', () => {
  assert.match(migration, /create or replace function public\.create_look_from_dressing_room_items/);
  assert.match(migration, /insert into public\.looks/);
  assert.match(migration, /insert into public\.look_items/);
  assert.match(migration, /dri\.snapshot_payload/);
  assert.match(migration, /with ordinality/);
});

test('remote-image-only policy is enforced by database and service', () => {
  assert.match(migration, /dressing_room_items_remote_image_only/);
  assert.match(migration, /look_items_remote_image_only/);
  assert.match(service, /isRemoteImageUrl/);
  assert.match(service, /UnsupportedStyleObjectItemError/);
});

test('snapshot version 1 is explicit', () => {
  assert.match(migration, /snapshot_version integer not null default 1/);
  assert.match(service, /SNAPSHOT_VERSION = 1/);
  assert.match(service, /canRenderSnapshotVersion/);
});

test('ProductShelf exposes a visible Add to Dressing Room action', () => {
  assert.match(productShelf, /Add to Dressing Room/);
  assert.match(productShelf, /accessibilityLabel="Add to Dressing Room"/);
  assert.match(productShelf, /testID="add-to-dressing-room-button"/);
});

test('ProductShelf gates Dressing Room saves by title and remote image eligibility', () => {
  assert.match(productShelf, /canAddProductToDressingRoom/);
  assert.match(productShelf, /getProductTitle\(product\)\.length > 0/);
  assert.match(productShelf, /isRemoteImageUrl\(product\?\.imageUrl\)/);
  assert.match(productShelf, /Can't Save Yet/);
});

test('private scan image storage bucket and user path policies are defined', () => {
  assert.match(storageMigration, /style-library-images/);
  assert.match(storageMigration, /public,\s*file_size_limit/);
  assert.match(storageMigration, /public = false/);
  assert.match(storageMigration, /storage\.foldername\(name\)\)\[1\] = auth\.uid\(\)::text/);
  assert.match(storageMigration, /storage_bucket text/);
  assert.match(storageMigration, /storage_path text/);
});

test('scan-image save flow uploads on explicit modal action', () => {
  assert.match(service, /STYLE_LIBRARY_IMAGES_BUCKET = 'style-library-images'/);
  assert.match(service, /uploadLocalScanImage/);
  assert.match(service, /addScanImageToDressingRoom/);
  assert.match(addScanModal, /Add Scan to Dressing Room/);
  assert.match(addScanModal, /CREATE \+ SAVE SCAN/);
  assert.match(analysisCard, /scanImageUri/);
});

test('item reactions migration protects raw rows and exposes counts through RPC', () => {
  assert.match(reactionsMigration, /create table if not exists public\.dressing_room_item_reactions/);
  assert.match(reactionsMigration, /references public\.dressing_room_items\(id\) on delete cascade/);
  assert.match(reactionsMigration, /references auth\.users\(id\) on delete cascade/);
  assert.match(reactionsMigration, /constraint dressing_room_item_reactions_item_user_key unique \(item_id, user_id\)/);
  assert.match(reactionsMigration, /alter table public\.dressing_room_item_reactions enable row level security/);
  assert.match(reactionsMigration, /create policy "Users can select own dressing room item reactions"/);
  assert.match(reactionsMigration, /using \(user_id = auth\.uid\(\)\)/);
  assert.match(reactionsMigration, /create or replace function public\.get_item_reaction_counts\(p_item_ids uuid\[\]\)/);
  assert.match(reactionsMigration, /security definer/);
  assert.match(reactionsMigration, /grant execute on function public\.get_item_reaction_counts\(uuid\[\]\) to anon, authenticated/);
});

test('item reaction types and helpers are defined in app code', () => {
  assert.match(types, /DRESSING_ROOM_REACTION_TYPES = \['like', 'love', 'favorite', 'looking'\] as const/);
  assert.match(types, /export type DressingRoomReactionType = typeof DRESSING_ROOM_REACTION_TYPES\[number\]/);
  assert.match(types, /export interface ItemReactionCount/);
  assert.match(service, /getItemReactionCounts/);
  assert.match(service, /getMyItemReaction/);
  assert.match(service, /setItemReaction/);
  assert.match(service, /removeItemReaction/);
  assert.match(service, /Unable to save reaction\. Please try again\./);
});

test('public room preview payload exposes dressing room item ids for read-only counts', () => {
  assert.match(publicPreviewItemIdMigration, /create or replace function public\.get_public_room_preview/);
  assert.match(publicPreviewItemIdMigration, /'id', dri\.id/);
  assert.match(publicRoomScreen, /ApiItem\.id === public\.dressing_room_items\.id/);
  assert.match(publicRoomScreen, /getItemReactionCounts/);
  assert.match(publicRoomScreen, /<ItemReactions/);
  assert.doesNotMatch(publicRoomScreen, /getMyItemReaction/);
  assert.doesNotMatch(publicRoomScreen, /setItemReaction/);
  assert.doesNotMatch(publicRoomScreen, /removeItemReaction/);
});
