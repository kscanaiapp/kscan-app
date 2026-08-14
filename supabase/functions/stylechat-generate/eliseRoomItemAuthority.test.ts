/**
 * Server authority over Dressing Room item attributes (Build 29).
 *
 * WHY THIS EXISTS: applyResolution stamped a room item `trust:
 * 'server_verified'` and overrode its identity, authorization and storage
 * reference from the resolved row — but then took the CLIENT's descriptive
 * metadata in preference to the server's, consulting the row only as a
 * fallback:
 *
 *     item.title = item.title ?? resolution.metadata.title ?? null;
 *
 * So a caller could attach a room item it genuinely has access to and describe
 * it as a different brand, category, colour or garment entirely, and that
 * description reached the model labelled as verified room truth. Identity was
 * server-derived; attributes were not. The grounding invariant — Elise may only
 * state an item exists, and what it is, when the server manifest proves it —
 * cannot hold on top of that.
 *
 * The room-item resolvers also returned `colors: []`, `materials: []`,
 * `silhouette: null`, so for those fields the server had no opinion to assert
 * even in principle. They now read the row's `snapshot_payload`.
 */

import assert from 'node:assert/strict';

import { buildEliseVisualContextEnvelope } from './eliseVisualContextPipeline.ts';
import type { EliseResourceDataSource } from './eliseResourceResolvers.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const ROOM_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const ITEM_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const SHARED_ROOM = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SHARED_ITEM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

/** A room whose rows carry real, server-side descriptive metadata. */
function mockData(overrides: Partial<EliseResourceDataSource> = {}): EliseResourceDataSource {
  return {
    fetchSavedScan: async () => null,
    fetchInspirationItem: async () => null,
    fetchDressingRoom: async (roomId) =>
      roomId === ROOM_ID ? { id: ROOM_ID, user_id: ACTOR } : null,
    fetchDressingRoomItem: async (roomId, itemId) => {
      if (roomId === ROOM_ID && itemId === ITEM_ID) {
        return {
          id: ITEM_ID,
          dressing_room_id: ROOM_ID,
          title: 'Charcoal wool overcoat',
          category: 'outerwear',
          brand: 'Aquascutum',
          storage_bucket: 'rooms',
          storage_path: `${ACTOR}/${ITEM_ID}.jpg`,
          snapshot_payload: {
            colors: ['charcoal'],
            materials: ['wool'],
            silhouette: 'longline',
          },
        };
      }
      if (roomId === SHARED_ROOM && itemId === SHARED_ITEM) {
        return {
          id: SHARED_ITEM,
          dressing_room_id: SHARED_ROOM,
          title: 'Shared jacket',
          category: 'outerwear',
          brand: 'ShareCo',
          storage_bucket: 'rooms',
          storage_path: `owner/${SHARED_ITEM}.jpg`,
          snapshot_payload: { metadata: { color: 'olive', materialEstimate: 'cotton' } },
        };
      }
      return null;
    },
    fetchSharedRoomAccess: async (roomId) =>
      roomId === SHARED_ROOM ? { active: true, expired: false } : null,
    ...overrides,
  };
}

async function resolveOwnedItem(clientClaim: Record<string, unknown>) {
  const result = await buildEliseVisualContextEnvelope({
    rawActiveContext: {
      source: 'dressing_room',
      visualContext: { source: 'dressing_room', roomId: ROOM_ID, itemId: ITEM_ID, ...clientClaim },
    },
    actorId: ACTOR,
    sessionId: 'session-authority',
    dataSource: mockData(),
  });
  assert.equal(result.envelope.evidence.length, 1, 'expected the room item to resolve');
  return result;
}

Deno.test('a false client title/category/brand cannot override the resolved row', async () => {
  const result = await resolveOwnedItem({
    title: 'Red leather mini skirt',
    category: 'skirts',
    brand: 'CounterfeitCo',
  });
  const item = result.envelope.evidence[0];

  assert.equal(item.trust, 'server_verified');
  assert.equal(item.title, 'Charcoal wool overcoat');
  assert.equal(item.category, 'outerwear');
  assert.equal(item.brand, 'Aquascutum');
});

Deno.test('a false client colour/material/silhouette cannot override the snapshot', async () => {
  const result = await resolveOwnedItem({
    colors: ['neon pink'],
    materials: ['latex'],
    silhouette: 'cropped',
  });
  const item = result.envelope.evidence[0];

  assert.deepEqual(item.colors, ['charcoal']);
  assert.deepEqual(item.materials, ['wool']);
  assert.equal(item.silhouette, 'longline');
});

