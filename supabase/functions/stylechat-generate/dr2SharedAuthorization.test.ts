/**
 * DR-2 Deno integration — shared authorization + relationship + column wiring.
 */
import assert from 'node:assert/strict';

import { parseStyleChatAttachments } from './attachments.ts';
import {
  decideSharedRoomAccess,
  mapMembershipJoinRow,
} from './eliseSharedRoomAccess.ts';
import { roomItemRelationship } from './eliseWardrobeRetrieval.ts';
import { ownershipLanguageLabel } from './eliseFashionFeatures.ts';
import { readEliseBackendConfig } from './eliseConfig.ts';
import {
  resolveStyleChatAttachments,
  dressingRoomItemToEvidence,
} from './attachmentContext.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const ROOM_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ROOM_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ITEM_A = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHARE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

Deno.test('DR-2 shared access rejects revoked, expired, owner mismatch, and cross-room', () => {
  const base = {
    membershipId: 'm1',
    shareId: SHARE,
    roomId: ROOM_A,
    shareOwnerId: OWNER,
    isActive: true,
    revokedAt: null as string | null,
    expiresAt: null as string | null,
    removedAt: null as string | null,
    currentRoomOwnerId: OWNER,
  };

  assert.equal(
    decideSharedRoomAccess({ actorId: ACTOR, roomId: ROOM_A, rows: [base] }).ok,
    true,
  );

  assert.equal(
    decideSharedRoomAccess({
      actorId: ACTOR,
      roomId: ROOM_A,
      rows: [{ ...base, revokedAt: '2026-01-01T00:00:00Z' }],
    }).ok,
    false,
  );

  assert.equal(
    decideSharedRoomAccess({
      actorId: ACTOR,
      roomId: ROOM_A,
      rows: [{ ...base, expiresAt: '2020-01-01T00:00:00Z' }],
      nowMs: Date.parse('2026-07-21T00:00:00Z'),
    }).ok,
    false,
  );

  assert.equal(
    decideSharedRoomAccess({
      actorId: ACTOR,
      roomId: ROOM_A,
      rows: [{ ...base, currentRoomOwnerId: ACTOR }],
    }).ok,
    false,
  );

  // Room A share must not authorize Room B.
  assert.equal(
    decideSharedRoomAccess({ actorId: ACTOR, roomId: ROOM_B, rows: [base] }).ok,
    false,
  );

  // Owner-as-recipient is not shared evidence.
  assert.equal(
    decideSharedRoomAccess({ actorId: OWNER, roomId: ROOM_A, rows: [base] }).ok,
    false,
  );
});

Deno.test('DR-2 mapMembershipJoinRow ignores public-token-shaped fields', () => {
  const mapped = mapMembershipJoinRow({
    id: 'm1',
    share_id: SHARE,
    removed_at: null,
    share_token: 'should-be-ignored',
    room_shares: {
      id: SHARE,
      room_id: ROOM_A,
      owner_id: OWNER,
      is_active: true,
      revoked_at: null,
      expires_at: null,
    },
  });
  assert.ok(mapped);
  assert.equal(mapped!.roomId, ROOM_A);
  assert.equal(mapped!.shareOwnerId, OWNER);
  assert.equal((mapped as Record<string, unknown>).share_token, undefined);
});

Deno.test('DR-2 relationship mapper never claims ownership from room presence alone', () => {
  assert.equal(
    roomItemRelationship({ source_type: 'product_match' }).actorRelationship,
    'saved',
  );
  assert.equal(
    roomItemRelationship({ source_type: 'scan_image' }).actorRelationship,
    'scanned',
  );
  assert.equal(
    roomItemRelationship({
      snapshot_payload: { canonical: { source: { kind: 'catalog_product' } } },
    }).actorRelationship,
    'saved',
  );
  assert.equal(roomItemRelationship({}).actorRelationship, 'unverified');
  assert.equal(ownershipLanguageLabel('shared'), 'Shared with you');
  assert.equal(ownershipLanguageLabel('scanned'), 'The item you scanned');
});

Deno.test('DR-2 shared_item parse rejects owned_item disguise and accepts shared contract', () => {
  const bad = parseStyleChatAttachments([
    {
      attachmentType: 'owned_item',
      sourceType: 'shared_room_item',
      sourceId: ITEM_A,
    },
  ]);
  assert.equal(bad.ok, false);

  const good = parseStyleChatAttachments([
    {
      attachmentType: 'shared_item',
      sourceType: 'shared_room_item',
      sourceId: ITEM_A,
    },
  ]);
  assert.equal(good.ok, true);
  if (good.ok) {
    assert.equal(good.attachments[0].attachmentType, 'shared_item');
  }
});

Deno.test('DR-2 shared attachment resolution fails closed without authorized fetch', async () => {
  const parsed = parseStyleChatAttachments([
    { attachmentType: 'shared_item', sourceType: 'shared_room_item', sourceId: ITEM_A },
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  const rejected = await resolveStyleChatAttachments(parsed.attachments, {
    async fetchSavedScans() {
      return [];
    },
    async fetchInspirationItems() {
      return [];
    },
    async fetchLook() {
      return null;
    },
    async fetchLookItems() {
      return [];
    },
    // No fetchSharedDressingRoomItems → fail closed
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.errorCode, 'ATTACHMENT_NOT_OWNED');

  const accepted = await resolveStyleChatAttachments(parsed.attachments, {
    async fetchSavedScans() {
      return [];
    },
    async fetchInspirationItems() {
      return [];
    },
    async fetchLook() {
      return null;
    },
    async fetchLookItems() {
      return [];
    },
    async fetchSharedDressingRoomItems(ids) {
      assert.deepEqual(ids, [ITEM_A]);
      return [
        {
          id: ITEM_A,
          dressing_room_id: ROOM_A,
          title: 'Shared blazer',
          category: 'jacket',
          snapshot_payload: {},
        },
      ];
    },
  });
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.equal(accepted.resolved[0].attachmentType, 'shared_item');
    const item = accepted.resolved[0].items[0];
    assert.equal(item.ref.sourceType, 'shared_room_item');
    assert.doesNotMatch(JSON.stringify(item), /storage_path|https?:\/\//);
  }
});

Deno.test('DR-2 evidence mapper excludes purchase URLs and storage paths from text fields', () => {
  const evidence = dressingRoomItemToEvidence(
    {
      id: ITEM_A,
      title: 'Coat',
      category: 'outerwear',
      brand: 'Neutral',
      storage_bucket: 'style-library-images',
      storage_path: 'private/path/secret.jpg',
      snapshot_payload: {
        purchaseOptions: [{ url: 'https://evil.example/buy', retailer: 'X' }],
      },
    },
    'shared_room_item',
  );
  assert.equal(evidence.ref.sourceType, 'shared_room_item');
  assert.equal(evidence.media?.path, 'private/path/secret.jpg');
  // Media is private structured ref — never in title/text fields.
  assert.doesNotMatch(evidence.title, /private\/path|https?:\/\//);
});

Deno.test('DR-2 flags default OFF including shared evidence and advice metadata', () => {
  const config = readEliseBackendConfig({ get: () => undefined });
  assert.equal(config.flags.sharedRoomEvidenceV1, false);
  assert.equal(config.flags.dressingRoomAttachmentsV1, false);
  assert.equal(config.flags.adviceMetadataClientV1, false);
  assert.equal(config.flags.adviceIntentsV1, false);
});
