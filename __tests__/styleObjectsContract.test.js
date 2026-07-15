const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const inspirationMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '20260607222310_inspiration_uploads.sql'),
  'utf8',
);

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

const auditMigrationFile = fs.readdirSync(path.join(__dirname, '..', 'supabase', 'migrations'))
  .find((file) => file.endsWith('_audit_hardening_ai_stylist_stylechat.sql'));
assert.ok(auditMigrationFile, 'audit hardening migration missing');
const auditMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', auditMigrationFile),
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

const itemReactions = fs.readFileSync(
  path.join(__dirname, '..', 'components', 'dressing-rooms', 'ItemReactions.tsx'),
  'utf8',
);

const dressingRoomItemContract = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'dressingRoomItemContract.ts'),
  'utf8',
);

const libraryScreen = fs.readFileSync(
  path.join(__dirname, '..', 'app', 'library.tsx'),
  'utf8',
);

const thumbsDownReactionMigration = fs.readFileSync(
  path.join(__dirname, '..', 'supabase', 'migrations', '202606060001_replace_fire_with_thumbs_down_reaction.sql'),
  'utf8',
);

const savedScansCloud = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'savedScansCloud.ts'),
  'utf8',
);

const sharedRoomPreviewService = fs.readFileSync(
  path.join(__dirname, '..', 'services', 'sharedRoomPreview.js'),
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
  assert.match(productShelf, /isRemoteImageUrl\(getProductImageUrl\(product\)\)/);
  assert.match(productShelf, /product\.image_url/);
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
  assert.match(types, /DRESSING_ROOM_REACTION_TYPES = \['like', 'love', 'favorite', 'looking', 'thumbs_down'\] as const/);
  assert.match(types, /ACTIVE_DRESSING_ROOM_REACTION_TYPES = \['like', 'love', 'looking', 'thumbs_down'\] as const/);
  assert.match(types, /export type DressingRoomReactionType = typeof DRESSING_ROOM_REACTION_TYPES\[number\]/);
  assert.match(types, /export type ActiveDressingRoomReactionType = typeof ACTIVE_DRESSING_ROOM_REACTION_TYPES\[number\]/);
  assert.match(types, /isActiveDressingRoomReactionType/);
  assert.match(itemReactions, /thumbs_down: \{ emoji: '👎', label: 'Not it' \}/);
  assert.doesNotMatch(itemReactions, /emoji: '🔥'/);
  assert.match(types, /export interface ItemReactionCount/);
  assert.match(service, /getItemReactionCounts/);
  assert.match(service, /getMyItemReaction/);
  assert.match(service, /setItemReaction/);
  assert.match(service, /removeItemReaction/);
  assert.match(service, /Unable to save reaction\. Please try again\./);
});

test('thumbs-down reaction migration preserves legacy favorite rows while hiding fire from active counts', () => {
  assert.match(thumbsDownReactionMigration, /drop constraint if exists dressing_room_item_reactions_reaction_type_check/);
  assert.match(thumbsDownReactionMigration, /reaction_type in \('like', 'love', 'favorite', 'looking', 'thumbs_down'\)/);
  assert.match(thumbsDownReactionMigration, /create or replace function public\.get_item_reaction_counts/);
  assert.match(thumbsDownReactionMigration, /\(values \('like'\), \('love'\), \('looking'\), \('thumbs_down'\)\)/);
  assert.doesNotMatch(thumbsDownReactionMigration, /\(values \('like'\), \('love'\), \('favorite'\), \('looking'\)\)/);
});

