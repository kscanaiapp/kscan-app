import assert from 'node:assert/strict';
import {
  MAX_ITEM_IDS,
  encodeStorageObjectPath,
  isApprovedPrivateStorageRef,
  isBucketAllowed,
  isSharedRoomItemSourceType,
  isUuid,
  isValidShareToken,
  resolveAuthorizedInspirationStorageRefs,
  resolveStorageRefFromRow,
  sanitizeItemIds,
  sanitizeItemRefs,
  sharedRoomItemRefKey,
} from './validation.ts';

const ITEM_A = '11111111-2222-3333-4444-555555555555';
const ITEM_B = '66666666-7777-8888-9999-000000000000';
const OWNER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

Deno.test('isValidShareToken accepts the real token contract, not just UUIDs', () => {
  assert.equal(isValidShareToken('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'), true);
  assert.equal(isValidShareToken('short-nanoid_style-Token123'), true);
  assert.equal(isValidShareToken(''), false);
  assert.equal(isValidShareToken('has a space'), false);
  assert.equal(isValidShareToken('has/slash'), false);
  assert.equal(isValidShareToken('a'.repeat(161)), false);
  assert.equal(isValidShareToken(null), false);
  assert.equal(isValidShareToken(42), false);
});

Deno.test('isUuid only accepts real UUIDs', () => {
  assert.equal(isUuid(ITEM_A), true);
  assert.equal(isUuid('not-a-uuid'), false);
  assert.equal(isUuid(''), false);
  assert.equal(isUuid(null), false);
});

Deno.test('sanitizeItemIds drops non-UUID entries instead of failing the whole batch', () => {
  const result = sanitizeItemIds([ITEM_A, 'garbage', ITEM_B, 123, null]);
  assert.deepEqual(result, [ITEM_A, ITEM_B]);
});

Deno.test('sanitizeItemIds deduplicates repeated ids', () => {
  const result = sanitizeItemIds([ITEM_A, ITEM_A, ITEM_B, ITEM_A]);
  assert.deepEqual(result, [ITEM_A, ITEM_B]);
});

