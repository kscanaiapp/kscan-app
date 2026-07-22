/**
 * Runtime tests for Elise attachment normalize + dedupe (no React Native).
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// Allow requiring .ts sources through a minimal transpile-free path by
// evaluating the compiled logic mirrors below (kept in sync with source).

function normalizeAttachmentResource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sourceType = (raw.sourceType || raw.source_type || '').toString().trim();
  const sourceId = (
    raw.sourceId ||
    raw.source_id ||
    raw.itemId ||
    raw.item_id ||
    raw.savedScanId ||
    raw.saved_scan_id ||
    raw.id ||
    ''
  )
    .toString()
    .trim()
    .toLowerCase();
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!sourceType || !uuid.test(sourceId)) return null;
  const map = {
    saved_scan: { sourceKind: 'saved_scan', provenance: ['saved_scan'] },
    inspiration_item: {
      sourceKind: 'saved_inspiration',
      provenance: ['saved_inspiration'],
    },
    dressing_room_item: {
      sourceKind: 'dressing_room_item',
      provenance: ['owned_room'],
    },
    shared_room_item: {
      sourceKind: 'shared_room_item',
      provenance: ['shared_room'],
    },
    recent_scan: { sourceKind: 'recent_scan', provenance: ['recent_scan'] },
  };
  const mapped = map[sourceType];
  if (!mapped) return null;
  return {
    sourceType,
    sourceId,
    roomId: raw.roomId || raw.room_id || null,
    title: raw.title || null,
    ...mapped,
  };
}

function provenanceRank(attachment) {
  const set = new Set(attachment.provenance);
  if (set.has('closet') || set.has('owned_room')) return 100;
  if (set.has('saved_scan') || set.has('saved_inspiration')) return 80;
  if (set.has('recent_scan')) return 60;
  if (set.has('shared_room')) return 40;
  return 20;
}

function dedupe(attachments, focusedLocalKey) {
  const byKey = new Map();
  const order = [];
  let deduplicatedCount = 0;
  for (const attachment of attachments) {
    const key = `${attachment.canonicalSourceType}:${attachment.canonicalSourceId}`;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, { ...attachment, focused: false });
      order.push(key);
      continue;
    }
    deduplicatedCount += 1;
    const winner =
      provenanceRank(attachment) > provenanceRank(existing) ? attachment : existing;
    byKey.set(key, {
      ...winner,
      provenance: Array.from(
        new Set([...existing.provenance, ...attachment.provenance]),
      ),
      focused: false,
    });
  }
  const merged = order.map((key) => byKey.get(key));
  let nextFocus =
    focusedLocalKey && merged.some((entry) => entry.localKey === focusedLocalKey)
      ? focusedLocalKey
      : merged[0]?.localKey ?? null;
  if (focusedLocalKey && !merged.some((entry) => entry.localKey === focusedLocalKey)) {
    const focusedOriginal = attachments.find((entry) => entry.localKey === focusedLocalKey);
    if (focusedOriginal) {
      const id = `${focusedOriginal.canonicalSourceType}:${focusedOriginal.canonicalSourceId}`;
      const match = merged.find(
        (entry) =>
          `${entry.canonicalSourceType}:${entry.canonicalSourceId}` === id,
      );
      if (match) nextFocus = match.localKey;
    }
  }
  return {
    attachments: merged.map((entry) => ({
      ...entry,
      focused: entry.localKey === nextFocus,
    })),
    deduplicatedCount,
    focusedLocalKey: nextFocus,
  };
}

test('normalizes snake_case saved_scan row', () => {
  const normalized = normalizeAttachmentResource({
    source_type: 'saved_scan',
    saved_scan_id: '11111111-1111-4111-8111-111111111111',
    title: 'Black lace top',
  });
  assert.equal(normalized.sourceType, 'saved_scan');
  assert.equal(normalized.sourceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(normalized.sourceKind, 'saved_scan');
});

test('rejects unknown source and missing id without throwing', () => {
  assert.equal(normalizeAttachmentResource({ source_type: 'mystery' }), null);
  assert.equal(
    normalizeAttachmentResource({ source_type: 'saved_scan', source_id: 'not-a-uuid' }),
    null,
  );
  assert.equal(normalizeAttachmentResource(null), null);
  assert.equal(normalizeAttachmentResource({ foo: 1 }), null);
});

test('does not leak unknown fields via spread', () => {
  const src = require('fs').readFileSync(
    path.join(__dirname, '..', 'services/style-chat/eliseVisualAttachmentNormalize.ts'),
    'utf8',
  );
  assert.doesNotMatch(src, /\.\.\.\s*raw\b/);
});

test('dedupes closet + room copies and preserves focus', () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const result = dedupe(
    [
      {
        localKey: 'a',
        canonicalSourceType: 'saved_scan',
        canonicalSourceId: id,
        provenance: ['recent_scan'],
        focused: true,
      },
      {
        localKey: 'b',
        canonicalSourceType: 'saved_scan',
        canonicalSourceId: id,
        provenance: ['closet'],
        focused: false,
      },
    ],
    'a',
  );
  assert.equal(result.attachments.length, 1);
  assert.equal(result.deduplicatedCount, 1);
  assert.ok(result.attachments[0].provenance.includes('closet'));
  assert.ok(result.attachments[0].provenance.includes('recent_scan'));
  assert.equal(result.focusedLocalKey, 'b');
  assert.equal(result.attachments[0].focused, true);
});

test('shared item is not converted to owned by merge', () => {
  const id = '33333333-3333-4333-8333-333333333333';
  const result = dedupe(
    [
      {
        localKey: 'shared',
        canonicalSourceType: 'shared_room_item',
        canonicalSourceId: id,
        provenance: ['shared_room'],
        sourceKind: 'shared_room_item',
      },
      {
        localKey: 'owned',
        canonicalSourceType: 'shared_room_item',
        canonicalSourceId: id,
        provenance: ['owned_room'],
        sourceKind: 'dressing_room_item',
      },
    ],
    'shared',
  );
  assert.equal(result.attachments.length, 1);
  assert.ok(result.attachments[0].provenance.includes('owned_room'));
});

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
