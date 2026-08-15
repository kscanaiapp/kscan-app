/** Permanent S7 authority gates: Recent Scan history is never Closet ownership. */
import assert from 'node:assert/strict';

import { runEliseAdvicePipeline } from './eliseAdvicePipeline.ts';
import {
  parseClosetIntelligenceContext,
  type ClosetInventoryState,
} from './closetIntelligenceContext.ts';
import { retrieveAuthorizedWardrobeCandidates } from './eliseWardrobeRetrieval.ts';
import { isStagingClosetProbeRequest } from './closetIntelligenceProbe.ts';
import { ELISE_VISUAL_CONTEXT_INTERNAL_VERSION } from './eliseVisualContextTypes.ts';
import type { EliseVisualContextEnvelope } from './eliseVisualContextTypes.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const RECENT = '22222222-2222-4222-8222-222222222222';

const ALL_FLAGS_ON = {
  adviceIntentsV1: true,
  closetRetrievalV1: true,
  compatibilityScoringV1: true,
  wardrobeGapV1: true,
  purchaseAdviceV1: true,
  multiLookV1: true,
};

function closetRow(ref: string, category: string, color = 'navy') {
  return {
    ref,
    title: category,
    category,
    primaryColor: color,
    materials: ['cotton'],
    __closet_context_authorized: true,
  };
}

function data(input?: {
  state?: ClosetInventoryState;
  closet?: Record<string, unknown>[];
  recent?: Record<string, unknown>[];
}) {
  return {
    closetInventoryState: input?.state ?? 'complete',
    async listClosetItems() {
      return input?.closet ?? [];
    },
    async listSavedScans() {
      return input?.recent ?? [];
    },
    async listInspirationItems() {
      return [];
    },
    async listOwnedRoomItems() {
      return [];
    },
  };
}

function focusEnvelope(category = 'jacket', color = 'navy'): EliseVisualContextEnvelope {
  return {
    internalContractVersion: ELISE_VISUAL_CONTEXT_INTERNAL_VERSION,
    requestSource: 'camera',
    focusedEvidenceId: 'focus',
    evidence: [{
      evidenceId: 'focus',
      sourceType: 'current_scan',
      actorRelationship: 'scanned',
      trust: 'server_verified',
      sourceId: null,
      sessionId: null,
      scanId: RECENT,
      itemId: null,
      roomId: null,
      title: 'Current item',
      summary: null,
      category,
      subcategory: null,
      colors: [color],
      materials: ['cotton'],
      silhouette: null,
      pattern: null,
      fit: null,
      styleAttributes: [],
      textureAttributes: [],
      occasionAttributes: [],
      brand: null,
      brandEvidence: [],
      confidence: 0.8,
      imageReferenceType: 'storage_object',
      canonicalStorageReference: null,
      commerce: null,
    }],
    normalization: {
      receivedCount: 1,
      acceptedCount: 1,
      droppedCount: 0,
      rejectedCount: 0,
      truncatedCount: 0,
      duplicateCount: 0,
      warnings: [],
    },
  };
}

Deno.test('S7 authority: a Recent Scan never saved to Closet is scanned, never owned', async () => {
  const result = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'Use my closet',
    data: data({ recent: [{ id: RECENT, user_id: ACTOR, category: 'jacket' }] }),
  });
  const recent = result.candidates.find((candidate) => candidate.candidateId.includes(RECENT));
  assert.equal(recent?.sourceType, 'recent_scan');
  assert.equal(recent?.actorRelationship, 'scanned');
  assert.equal(result.ownershipSourceCounts.owned ?? 0, 0);
  assert.equal(result.countsBySource.closet ?? 0, 0);
});

Deno.test('S7 authority: deleting/expiring Recent Scan history cannot change Closet ownership', async () => {
  const before = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'Use my closet',
    data: data({ recent: [{ id: RECENT, user_id: ACTOR, category: 'jacket' }] }),
  });
  const after = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'Use my closet',
    data: data({ recent: [] }),
  });
  assert.equal(before.ownershipSourceCounts.owned ?? 0, 0);
  assert.equal(after.ownershipSourceCounts.owned ?? 0, 0);
  assert.equal(before.countsBySource.closet ?? 0, after.countsBySource.closet ?? 0);
});

Deno.test('S7 authority: committed Closet item appears and removal is fresh on next retrieval', async () => {
  const before = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'Use my closet',
    data: data({ closet: [closetRow('closet_1', 'pants')] }),
  });
  const after = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'Use my closet',
    data: data({ closet: [] }),
  });
  assert.equal(before.candidates[0]?.candidateId, 'closet:closet_1');
  assert.equal(before.candidates[0]?.actorRelationship, 'owned');
  assert.equal(after.candidates.some((candidate) => candidate.candidateId === 'closet:closet_1'), false);
});

