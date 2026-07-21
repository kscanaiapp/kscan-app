/**
 * DR-2 Deno integration — backend wiring chain smoke (behavioral modules).
 */
import assert from 'node:assert/strict';

import { runEliseAdvicePipeline } from './eliseAdvicePipeline.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';

async function readIndex(): Promise<string> {
  return await Deno.readTextFile(new URL('./index.ts', import.meta.url));
}

Deno.test('DR-2 index wires owned+shared attachments and E-4 advice under flags', async () => {
  const index = await readIndex();
  assert.match(index, /fetchDressingRoomItems/);
  assert.match(index, /fetchSharedDressingRoomItems/);
  assert.match(index, /runEliseAdvicePipeline/);
  assert.match(index, /adviceIntentsV1/);
  assert.match(index, /dressingRoomAttachmentsV1/);
  assert.match(index, /sharedRoomEvidenceV1/);
  assert.match(index, /adviceMetadataClientV1/);
  // Authoritative column — not the incorrect room_id filter on dressing_room_items.
  assert.match(index, /\.in\('dressing_room_id'/);
  assert.doesNotMatch(index, /\.in\('room_id'/);
  assert.match(index, /ELISE_ADVICE_CONTRACT_VERSION/);
});

Deno.test('DR-2 advice pipeline stays flag-off silent and flag-on bounded', async () => {
  const ITEM = '33333333-3333-4333-8333-333333333333';
  const ROOM = '44444444-4444-4444-8444-444444444444';

  const off = await runEliseAdvicePipeline({
    message: 'style this',
    actorId: '11111111-1111-4111-8111-111111111111',
    envelope: null,
    data: {
      async listSavedScans() {
        return [];
      },
      async listInspirationItems() {
        return [];
      },
      async listOwnedRoomItems() {
        return [{ id: ITEM, dressing_room_id: ROOM, __room_owned_by_actor: true }];
      },
    },
    flags: {
      adviceIntentsV1: false,
      closetRetrievalV1: false,
      compatibilityScoringV1: false,
      wardrobeGapV1: false,
      purchaseAdviceV1: false,
      multiLookV1: false,
    },
  });
  assert.equal(off, null);

  const on = await runEliseAdvicePipeline({
    message: 'build an outfit from what I have',
    actorId: '11111111-1111-4111-8111-111111111111',
    envelope: null,
    data: {
      async listSavedScans() {
        return [];
      },
      async listInspirationItems() {
        return [];
      },
      async listOwnedRoomItems(_actorId, limit) {
        const rows = [];
        const capped = Math.min(limit, 40);
        for (let i = 0; i < 80; i += 1) {
          if (rows.length >= capped) break;
          const id = `55555555-5555-4555-8555-${String(i).padStart(12, '0')}`;
          rows.push({
            id,
            dressing_room_id: ROOM,
            category: i % 2 === 0 ? 'pants' : 'shoes',
            source_type: 'scan_image',
            __room_owned_by_actor: true,
          });
        }
        return rows;
      },
    },
    flags: {
      adviceIntentsV1: true,
      closetRetrievalV1: true,
      compatibilityScoringV1: true,
      wardrobeGapV1: false,
      purchaseAdviceV1: false,
      multiLookV1: false,
    },
  });
  assert.ok(on);
  assert.ok(on!.adviceMetadata);
  assert.ok(on!.telemetry.authorizedCount <= ELISE_ADVICE_LIMITS.initialCandidatesPerSource);
  assert.ok(
    (on!.adviceMetadata.recommendations?.length ?? 0) <= ELISE_ADVICE_LIMITS.groundedShortlist,
  );
  assert.doesNotMatch(on!.promptBlock, /https?:\/\//);
  assert.doesNotMatch(on!.promptBlock, /storage_path|signed/);
});