Deno.test('the fabricated attributes never reach the prompt block', async () => {
  // The end-to-end property that matters: whatever the pipeline does
  // internally, the attacker's text must not be serialized into the model's
  // context as verified room data.
  const result = await resolveOwnedItem({
    title: 'Red leather mini skirt',
    brand: 'CounterfeitCo',
    colors: ['neon pink'],
  });
  const prompt = result.promptBlock ?? '';

  assert.ok(prompt.length > 0, 'expected a prompt block');
  for (const fabricated of ['Red leather mini skirt', 'CounterfeitCo', 'neon pink']) {
    assert.ok(!prompt.includes(fabricated), `fabricated value reached the prompt: ${fabricated}`);
  }
  assert.ok(prompt.includes('Charcoal wool overcoat'), prompt);
  assert.ok(prompt.includes('charcoal'), prompt);
});

Deno.test('shared-room items are equally server-authoritative and never upgrade to owned', async () => {
  const result = await buildEliseVisualContextEnvelope({
    rawActiveContext: {
      source: 'shared_room',
      visualContext: {
        source: 'shared_room',
        roomId: SHARED_ROOM,
        itemId: SHARED_ITEM,
        title: 'My own jacket',
        brand: 'MineNow',
        colors: ['gold'],
      },
    },
    actorId: ACTOR,
    sessionId: 'session-shared',
    dataSource: mockData(),
  });
  const item = result.envelope.evidence[0];

  assert.equal(item.title, 'Shared jacket');
  assert.equal(item.brand, 'ShareCo');
  // Read out of snapshot_payload.metadata rather than a top-level colors array,
  // because the payload shape differs by the source that wrote the item.
  assert.deepEqual(item.colors, ['olive']);
  assert.deepEqual(item.materials, ['cotton']);
  // Ownership language depends on this staying 'shared'.
  assert.equal(item.actorRelationship, 'shared');
  assert.equal(item.trust, 'server_verified');
});

Deno.test('the client value is kept only where the server has no opinion', async () => {
  // Not every source has a row to speak for it, and over-correcting into
  // "discard all client metadata" would silently strip usable context from a
  // live scan. Absence of a server value is the only case the claim survives.
  const result = await buildEliseVisualContextEnvelope({
    rawActiveContext: {
      source: 'dressing_room',
      visualContext: {
        source: 'dressing_room',
        roomId: ROOM_ID,
        itemId: ITEM_ID,
        summary: 'Client-side note about styling',
      },
    },
    actorId: ACTOR,
    sessionId: 'session-gap',
    dataSource: mockData({
      fetchDressingRoomItem: async () => ({
        id: ITEM_ID,
        dressing_room_id: ROOM_ID,
        title: 'Charcoal wool overcoat',
        category: null,
        brand: null,
        snapshot_payload: {},
      }),
    }),
  });
  const item = result.envelope.evidence[0];

  assert.equal(item.title, 'Charcoal wool overcoat');
  // The row asserted nothing here, so the client's own note is retained.
  assert.equal(item.summary, 'Client-side note about styling');
  assert.deepEqual(item.colors, []);
});

Deno.test('a malformed snapshot_payload yields no opinion rather than throwing', async () => {
  for (const payload of [null, 'not-an-object', 42, ['array'], { colors: 'not-a-list' }]) {
    const result = await buildEliseVisualContextEnvelope({
      rawActiveContext: {
        source: 'dressing_room',
        visualContext: { source: 'dressing_room', roomId: ROOM_ID, itemId: ITEM_ID },
      },
      actorId: ACTOR,
      sessionId: 'session-malformed',
      dataSource: mockData({
        fetchDressingRoomItem: async () => ({
          id: ITEM_ID,
          dressing_room_id: ROOM_ID,
          title: 'Charcoal wool overcoat',
          snapshot_payload: payload,
        }),
      }),
    });
    assert.equal(result.envelope.evidence.length, 1, `payload ${JSON.stringify(payload)}`);
    assert.equal(result.envelope.evidence[0].title, 'Charcoal wool overcoat');
  }
});

Deno.test('a string colour in the snapshot is accepted as a single-entry list', async () => {
  const result = await buildEliseVisualContextEnvelope({
    rawActiveContext: {
      source: 'dressing_room',
      visualContext: { source: 'dressing_room', roomId: ROOM_ID, itemId: ITEM_ID, colors: ['fake'] },
    },
    actorId: ACTOR,
    sessionId: 'session-scalar',
    dataSource: mockData({
      fetchDressingRoomItem: async () => ({
        id: ITEM_ID,
        dressing_room_id: ROOM_ID,
        title: 'Charcoal wool overcoat',
        snapshot_payload: { colors: 'charcoal' },
      }),
    }),
  });
  assert.deepEqual(result.envelope.evidence[0].colors, ['charcoal']);
});
