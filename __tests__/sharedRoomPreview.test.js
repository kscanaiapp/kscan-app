const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeSharedRoomPreview } = require('../services/sharedRoomPreview');

test('normalizes external API shape with token, title, and public imageUrl', () => {
  const preview = normalizeSharedRoomPreview({
    status: 'available',
    preview: {
      token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      title: 'Polos',
      note: null,
      itemCount: 1,
      sharedAt: '2026-07-15T12:00:00Z',
      coverImageUrl: 'https://example.com/cover.jpg',
      allowImport: false,
      maxItemsReturned: 1,
      isCapped: false,
      nextCursor: null,
      items: [
        {
          id: '11111111-2222-3333-4444-555555555555',
          sourceId: '11111111-2222-3333-4444-555555555555',
          sourceType: 'dressing_room_item',
          imageUrl: 'https://example.com/polo.jpg',
          category: 'polo shirt',
          color: 'beige',
          silhouette: 'relaxed',
          title: 'polo shirt',
        },
      ],
    },
  });

  assert.equal(preview.token, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(preview.title, 'Polos');
  assert.equal(preview.items[0].imageUrl, 'https://example.com/polo.jpg');
  assert.equal(preview.items[0].sourceType, 'dressing_room_item');
  assert.equal(preview.items[0].sourceId, preview.items[0].id);
  // The normalized preview deliberately drops private storage coordinates;
  // public-image items carry only a public HTTPS URL.
  assert.ok(!('imageStorageBucket' in preview.items[0]));
  assert.ok(!('imageStoragePath' in preview.items[0]));
});

test('normalizes raw RPC shape with shareToken, roomTitle, and private storage paths', () => {
  const preview = normalizeSharedRoomPreview({
    status: 'available',
    shareToken: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    roomTitle: 'Polos',
    note: null,
    itemCount: 1,
    coverImageUrl: null,
    items: [
      {
        id: '11111111-2222-3333-4444-555555555555',
        imageUrl: null,
        imageStorageBucket: 'style-library-images',
        imageStoragePath: 'user-1/saved-scans/scan-1.jpg',
        category: 'polo shirt',
        color: 'beige',
        silhouette: 'relaxed',
      },
    ],
  });

  assert.equal(preview.token, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee');
  assert.equal(preview.title, 'Polos');
  // Private storage references are intentionally redacted from the public
  // preview payload; resolution happens later via the shared-room-image-url
  // Edge Function using only the public share token and item ids.
  assert.equal(preview.items[0].imageUrl, null);
  assert.ok(!('imageStorageBucket' in preview.items[0]));
  assert.ok(!('imageStoragePath' in preview.items[0]));
});

test('falls back to items.length when itemCount is missing', () => {
  const preview = normalizeSharedRoomPreview({
    preview: {
      items: [{ id: '11111111-2222-3333-4444-555555555555' }],
    },
  });

  assert.equal(preview.itemCount, 1);
  assert.equal(preview.maxItemsReturned, 1);
  assert.equal(preview.isCapped, false);
  assert.equal(preview.items[0].sourceType, 'dressing_room_item');
  assert.equal(preview.items[0].sourceId, preview.items[0].id);
});

test('preserves inspiration typed identity while dropping private storage fields', () => {
  const preview = normalizeSharedRoomPreview({
    shareToken: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    items: [{
      id: '66666666-7777-8888-9999-000000000000',
      sourceId: '66666666-7777-8888-9999-000000000000',
      sourceType: 'inspiration_item',
      imageUrl: null,
      imageStorageBucket: 'style-library-images',
      imageStoragePath: 'private/inspirations/image.jpg',
    }],
  });

  assert.equal(preview.items[0].sourceType, 'inspiration_item');
  assert.equal(preview.items[0].sourceId, '66666666-7777-8888-9999-000000000000');
  assert.ok(!('imageStorageBucket' in preview.items[0]));
  assert.ok(!('imageStoragePath' in preview.items[0]));
});

test('returns null for a malformed payload', () => {
  assert.equal(normalizeSharedRoomPreview(null), null);
  assert.equal(normalizeSharedRoomPreview({ status: 'available' }), null);
});
