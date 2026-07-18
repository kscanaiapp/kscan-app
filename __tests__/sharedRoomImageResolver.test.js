const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const edgeFn = fs.readFileSync(
  path.join(ROOT, 'supabase/functions/shared-room-image-url/index.ts'),
  'utf8',
);
const clientService = fs.readFileSync(
  path.join(ROOT, 'services/sharedRoomImageResolver.ts'),
  'utf8',
);
const publicRoomScreen = fs.readFileSync(
  path.join(ROOT, 'app/(public)/rooms/[token].tsx'),
  'utf8',
);

// The pure validation/authorization logic (token/id validation, dedup, cap,
// storage-ref resolution, bucket allowlisting) is imported directly and
// exercised with real behavioral tests in
// supabase/functions/shared-room-image-url/validation.test.ts (via `deno
// test`), since it has no Deno-specific globals. index.ts itself calls
// `Deno.serve(...)` at module load time, so it cannot be `require`d under
// plain Node — these remaining checks are necessarily source-level, and are
// scoped to the properties that can't be expressed as pure-function tests:
// wiring, which RPC/table is queried, and response shape.

test('Edge Function does NOT call the anon-safe get_public_room_preview RPC', () => {
  // Regression guard: this RPC was hardened (20260712010000) to always return
  // null imageStorageBucket/imageStoragePath for anon callers. Depending on it
  // here would silently make every signed URL resolve to null forever.
  // The implementation documents the deliberate avoidance in comments, so only
  // an actual call pattern (with parens) is forbidden.
  assert.doesNotMatch(edgeFn, /get_public_room_preview\s*\(/);
});

test('Edge Function resolves the room directly from room_shares with the same activity rules', () => {
  assert.match(edgeFn, /rest\/v1\/room_shares/);
  assert.match(edgeFn, /access_level.*eq\.view/);
  assert.match(edgeFn, /is_active.*eq\.true/);
  assert.match(edgeFn, /revoked_at.*is\.null/);
  assert.match(edgeFn, /expires_at/);
});

test('Edge Function reads storage refs from dressing_room_items scoped to the resolved room', () => {
  assert.match(edgeFn, /rest\/v1\/dressing_room_items/);
  assert.match(edgeFn, /dressing_room_id.*eq\.\$\{room\.roomId\}/);
});

test('Edge Function resolves inspirations only through active room-scoped links', () => {
  assert.match(edgeFn, /rest\/v1\/dressing_room_inspiration_items/);
  assert.match(edgeFn, /room_id.*eq\.\$\{room\.roomId\}/);
  assert.match(edgeFn, /inspiration_id.*in\.\(\$\{inspirationIds\.join\(','\)\}\)/);
  assert.match(edgeFn, /deleted_at: 'is\.null'/);
  assert.match(edgeFn, /rest\/v1\/inspiration_items/);
  assert.match(edgeFn, /resolveAuthorizedInspirationStorageRefs/);
});

test('Edge Function imports validation/authorization helpers instead of duplicating them', () => {
  assert.match(edgeFn, /from ['"]\.\/validation\.ts['"]/);
  assert.match(edgeFn, /isValidShareToken/);
  assert.match(edgeFn, /sanitizeItemIds/);
  assert.match(edgeFn, /sanitizeItemRefs/);
  assert.match(edgeFn, /sharedRoomItemRefKey/);
  assert.match(edgeFn, /resolveStorageRefFromRow/);
  assert.match(edgeFn, /isBucketAllowed/);
});

test('Edge Function signs only the validated private storage object', () => {
  assert.match(edgeFn, /storage\/v1\/object\/sign/);
  assert.match(edgeFn, /encodeStorageObjectPath\(bucket, path\)/);
  assert.doesNotMatch(edgeFn, /encodeURIComponent\(path\)/);
  assert.match(edgeFn, /expiresIn/);
});

test('Edge Function uses service role, not anon key, for every REST call', () => {
  assert.match(edgeFn, /SUPABASE_SERVICE_ROLE_KEY/);
  assert.match(edgeFn, /Authorization: `Bearer \$\{serviceRoleKey\}`/);
});

test('Edge Function restricts CORS to the supported web origin, not a wildcard', () => {
  // The literal origin is assigned to ALLOWED_ORIGIN and referenced by name
  // in the CORS headers, so accept either form.
  assert.match(edgeFn, /Access-Control-Allow-Origin.*(?:kscan\.app|ALLOWED_ORIGIN)/);
  assert.doesNotMatch(edgeFn, /Access-Control-Allow-Origin['"]?\s*:\s*['"]\*['"]/);
});

test('Edge Function never echoes bucket, path, or owner metadata back to the client', () => {
  const responseBlock = edgeFn.slice(edgeFn.indexOf('const imageUrls:'), edgeFn.indexOf('return json({ imageUrls });'));
  assert.match(responseBlock, /imageUrls\[responseKey\]/);
  assert.doesNotMatch(responseBlock, /ownerId|user_id|storageBucket|storagePath/);
  assert.doesNotMatch(responseBlock, /imageUrls\[[^\]]+\]\s*=\s*\{[^}]*\b(bucket|path)\b/);
});

test('Client resolver sends only share token and typed item refs to the Edge Function', () => {
  assert.match(clientService, /FUNCTION_NAME = 'shared-room-image-url'/);
  assert.match(clientService, /supabase\.functions\.invoke/);
  assert.match(clientService, /body: \{ shareToken, itemRefs \}/);
  assert.doesNotMatch(clientService, /imageStorageBucket/);
  assert.doesNotMatch(clientService, /imageStoragePath/);
});

test('Shared room screen resolves private images and falls back to the signed URL', () => {
  assert.match(publicRoomScreen, /resolveSharedRoomImageUrls/);
  assert.match(publicRoomScreen, /resolvedImageUrls/);
  assert.match(publicRoomScreen, /item\.imageUrl \?\? resolvedImageUrls\[imageKey\]/);
});

// The following tests prove the specific security properties required of
// this function: token->room resolution rules, room-scoped item
// intersection, no client-supplied storage coordinates, allowlist-gated
// signing, and generic (non-distinguishing) denial responses.

test('Edge Function never reads a bucket or path from the client request body', () => {
  assert.match(edgeFn, /shareToken\?: unknown;/);
  assert.match(edgeFn, /itemRefs\?: unknown;/);
  assert.match(edgeFn, /itemIds\?: unknown;/);
  // No code path reads body.bucket / body.path / body.storageBucket anywhere.
  assert.doesNotMatch(edgeFn, /body\.(bucket|path|storageBucket|storagePath)/);
  // The only two places a bucket/path pair are constructed are the room-items
  // lookup (server-resolved) and the sign call built from that same lookup.
  assert.match(edgeFn, /resolveStorageRefFromRow\(row\)/);
});

test('Edge Function only ever signs a bucket on the allowlist', () => {
  assert.match(edgeFn, /if \(!isBucketAllowed\(bucket\)\) return null;/);
  // isBucketAllowed is checked before any signing fetch is issued.
  const signFnBody = edgeFn.slice(
    edgeFn.indexOf('async function createSignedImageUrl'),
    edgeFn.indexOf('Deno.serve'),
  );
  assert.match(signFnBody, /isBucketAllowed\(bucket\)/);
  assert.match(signFnBody, /storage\/v1\/object\/sign/);
  assert.ok(
    signFnBody.indexOf('isBucketAllowed(bucket)') < signFnBody.indexOf('storage/v1/object/sign'),
    'bucket allowlist check must happen before the signing request is made',
  );
});

test('Edge Function resolves an unrelated or unauthorized item to null, never an error or distinguishing signal', () => {
  // Items not found in the room-scoped refs map resolve to null via the
  // ternary, with no separate error path or status code per-item.
  assert.match(edgeFn, /imageUrls\[responseKey\] = ref \? await createSignedImageUrl\(ref\.bucket, ref\.path\) : null;/);
});

test('legacy build-14 itemIds remain dressing_room_item requests with unchanged response keys', () => {
  assert.match(edgeFn, /const isLegacyRequest = body\.itemRefs === undefined/);
  assert.match(edgeFn, /sanitizeItemIds\(body\.itemIds\)/);
  assert.match(edgeFn, /sourceType: 'dressing_room_item' as const/);
  assert.match(edgeFn, /const responseKey = isLegacyRequest \? itemRef\.sourceId : typedKey/);
});

test('inspiration reactions stay disabled because their ids are not dressing_room_items', () => {
  assert.match(publicRoomScreen, /item\.sourceType === 'dressing_room_item'/);
  assert.match(publicRoomScreen, /const reactionItemId/);
});

test('Edge Function returns a generic response when the room cannot be resolved, without distinguishing why', () => {
  // Unknown, revoked, and expired tokens all fall through the same
  // `if (!roomId)` branch to the same generic body/status.
  assert.match(edgeFn, /if \(!room\) \{/);
  assert.match(edgeFn, /return json\(\{ imageUrls: \{\} \}, 404\);/);
  assert.match(edgeFn, /does not distinguish unknown vs\. revoked vs\. expired/);
});
