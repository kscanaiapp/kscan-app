import { assertEquals } from 'jsr:@std/assert';
import {
  requestedEliseRoomSource,
  resolveEliseRoomAdviceScope,
} from './eliseRoomAdviceScope.ts';
import type {
  EliseVisualContextEnvelope,
  EliseVisualEvidence,
} from './eliseVisualContextTypes.ts';

const ROOM_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function evidence(overrides: Partial<EliseVisualEvidence> = {}): EliseVisualEvidence {
  return {
    evidenceId: 'room-item',
    sourceType: 'owned_room_item',
    actorRelationship: 'owned',
    trust: 'server_verified',
    sourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    sessionId: null,
    scanId: null,
    itemId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    roomId: ROOM_ID,
    title: 'Blazer',
    summary: null,
    category: 'outerwear',
    subcategory: null,
    colors: ['navy'],
    materials: ['wool'],
    silhouette: null,
    pattern: null,
    fit: null,
    styleAttributes: [],
    textureAttributes: [],
    occasionAttributes: [],
    brand: null,
    brandEvidence: [],
    confidence: null,
    imageReferenceType: 'none',
    canonicalStorageReference: null,
    commerce: null,
    ...overrides,
  };
}

function envelope(
  requestSource: EliseVisualContextEnvelope['requestSource'],
  entries: EliseVisualEvidence[],
): EliseVisualContextEnvelope {
  return {
    internalContractVersion: 'elise_visual_context_v1',
    requestSource,
    focusedEvidenceId: null,
    evidence: entries,
    normalization: {
      receivedCount: entries.length,
      acceptedCount: entries.length,
      droppedCount: 0,
      rejectedCount: 0,
      truncatedCount: 0,
      duplicateCount: 0,
      warnings: [],
    },
  };
}

Deno.test('non-room requests do not constrain normal S7 retrieval', () => {
  assertEquals(resolveEliseRoomAdviceScope(null), { kind: 'none', roomId: null });
  assertEquals(resolveEliseRoomAdviceScope(envelope('closet', [])), {
    kind: 'none',
    roomId: null,
  });
});

Deno.test('a declared room context fails closed when server resolution is unavailable', () => {
  assertEquals(requestedEliseRoomSource({ source: 'dressing_room' }), 'dressing_room');
  assertEquals(requestedEliseRoomSource({ source: 'shared_room' }), 'shared_room');
  assertEquals(requestedEliseRoomSource({ source: 'closet' }), null);
  assertEquals(resolveEliseRoomAdviceScope(null, 'dressing_room'), {
    kind: 'unresolved',
    roomId: null,
  });
  assertEquals(resolveEliseRoomAdviceScope(envelope('shared_room', [evidence({
    sourceType: 'shared_room_item',
    actorRelationship: 'shared',
  })]), 'dressing_room'), {
    kind: 'unresolved',
    roomId: null,
  });
});

Deno.test('verified owned and shared room contexts scope to one exact room', () => {
  assertEquals(resolveEliseRoomAdviceScope(envelope('dressing_room', [evidence()])), {
    kind: 'owned_room',
    roomId: ROOM_ID,
  });
  assertEquals(
    resolveEliseRoomAdviceScope(envelope('shared_room', [evidence({
      sourceType: 'shared_room_item',
      actorRelationship: 'shared',
    })])),
    { kind: 'shared_room', roomId: ROOM_ID },
  );
});

Deno.test('unresolved, contradictory, and mixed-room contexts fail closed', () => {
  assertEquals(resolveEliseRoomAdviceScope(envelope('dressing_room', [])), {
    kind: 'unresolved',
    roomId: null,
  });
  assertEquals(
    resolveEliseRoomAdviceScope(envelope('dressing_room', [evidence({ trust: 'client_metadata' })])),
    { kind: 'unresolved', roomId: null },
  );
  assertEquals(
    resolveEliseRoomAdviceScope(envelope('dressing_room', [
      evidence(),
      evidence({ roomId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }),
    ])),
    { kind: 'unresolved', roomId: null },
  );
});
