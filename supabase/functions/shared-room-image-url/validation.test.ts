import assert from 'node:assert/strict';
import {
  MAX_ITEM_IDS,
  isBucketAllowed,
  isUuid,
  isValidShareToken,
  resolveStorageRefFromRow,
  sanitizeItemIds,
} from './validation.ts';

const ITEM_A = '11111111-2222-3333-4444-555555555555';
const ITEM_B = '66666666-7777-8888-9999-000000000000';

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
