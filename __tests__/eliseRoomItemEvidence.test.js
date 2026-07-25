const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const {
  evidenceKindForOwnedAttachmentSource,
  sanitizeRoomItemEvidenceFields,
  isEliseRoomEvidenceKind,
} = require('../supabase/functions/stylechat-generate/eliseRoomItemEvidence.ts');

const { parseStyleChatAttachments } = require('../supabase/functions/stylechat-generate/attachments.ts');

test('Elise room evidence helpers distinguish owned vs shared', () => {
  assert.equal(evidenceKindForOwnedAttachmentSource('dressing_room_item'), 'owned_room_item');
  assert.equal(evidenceKindForOwnedAttachmentSource('shared_room_item'), 'shared_room_item');
  assert.equal(isEliseRoomEvidenceKind('owned_room_item'), true);
  const sanitized = sanitizeRoomItemEvidenceFields({
    title: 'Navy blazer',
    brand: 'House',
    category: 'outerwear',
    purchaseOptionCount: 3,
  });
  assert.equal(sanitized.title, 'Navy blazer');
  assert.equal(sanitized.purchaseOptionCount, 3);
  assert.equal('productUrl' in sanitized, false);
});

test('attachments parser accepts dressing_room_item source type', () => {
  const parsed = parseStyleChatAttachments([
    {
      attachmentType: 'owned_item',
      sourceType: 'dressing_room_item',
      sourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    },
  ]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.attachments[0].sourceType, 'dressing_room_item');
});

test('attachmentContext wires owned dressing room item fetch without commerce leakage', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/stylechat-generate/attachmentContext.ts'),
    'utf8',
  );
  const index = fs.readFileSync(
    path.join(ROOT, 'supabase/functions/stylechat-generate/index.ts'),
    'utf8',
  );
  assert.match(source, /dressingRoomItemToEvidence/);
  assert.match(source, /fetchDressingRoomItems/);
  assert.match(index, /fetchDressingRoomItems/);
  assert.match(index, /dressing_room_items/);
});