test('public room preview exposes item ids and gates reactions: anonymous read-only counts, writes require auth + room join', () => {
  assert.match(publicPreviewItemIdMigration, /create or replace function public\.get_public_room_preview/);
  assert.match(publicPreviewItemIdMigration, /'id', dri\.id/);
  assert.match(publicRoomScreen, /ApiItem\.id === public\.dressing_room_items\.id/);
  // Aggregate counts are always available (anonymous + authenticated).
  assert.match(publicRoomScreen, /getItemReactionCounts/);
  assert.match(publicRoomScreen, /<ItemReactions/);
  // Personal reaction read (getMyItemReaction) and writes (setItemReaction /
  // removeItemReaction) are an authenticated-participant feature, NOT exposed to
  // anonymous viewers. The privacy gate is enforced two ways in the screen:
  //   1. Loading "my" reactions is skipped unless signed in AND joined the room.
  //   2. The reaction UI is interactive only when `canReact` (auth + joinedRoomId).
  assert.match(publicRoomScreen, /if \(!isAuthenticated \|\| !joinedRoomId\)/);
  assert.match(publicRoomScreen, /const canReact = Boolean\(isAuthenticated && joinedRoomId/);
  assert.match(publicRoomScreen, /onReact=\{canReact \? handleReact : undefined\}/);
  // handleReact itself refuses to mutate when not signed-in/joined.
  assert.match(publicRoomScreen, /if \(!isAuthenticated \|\| !joinedRoomId \|\| mutatingReactionItemId === itemId\) return;/);
});

test('audit migration hardens legacy public room preview storage and response bounds', () => {
  const previewFn = auditMigration.slice(auditMigration.indexOf('create or replace function public.get_public_room_preview'));
  assert.match(previewFn, /preview_item_limit integer := 24/);
  assert.match(previewFn, /limit preview_item_limit/);
  assert.match(previewFn, /'imageStorageBucket', null/);
  assert.match(previewFn, /'imageStoragePath', null/);
  assert.match(previewFn, /'coverImageStorageBucket', null/);
  assert.match(previewFn, /'coverImageStoragePath', null/);
  assert.match(previewFn, /'isCapped', public_item_count > preview_item_limit/);
});

test('inspiration_items migration creates tables with RLS and soft-delete support', () => {
  assert.match(inspirationMigration, /create table if not exists public\.inspiration_items/);
  assert.match(inspirationMigration, /create table if not exists public\.dressing_room_inspiration_items/);
  assert.match(inspirationMigration, /alter table public\.inspiration_items enable row level security/);
  assert.match(inspirationMigration, /alter table public\.dressing_room_inspiration_items enable row level security/);
  assert.match(inspirationMigration, /deleted_at timestamptz null/);
  assert.match(inspirationMigration, /source text not null default 'upload' check \(source in \('upload'\)\)/);
  assert.match(inspirationMigration, /note text null check \(note is null or length\(trim\(note\)\) <= 200\)/);
  assert.match(inspirationMigration, /file_size_bytes integer null check \(file_size_bytes is null or file_size_bytes <= 10485760\)/);
});

test('inspiration_items RLS enforces user-scoped access and rejects anon', () => {
  assert.match(inspirationMigration, /user_id = auth\.uid\(\) and deleted_at is null/);
  assert.doesNotMatch(inspirationMigration, /to anon/);
});

test('dressing_room_inspiration_items link table enforces room ownership', () => {
  assert.match(inspirationMigration, /from public\.dressing_rooms dr/);
  assert.match(inspirationMigration, /dr\.user_id = auth\.uid\(\)/);
  assert.match(inspirationMigration, /unique\(room_id, inspiration_id\)/);
  assert.match(inspirationMigration, /references public\.dressing_rooms\(id\) on delete cascade/);
  assert.match(inspirationMigration, /references public\.inspiration_items\(id\) on delete cascade/);
});

test('styleObjects delegates URL/URI classification to the canonical contract module instead of duplicating it', () => {
  assert.match(service, /from '\.\/dressingRoomItemContract'/);
  assert.match(service, /export const isRemoteImageUrl = contractIsRemoteImageUrl/);
  // The old inline regex definitions must be gone, not just shadowed.
  assert.doesNotMatch(service, /function isLocalImageUri\(value/);
});

test('addScanImageToDressingRoom resolves the image source via the canonical contract before deciding to upload', () => {
  assert.match(service, /resolveDressingRoomImageSource\(\{/);
  assert.match(service, /imageSource\.kind === 'none'/);
  assert.match(service, /imageSource\.kind === 'storage'/);
  assert.match(service, /imageSource\.kind === 'remote'/);
  // Reusing an existing durable reference must not force a re-upload.
  assert.match(service, /Already durably stored.*no re-upload/);
});

test('addScanImageToDressingRoom throws a clear, user-facing error instead of persisting an unusable item', () => {
  assert.match(service, /add:no_usable_image_source/);
  assert.match(service, /doesn't have a usable image yet/);
  assert.match(service, /can't be added to a Dressing Room/);
});

test('Add-to-Dressing-Room pipeline logs structured, privacy-safe events in dev only', () => {
  assert.match(service, /function devLog\(/);
  assert.match(service, /typeof __DEV__ !== 'undefined' && __DEV__/);
  assert.match(service, /add:insert_failed/);
  assert.match(service, /add:insert_succeeded/);
  // Must never log sensitive values.
  assert.doesNotMatch(service, /devLog\([^)]*storagePath[^)]*storagePath/);
  assert.doesNotMatch(service, /devLog\('[^']*',\s*\{[^}]*signedUrl/i);
});

test('AnalysisCard never silently hides the Add-to-Dressing-Room action — shows a disabled reason instead', () => {
  assert.match(analysisCard, /addToDressingRoomUnavailableReason/);
  assert.match(analysisCard, /onAddToDressingRoom \? \(/);
  assert.match(analysisCard, /accessibilityState=\{\{ disabled: true \}\}/);
});

test('Library screen gates Add-to-Dressing-Room through the canonical image-source contract, not bare imageUri truthiness', () => {
  assert.match(libraryScreen, /hasUsableDressingRoomImageSource/);
  assert.match(libraryScreen, /describeMissingImageReason/);
  assert.match(libraryScreen, /addToDressingRoomUnavailableReason=\{/);
});

test('canonical contract module documents the imageUrl:null pitfall it fixes and distinguishes durable vs. temporary sources', () => {
  assert.match(dressingRoomItemContract, /does NOT mean "no image"/);
  assert.match(dressingRoomItemContract, /storageBucket.*storagePath/s);
  assert.match(dressingRoomItemContract, /never a signed URL/i);
});

test('inspiration service functions enforce soft-delete and note length', () => {
  assert.match(service, /INSPIRATION_NOTE_MAX_LENGTH = 200/);
  assert.match(service, /normalizeInspirationNote/);
  assert.match(service, /Note must be.*characters or fewer/);
  assert.match(service, /uploadAndSaveInspiration/);
  assert.match(service, /uploadAndSaveInspirationToDressingRoom/);
  assert.match(service, /listInspirationItems/);
  assert.match(service, /listDressingRoomInspirationItems/);
  assert.match(service, /deleteInspirationItem/);
  assert.match(service, /removeInspirationFromDressingRoom/);
  assert.match(service, /deleted_at.*new Date\(\)\.toISOString\(\)/);
});

test('inspiration upload service validates auth and uses private storage bucket', () => {
  assert.match(service, /requireAuthUserId/);
  assert.match(service, /STYLE_LIBRARY_IMAGES_BUCKET/);
  assert.match(service, /\/inspirations\//);
  assert.match(service, /image\/jpeg/);
});

test('inspiration upload service performs cleanup on DB failure', () => {
  assert.match(service, /supabase\.storage\.from\(STYLE_LIBRARY_IMAGES_BUCKET\)\.remove\(\[storagePath\]\)/);
});

test('inspiration upload does not store signed URLs in the database', () => {
  assert.match(service, /imageUrl: null/);
  assert.match(service, /resolveSignedUrlsForInspirationItems/);
});

test('public room preview screen does not expose inspiration uploads', () => {
  assert.doesNotMatch(publicRoomScreen, /inspiration_items/);
  assert.doesNotMatch(publicRoomScreen, /listDressingRoomInspirationItems/);
  assert.doesNotMatch(publicRoomScreen, /InspirationUploadModal/);
});

test('app.json declares photo library permission for expo-image-picker', () => {
  const appJson = fs.readFileSync(path.join(__dirname, '..', 'app.json'), 'utf8');
  assert.match(appJson, /expo-image-picker/);
  assert.match(appJson, /NSPhotoLibraryUsageDescription/);
  assert.match(appJson, /style inspiration images/);
});

test('dressing room title is validated with 60-character max and newline normalization', () => {
  assert.match(service, /ROOM_TITLE_MAX_LENGTH = 60/);
  assert.match(service, /Dressing Room title must be/);
  assert.match(service, /normalizeRoomTitleValue/);
  assert.match(service, /replace\(\/\[\\r\\n\]/);
});

test('public shared room screen displays room title with fallback', () => {
  assert.match(publicRoomScreen, /preview\.title/);
  assert.match(publicRoomScreen, /Shared Dressing Room/);
});

test('dev-only logs never carry raw dressing room ids or item ids', () => {
  // Every devLog(...) call site in the service, verbatim.
  const devLogCalls = service.match(/devLog\('[^']*',\s*\{[^}]*\}\)/g) ?? [];
  assert.ok(devLogCalls.length >= 8, 'expected multiple devLog call sites');
  for (const call of devLogCalls) {
    assert.doesNotMatch(call, /dressingRoomId/);
    assert.doesNotMatch(call, /itemId/);
  }
});

test('AddScanToDressingRoomModal gates on the canonical image-source contract, not bare localImageUri', () => {
  assert.match(addScanModal, /from '\.\.\/services\/dressingRoomItemContract'/);
  assert.match(addScanModal, /hasUsableDressingRoomImageSource\(\{ localUri: localImageUri, storageBucket, storagePath, imageUrl \}\)/);
  assert.doesNotMatch(addScanModal, /const missingImage = !localImageUri/);
  // storageBucket/storagePath/imageUrl are accepted as props and forwarded
  // into the scan snapshot passed to addScanImageToDressingRoom.
  assert.match(addScanModal, /storageBucket\?: string \| null;/);
  assert.match(addScanModal, /storagePath\?: string \| null;/);
  assert.match(addScanModal, /storageBucket,\s+storagePath,\s+imageUrl,/);
});

test('Library screen carries a Library item\'s durable storage reference through to the Add modal, not just its local URI', () => {
  assert.match(libraryScreen, /storageBucket\?: string \| null;/);
  assert.match(libraryScreen, /storagePath\?: string \| null;/);
  // The Add CTA and the modal-visibility gate both check the full candidate.
  assert.match(libraryScreen, /storageBucket: selectedScan\.storageBucket,\s+storagePath: selectedScan\.storagePath,/);
  assert.match(libraryScreen, /<AddScanToDressingRoomModal/);
  assert.match(libraryScreen, /storageBucket=\{selectedScan\.storageBucket\}/);
  assert.match(libraryScreen, /storagePath=\{selectedScan\.storagePath\}/);
});

test('cloud saved-scan mapping preserves the durable storage reference instead of dropping it', () => {
  assert.match(savedScansCloud, /storage_bucket\?: string \| null;/);
  assert.match(savedScansCloud, /storage_path\?: string \| null;/);
  assert.match(savedScansCloud, /storageBucket: row\.storage_bucket \?\? null,/);
  assert.match(savedScansCloud, /storagePath: row\.storage_path \?\? null,/);
});

test('shared-room preview client never carries private storage fields, even a null one', () => {
  assert.doesNotMatch(sharedRoomPreviewService, /imageStorageBucket/);
  assert.doesNotMatch(sharedRoomPreviewService, /imageStoragePath/);
  assert.doesNotMatch(publicRoomScreen, /imageStorageBucket/);
  assert.doesNotMatch(publicRoomScreen, /imageStoragePath/);
});

test('addScanImageToDressingRoom writes image_url XOR storage_bucket+storage_path, never both, so the shared-room read-side priority cannot conflict', () => {
  // This is the assumption the Edge Function's validation.ts explicitly
  // documents relying on (see its resolveStorageRefFromRow doc comment) and
  // the shared-room screen's `!item.imageUrl` filter relies on implicitly.
  assert.match(service, /image_url: resolvedImageUrl,\s+storage_bucket: storageBucket,\s+storage_path: storagePath,/);
  // resolvedImageUrl is only ever assigned in the 'remote' branch; storageBucket
  // /storagePath are only ever assigned in the 'storage' or 'local' (post-upload)
  // branches - never in the same branch.
  assert.match(service, /else if \(imageSource\.kind === 'remote'\) \{\s+resolvedImageUrl = imageSource\.imageUrl;/);
});

test('the read-side (Edge Function + shared-room screen) documents its dependency on the write-side (dressingRoomItemContract) priority', () => {
  const edgeFnValidation = fs.readFileSync(
    path.join(__dirname, '..', 'supabase', 'functions', 'shared-room-image-url', 'validation.ts'),
    'utf8',
  );
  assert.match(edgeFnValidation, /read-side counterpart of the write-side priority/);
  assert.match(edgeFnValidation, /dressingRoomItemContract\.ts#resolveDressingRoomImageSource/);
  assert.match(publicRoomScreen, /Read-side mirror of services\/dressingRoomItemContract\.ts/);
});