Deno.test('sanitizeItemIds caps the batch at MAX_ITEM_IDS', () => {
  const many = Array.from({ length: MAX_ITEM_IDS + 10 }, (_, i) =>
    `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  );
  const result = sanitizeItemIds(many);
  assert.equal(result.length, MAX_ITEM_IDS);
});

Deno.test('sanitizeItemIds returns empty for non-array input', () => {
  assert.deepEqual(sanitizeItemIds(null), []);
  assert.deepEqual(sanitizeItemIds('not-an-array'), []);
  assert.deepEqual(sanitizeItemIds(undefined), []);
});

Deno.test('sanitizeItemRefs accepts both normalized domains and keys them without collision', () => {
  assert.equal(isSharedRoomItemSourceType('dressing_room_item'), true);
  assert.equal(isSharedRoomItemSourceType('inspiration_item'), true);
  assert.equal(isSharedRoomItemSourceType('saved_scan'), false);
  const refs = sanitizeItemRefs([
    { sourceType: 'dressing_room_item', sourceId: ITEM_A },
    { sourceType: 'inspiration_item', sourceId: ITEM_A },
  ]);
  assert.equal(refs.length, 2);
  assert.equal(sharedRoomItemRefKey(refs[0]), `dressing_room_item:${ITEM_A}`);
  assert.equal(sharedRoomItemRefKey(refs[1]), `inspiration_item:${ITEM_A}`);
});

Deno.test('sanitizeItemRefs drops malformed refs, deduplicates, and caps the combined batch at 24', () => {
  const many = Array.from({ length: MAX_ITEM_IDS + 8 }, (_, i) => ({
    sourceType: i % 2 ? 'inspiration_item' : 'dressing_room_item',
    sourceId: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
  }));
  const refs = sanitizeItemRefs([
    { sourceType: 'bad', sourceId: ITEM_A },
    { sourceType: 'inspiration_item', sourceId: 'bad' },
    ...many,
    many[0],
  ]);
  assert.equal(refs.length, MAX_ITEM_IDS);
  assert.equal(new Set(refs.map(sharedRoomItemRefKey)).size, MAX_ITEM_IDS);
});

Deno.test('resolveStorageRefFromRow prefers the dedicated columns', () => {
  const ref = resolveStorageRefFromRow({
    id: ITEM_A,
    storage_bucket: 'style-library-images',
    storage_path: 'user-1/scans/a.jpg',
    snapshot_payload: { image: { storageBucket: 'ignored-bucket', storagePath: 'ignored/path.jpg' } },
  });
  assert.deepEqual(ref, { bucket: 'style-library-images', path: 'user-1/scans/a.jpg' });
});

Deno.test('resolveStorageRefFromRow falls back to snapshot_payload.image when columns are null', () => {
  const ref = resolveStorageRefFromRow({
    id: ITEM_A,
    storage_bucket: null,
    storage_path: null,
    snapshot_payload: { image: { storageBucket: 'style-library-images', storagePath: 'user-1/scans/b.jpg' } },
  });
  assert.deepEqual(ref, { bucket: 'style-library-images', path: 'user-1/scans/b.jpg' });
});

Deno.test('resolveStorageRefFromRow returns null when neither source has a usable bucket+path', () => {
  assert.equal(
    resolveStorageRefFromRow({ id: ITEM_A, storage_bucket: null, storage_path: null, snapshot_payload: null }),
    null,
  );
  assert.equal(
    resolveStorageRefFromRow({
      id: ITEM_A,
      storage_bucket: 'style-library-images',
      storage_path: null,
      snapshot_payload: null,
    }),
    null,
  );
  assert.equal(
    resolveStorageRefFromRow({
      id: ITEM_A,
      storage_bucket: '',
      storage_path: '',
      snapshot_payload: { image: { storageBucket: '', storagePath: '' } },
    }),
    null,
  );
});

Deno.test('isBucketAllowed only allows the known style-library-images bucket', () => {
  assert.equal(isBucketAllowed('style-library-images'), true);
  assert.equal(isBucketAllowed('some-other-bucket'), false);
  assert.equal(isBucketAllowed(''), false);
});

Deno.test('private storage contract accepts only owner-scoped approved source paths', () => {
  assert.equal(isApprovedPrivateStorageRef('inspiration_item', OWNER, {
    bucket: 'style-library-images', path: `${OWNER}/inspirations/photo.jpg`,
  }), true);
  assert.equal(isApprovedPrivateStorageRef('dressing_room_item', OWNER, {
    bucket: 'style-library-images', path: `${OWNER}/scans/photo.jpg`,
  }), true);
  assert.equal(isApprovedPrivateStorageRef('dressing_room_item', OWNER, {
    bucket: 'style-library-images', path: `${OWNER}/saved-scans/${ITEM_A}.jpg`,
  }), true);
  assert.equal(isApprovedPrivateStorageRef('inspiration_item', OWNER, {
    bucket: 'style-library-images', path: `${OWNER}/scans/photo.jpg`,
  }), false);
  assert.equal(isApprovedPrivateStorageRef('inspiration_item', OWNER, {
    bucket: 'other', path: `${OWNER}/inspirations/photo.jpg`,
  }), false);
  assert.equal(isApprovedPrivateStorageRef('inspiration_item', OWNER, {
    bucket: 'style-library-images', path: `${ITEM_B}/inspirations/photo.jpg`,
  }), false);
});

Deno.test('inspiration authorization excludes detached, deleted, and foreign-owner rows', () => {
  const validPath = `${OWNER}/inspirations/photo.jpg`;
  const validItem = {
    id: ITEM_A, user_id: OWNER, storage_bucket: 'style-library-images', storage_path: validPath, deleted_at: null,
  };
  const activeLink = { inspiration_id: ITEM_A, user_id: OWNER, deleted_at: null };
  assert.deepEqual(
    resolveAuthorizedInspirationStorageRefs(OWNER, [activeLink], [validItem]).get(ITEM_A),
    { bucket: 'style-library-images', path: validPath },
  );
  assert.equal(resolveAuthorizedInspirationStorageRefs(OWNER, [], [validItem]).size, 0);
  assert.equal(resolveAuthorizedInspirationStorageRefs(
    OWNER, [{ ...activeLink, deleted_at: '2026-07-18T00:00:00Z' }], [validItem],
  ).size, 0);
  assert.equal(resolveAuthorizedInspirationStorageRefs(
    OWNER, [activeLink], [{ ...validItem, deleted_at: '2026-07-18T00:00:00Z' }],
  ).size, 0);
  assert.equal(resolveAuthorizedInspirationStorageRefs(
    OWNER, [{ ...activeLink, user_id: ITEM_B }], [validItem],
  ).size, 0);
  assert.equal(resolveAuthorizedInspirationStorageRefs(
    OWNER, [activeLink], [{ ...validItem, user_id: ITEM_B }],
  ).size, 0);
});

Deno.test('encodeStorageObjectPath preserves object path separators', () => {
  assert.equal(
    encodeStorageObjectPath(
      'style-library-images',
      'user-1/saved scans/item #1.png',
    ),
    'style-library-images/user-1/saved%20scans/item%20%231.png',
  );
  assert.equal(
    encodeStorageObjectPath('style-library-images', 'user-1/scans/a.jpg').includes('%2F'),
    false,
  );
});
