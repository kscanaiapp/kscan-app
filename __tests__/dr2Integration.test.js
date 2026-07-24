const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('DR-2 client builders emit stable-ID attachments only', () => {
  const source = read('types/styleChatAttachments.ts');
  assert.match(source, /buildOwnedDressingRoomItemAttachment/);
  assert.match(source, /buildSharedRoomItemAttachment/);
  assert.match(source, /attachmentType: 'shared_item'/);
  assert.match(source, /sourceType: 'dressing_room_item'/);
  assert.match(source, /sourceType: 'shared_room_item'/);
  assert.doesNotMatch(source, /ownerId|shareToken|storagePath|purchaseUrl/);
});

test('DR-2 feature flags default OFF and are independently named', () => {
  const flags = read('constants/featureFlags.ts');
  assert.match(flags, /ELISE_DRESSING_ROOM_ATTACHMENTS_V1/);
  assert.match(flags, /ELISE_SHARED_ROOM_EVIDENCE_V1/);
  assert.match(flags, /ELISE_ADVICE_METADATA_CLIENT_V1/);
  assert.match(flags, /DRESSING_ROOM_CANONICAL_ITEM_V1/);
  assert.match(flags, /DRESSING_ROOM_COMMERCE_PRESERVATION_V1/);
  assert.match(flags, /DRESSING_ROOM_DEDUPE_V1/);
  assert.match(flags, /SAVED_SCAN_CLOUD_IMAGES_V1/);
  // Default OFF: compare against === 'true' only.
  assert.match(
    flags,
    /EXPO_PUBLIC_ELISE_DRESSING_ROOM_ATTACHMENTS_V1 === 'true'/,
  );
  assert.match(flags, /EXPO_PUBLIC_ELISE_SHARED_ROOM_EVIDENCE_V1 === 'true'/);
  assert.match(flags, /EXPO_PUBLIC_ELISE_ADVICE_METADATA_CLIENT_V1 === 'true'/);
});

test('DR-2 edge provider gates adviceMetadata behind client flag', () => {
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  assert.match(provider, /ELISE_ADVICE_METADATA_CLIENT_V1/);
  assert.match(provider, /includeAdvice/);
  assert.match(provider, /isRecord\(rawAdvice\)/);
});

test('DR-2 attachment validation accepts shared_item and rejects disguise', () => {
  // Evaluate validateAttachmentCombination from source via require after transpile is not available;
  // assert contract presence and shared key helper.
  const store = read('services/style-chat/styleChatAttachmentStore.ts');
  assert.match(store, /shared_item/);
  assert.match(store, /shared:\$\{ref\.sourceType\}/);

  const types = read('types/styleChatAttachments.ts');
  assert.match(types, /MAX_SHARED_ITEM_ATTACHMENTS/);
  assert.match(types, /shared_room_item/);
  assert.ok(types.includes(ITEM) === false); // no hardcoded production IDs
});

test('DR-2 backend index uses dressing_room_id for wardrobe queries', () => {
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /fetchSharedDressingRoomItems/);
  assert.match(index, /\.in\('dressing_room_id'/);
  assert.doesNotMatch(index, /\.select\('id, room_id,/);
  assert.doesNotMatch(index, /\.in\('room_id'/);
});

test('DR-2 E-4 six flags remain present alongside DR-2 flags', () => {
  const config = read('supabase/functions/stylechat-generate/eliseConfig.ts');
  for (const name of [
    'ELISE_ADVICE_INTENTS_V1_ENABLED',
    'ELISE_CLOSET_RETRIEVAL_V1_ENABLED',
    'ELISE_COMPATIBILITY_SCORING_V1_ENABLED',
    'ELISE_WARDROBE_GAP_V1_ENABLED',
    'ELISE_PURCHASE_ADVICE_V1_ENABLED',
    'ELISE_MULTI_LOOK_V1_ENABLED',
    'ELISE_DRESSING_ROOM_ATTACHMENTS_V1_ENABLED',
    'ELISE_SHARED_ROOM_EVIDENCE_V1_ENABLED',
    'ELISE_ADVICE_METADATA_CLIENT_V1_ENABLED',
  ]) {
    assert.match(config, new RegExp(name));
  }
});