Deno.test('S7 authority: large Recent Scan history cannot inflate owned wardrobe coverage', async () => {
  const recent = Array.from({ length: 40 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    user_id: ACTOR,
    category: index % 2 ? 'shoes' : 'pants',
  }));
  const result = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'wardrobe_gap',
    message: 'What am I missing to complete this look?',
    data: data({ recent }),
  });
  assert.equal(result.authorizedCount, 40);
  assert.equal(result.ownershipSourceCounts.owned ?? 0, 0);
  assert.equal(result.countsBySource.closet ?? 0, 0);
});

Deno.test('S7 authority: Recent Scans do not satisfy wardrobe-gap coverage', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'What am I missing to complete this look?',
    actorId: ACTOR,
    envelope: focusEnvelope(),
    data: data({
      recent: [
        { id: RECENT, user_id: ACTOR, category: 'shoes', color: 'black' },
        { id: '33333333-3333-4333-8333-333333333333', user_id: ACTOR, category: 'pants' },
      ],
    }),
    flags: ALL_FLAGS_ON,
  });
  assert.ok(result?.wardrobeGap);
  assert.equal(result!.wardrobeGap!.partialInventory, false);
  assert.ok(result!.wardrobeGap!.gapCodes.includes('missing_shoe'));
  assert.ok(result!.wardrobeGap!.gapCodes.includes('missing_bottom'));
});

Deno.test('S7 authority: similar Recent Scan alone cannot suppress purchase advice', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Should I buy this?',
    actorId: ACTOR,
    envelope: focusEnvelope('jacket', 'navy'),
    data: data({
      recent: [{ id: RECENT, user_id: ACTOR, category: 'jacket', color: 'navy' }],
    }),
    flags: ALL_FLAGS_ON,
  });
  assert.ok(result?.purchaseAdvice);
  assert.notEqual(result!.purchaseAdvice!.verdict, 'skip');
  assert.ok(!result!.purchaseAdvice!.reasons.includes('owned_near_duplicate'));
});

Deno.test('S7 authority: partial/unavailable Closet is insufficient evidence, never empty', async () => {
  for (const state of ['partial', 'unavailable'] as const) {
    const result = await runEliseAdvicePipeline({
      message: 'What am I missing to complete this look?',
      actorId: ACTOR,
      envelope: focusEnvelope(),
      data: data({ state, closet: state === 'partial' ? [closetRow('closet_1', 'pants')] : [] }),
      flags: ALL_FLAGS_ON,
    });
    assert.ok(result?.wardrobeGap);
    assert.equal(result!.wardrobeGap!.partialInventory, true);
    assert.deepEqual(result!.wardrobeGap!.gapCodes, []);
    assert.ok(result!.wardrobeGap!.notes.includes('gap_not_inferred_from_missing_evidence'));
    assert.equal(result!.purchaseAdvice?.verdict, 'consider');
    assert.ok(result!.purchaseAdvice?.reasons.includes('insufficient_inventory_evidence'));
  }
});

Deno.test('S7 compatibility: missing/contradictory metadata degrades cautiously without false precision', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Which items in my Closet work together?',
    actorId: ACTOR,
    envelope: focusEnvelope(),
    data: data({
      closet: [
        closetRow('closet_1', 'pants'),
        {
          ...closetRow('closet_2', 'shoes'),
          clothingType: 'jacket',
          primaryColor: null,
          materials: [],
        },
      ],
    }),
    flags: ALL_FLAGS_ON,
  });
  assert.ok(result);
  assert.ok(
    result!.shortlist.some((row) =>
      row.score.warnings.includes('contradictory_category_metadata') &&
      row.score.warnings.includes('vague_candidate_color')
    ),
  );
  assert.doesNotMatch(result!.promptBlock, /\bscore=/i);
  assert.doesNotMatch(result!.promptBlock, /\bconfidence=/i);
  assert.match(result!.promptBlock, /never expose scores or percentages/i);
});

Deno.test('S7 authority: context parser rejects ids, deletion markers, commerce, and malformed refs', () => {
  const accepted = parseClosetIntelligenceContext({
    contractVersion: 'closet_intelligence_context_v1',
    inventoryState: 'complete',
    items: [{ ref: 'closet_1', category: 'jacket', materials: ['wool'] }],
  });
  assert.equal(accepted.ok, true);

  for (const item of [
    { ref: 'closet_1', id: RECENT },
    { ref: 'closet_1', deletedAt: '2026-01-01T00:00:00Z' },
    { ref: 'closet_1', price: 99, retailer: 'Invented', url: 'https://example.invalid' },
    { ref: RECENT, category: 'jacket' },
  ]) {
    const parsed = parseClosetIntelligenceContext({
      contractVersion: 'closet_intelligence_context_v1',
      inventoryState: 'complete',
      items: [item],
    });
    assert.equal(parsed.ok, false);
  }
});

Deno.test('S7 live evidence is explicit staging-only and production-denied', () => {
  assert.equal(isStagingClosetProbeRequest('1', 'staging'), true);
  assert.equal(isStagingClosetProbeRequest('1', 'production'), false);
  assert.equal(isStagingClosetProbeRequest('1', undefined), false);
  assert.equal(isStagingClosetProbeRequest('0', 'staging'), false);
  assert.equal(isStagingClosetProbeRequest(null, 'staging'), false);
});
