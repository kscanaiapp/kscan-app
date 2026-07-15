const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveDressingRoomImageSource,
  hasUsableDressingRoomImageSource,
  isRemoteImageUrl,
  isLocalImageUri,
  describeMissingImageReason,
} = require('../services/dressingRoomItemContract.ts');

test('resolves a durable storage reference when bucket + path are present', () => {
  const source = resolveDressingRoomImageSource({
    storageBucket: 'style-library-images',
    storagePath: 'user-1/scans/a.jpg',
    imageUrl: null,
    localUri: null,
  });
  assert.deepEqual(source, {
    kind: 'storage',
    storageBucket: 'style-library-images',
    storagePath: 'user-1/scans/a.jpg',
  });
});

test('storage reference is preferred over a local URI when both are present', () => {
  const source = resolveDressingRoomImageSource({
    storageBucket: 'style-library-images',
    storagePath: 'user-1/scans/a.jpg',
    localUri: 'file:///tmp/a.jpg',
  });
  assert.equal(source.kind, 'storage');
});

test('falls back to a remote https URL when no storage reference exists', () => {
  const source = resolveDressingRoomImageSource({ imageUrl: 'https://cdn.example.com/a.jpg' });
  assert.deepEqual(source, { kind: 'remote', imageUrl: 'https://cdn.example.com/a.jpg' });
});

test('falls back to a local URI only when nothing durable/remote is available', () => {
  const source = resolveDressingRoomImageSource({ localUri: 'file:///tmp/a.jpg' });
  assert.deepEqual(source, { kind: 'local', localUri: 'file:///tmp/a.jpg' });
});

test('imageUrl: null does NOT mean "no image" when a storage reference exists', () => {
  // This is the exact defect this module fixes: a bare imageUrl/localUri
  // truthiness check would have reported "no image" here.
  const candidate = { imageUrl: null, localUri: null, storageBucket: 'style-library-images', storagePath: 'x/y.jpg' };
  assert.equal(hasUsableDressingRoomImageSource(candidate), true);
});

test('resolves to none when no source is usable', () => {
  assert.deepEqual(resolveDressingRoomImageSource({}), { kind: 'none' });
  assert.deepEqual(
    resolveDressingRoomImageSource({ imageUrl: null, localUri: null, storageBucket: null, storagePath: null }),
    { kind: 'none' },
  );
});

test('a bucket without a path (or vice versa) is not a usable storage source', () => {
  assert.equal(hasUsableDressingRoomImageSource({ storageBucket: 'style-library-images', storagePath: null }), false);
  assert.equal(hasUsableDressingRoomImageSource({ storageBucket: null, storagePath: 'x/y.jpg' }), false);
});

test('a non-remote imageUrl (e.g. missing protocol) is rejected', () => {
  assert.equal(isRemoteImageUrl('cdn.example.com/a.jpg'), false);
  assert.equal(isRemoteImageUrl('ftp://example.com/a.jpg'), false);
  assert.equal(hasUsableDressingRoomImageSource({ imageUrl: 'cdn.example.com/a.jpg' }), false);
});

test('recognizes device-local URI schemes', () => {
  for (const scheme of ['file', 'content', 'asset', 'ph']) {
    assert.equal(isLocalImageUri(`${scheme}://some/path`), true);
  }
  assert.equal(isLocalImageUri('https://example.com/a.jpg'), false);
  assert.equal(isLocalImageUri(null), false);
});

test('describeMissingImageReason returns a non-empty, user-facing explanation', () => {
  const reason = describeMissingImageReason();
  assert.equal(typeof reason, 'string');
  assert.ok(reason.length > 0);
});
