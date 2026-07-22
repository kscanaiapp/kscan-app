/**
 * Ownership-provenance regression — the false-ownership P1 closeout.
 *
 * Verifies that stylechat-generate derives ownership language from the resolved
 * row provenance (never from attachmentType or the attached image), for every
 * provenance type in the closeout requirement:
 *   camera image / gallery screenshot / recent scan → scanned (ownership unconfirmed)
 *   saved product / inspiration                     → saved (not owned)
 *   closet / explicit owned                         → owned
 *   shared room item                                → shared (not owned by requester)
 *   dressing-room item                              → follows item provenance, not the room
 */
import assert from 'node:assert/strict';

import { parseStyleChatAttachments } from './attachments.ts';
import {
  buildAttachmentContextBlock,
  dressingRoomItemToEvidence,
  resolveStyleChatAttachments,
  type AttachmentDataSource,
} from './attachmentContext.ts';
import {
  attachmentOwnershipNote,
  relationshipForDressingRoomRow,
  relationshipForLookItem,
} from './attachmentProvenance.ts';
import { roomItemRelationship } from './eliseWardrobeRetrieval.ts';

const SCAN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ROOM_ITEM = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SHARED_ITEM = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const ROOM = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function emptySource(overrides: Partial<AttachmentDataSource> = {}): AttachmentDataSource {
  return {
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
    ...overrides,
  };
}

async function relationshipFor(
  attachment: Record<string, unknown>,
  source: AttachmentDataSource,
): Promise<string> {
  const parsed = parseStyleChatAttachments([attachment]);
  assert.equal(parsed.ok, true, 'attachment must parse');
  if (!parsed.ok) throw new Error('unreachable');
  const resolved = await resolveStyleChatAttachments(parsed.attachments, source);
  assert.equal(resolved.ok, true, 'attachment must resolve');
  if (!resolved.ok) throw new Error('unreachable');
  return resolved.resolved[0].items[0].relationship;
}

// ── Direct image / screenshot / recent scan → scanned ─────────────────────────

Deno.test('saved_scan attachment (camera / gallery / recent scan) is scanned, never owned', async () => {
  const relationship = await relationshipFor(
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: SCAN },
    emptySource({
      async fetchSavedScans() {
        return [{ id: SCAN, user_id: 'u', title: 'Screenshot', analysis_result: {}, media_status: 'ready' }];
      },
    }),
  );
  assert.equal(relationship, 'scanned');
  assert.equal(attachmentOwnershipNote(relationship as never), 'scanned_ownership_unconfirmed');
  assert.notEqual(relationship, 'owned');
});

// ── Saved product / inspiration → saved ───────────────────────────────────────

Deno.test('inspiration_item attachment (saved product) is saved, not owned', async () => {
  const relationship = await relationshipFor(
    { attachmentType: 'owned_item', sourceType: 'inspiration_item', sourceId: INSP },
    emptySource({
      async fetchInspirationItems() {
        return [{ id: INSP, user_id: 'u', note: 'Nice top', category: 'top' }];
      },
    }),
  );
  assert.equal(relationship, 'saved');
  assert.equal(attachmentOwnershipNote(relationship as never), 'saved_not_owned');
});

// ── Shared room item → shared (never owned by requester) ──────────────────────

Deno.test('shared_room_item is shared, not owned — even if source kind looks owned', async () => {
  const relationship = await relationshipFor(
    { attachmentType: 'shared_item', sourceType: 'shared_room_item', sourceId: SHARED_ITEM },
    emptySource({
      async fetchSharedDressingRoomItems() {
        return [
          {
            id: SHARED_ITEM,
            dressing_room_id: ROOM,
            title: 'Shared coat',
            category: 'outerwear',
            // Even an explicit owned-closet source kind must not flip a shared
            // item to owned — it belongs to the room owner, not the requester.
            source_type: 'owned_closet',
            snapshot_payload: {},
          },
        ];
      },
    }),
  );
  assert.equal(relationship, 'shared');
  assert.equal(attachmentOwnershipNote(relationship as never), 'shared_not_owned');
});

// ── Dressing-room item → follows item provenance, not the room ─────────────────

Deno.test('owned dressing-room item ownership follows source kind, not room membership', async () => {
  const scanRoomItem = await relationshipFor(
    { attachmentType: 'owned_item', sourceType: 'dressing_room_item', sourceId: ROOM_ITEM },
    emptySource({
      async fetchDressingRoomItems() {
        return [
          {
            id: ROOM_ITEM,
            dressing_room_id: ROOM,
            title: 'Scanned blazer',
            category: 'jacket',
            source_type: 'scan_image',
            snapshot_payload: {},
          },
        ];
      },
    }),
  );
  assert.equal(scanRoomItem, 'scanned', 'scan_image room item is scanned, not owned');

  const productRoomItem = await relationshipFor(
    { attachmentType: 'owned_item', sourceType: 'dressing_room_item', sourceId: ROOM_ITEM },
    emptySource({
      async fetchDressingRoomItems() {
        return [
          {
            id: ROOM_ITEM,
            dressing_room_id: ROOM,
            title: 'Matched product',
            category: 'jacket',
            source_type: 'product_match',
            snapshot_payload: {},
          },
        ];
      },
    }),
  );
  assert.equal(productRoomItem, 'saved', 'product_match room item is saved, not owned');
});

// ── Explicit owned provenance → owned ─────────────────────────────────────────

Deno.test('only explicit owned-closet provenance yields owned', () => {
  assert.equal(relationshipForDressingRoomRow({ source_type: 'owned_closet' }), 'owned');
  assert.equal(relationshipForDressingRoomRow({ source_type: 'physically_owned' }), 'owned');
  // Bare presence in the user's own room is NOT ownership.
  assert.equal(relationshipForDressingRoomRow({}), 'unverified');
  assert.equal(dressingRoomItemToEvidence({ id: ROOM_ITEM, source_type: 'owned_closet' }, 'dressing_room_item').relationship, 'owned');
});

// ── Look items follow their source ref ────────────────────────────────────────

Deno.test('look items derive ownership from their source ref', () => {
  assert.equal(relationshipForLookItem({ source_saved_scan_id: SCAN }), 'scanned');
  assert.equal(relationshipForLookItem({ source_inspiration_item_id: INSP }), 'saved');
  assert.equal(relationshipForLookItem({}), 'unverified');
});

// ── Classifier parity with the established wardrobe doctrine ───────────────────

Deno.test('attachment classifier agrees with roomItemRelationship on canonical kinds', () => {
  for (const kind of ['product_match', 'scan_image', 'inspiration', 'owned_closet', 'catalog_product', 'live_scan']) {
    assert.equal(
      relationshipForDressingRoomRow({ source_type: kind }),
      roomItemRelationship({ source_type: kind }).actorRelationship,
      `classifiers must agree for source kind ${kind}`,
    );
  }
});

// ── Context block never labels a non-owned item as owned ──────────────────────

Deno.test('context block carries authoritative ownership= and never says owned for a scan', async () => {
  const parsed = parseStyleChatAttachments([
    { attachmentType: 'owned_item', sourceType: 'saved_scan', sourceId: SCAN },
  ]);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const resolved = await resolveStyleChatAttachments(
    parsed.attachments,
    emptySource({
      async fetchSavedScans() {
        return [{ id: SCAN, user_id: 'u', title: 'Screenshot', analysis_result: {}, media_status: 'ready' }];
      },
    }),
  );
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;
  const block = buildAttachmentContextBlock(resolved.resolved);
  assert.match(block, /ownership=scanned_ownership_unconfirmed/);
  assert.doesNotMatch(block, /ownership=owned/);
});
