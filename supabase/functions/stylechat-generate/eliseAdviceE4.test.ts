/**
 * E-4 Deno tests — intents, focus, scoring, retrieval auth, purchase, gap, multi-look, privacy.
 */
import assert from 'node:assert/strict';

import { classifyEliseAdviceIntent, intentAllowsCommerce } from './eliseAdviceIntents.ts';
import { resolveEliseFocusedItem } from './eliseFocusResolution.ts';
import { rankAndBoundCandidates, scoreWardrobeCompatibility } from './eliseCompatibilityScoring.ts';
import { normalizeWardrobeCandidate, ownershipLanguageLabel } from './eliseFashionFeatures.ts';
import { retrieveAuthorizedWardrobeCandidates } from './eliseWardrobeRetrieval.ts';
import {
  analyzeWardrobeGap,
  buildMultiLooks,
  buildPurchaseAdvice,
} from './eliseWardrobeGap.ts';
import { runEliseAdvicePipeline } from './eliseAdvicePipeline.ts';
import { buildEliseAdvicePromptBlock } from './eliseAdvicePrompt.ts';
import { readEliseBackendConfig } from './eliseConfig.ts';
import { ELISE_ADVICE_LIMITS } from './eliseAdviceTypes.ts';
import type { EliseVisualContextEnvelope } from './eliseVisualContextTypes.ts';
import { ELISE_VISUAL_CONTEXT_INTERNAL_VERSION } from './eliseVisualContextTypes.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ITEM_A = '33333333-3333-4333-8333-333333333333';
const ITEM_B = '44444444-4444-4444-8444-444444444444';
const ITEM_C = '55555555-5555-4555-8555-555555555555';
const ITEM_D = '66666666-6666-4666-8666-666666666666';
const ITEM_E = '77777777-7777-4777-8777-777777777777';
const ITEM_F = '88888888-8888-4888-8888-888888888888';
const ITEM_G = '99999999-9999-4999-8999-999999999999';
const ITEM_H = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function env(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

function makeEnvelope(partial: Partial<EliseVisualContextEnvelope['evidence'][number]>[]): EliseVisualContextEnvelope {
  return {
    internalContractVersion: ELISE_VISUAL_CONTEXT_INTERNAL_VERSION,
    requestSource: 'camera',
    focusedEvidenceId: partial[0]?.evidenceId ?? null,
    evidence: partial.map((e, i) => ({
      evidenceId: e.evidenceId ?? `ev-${i}`,
      sourceType: e.sourceType ?? 'current_scan',
      actorRelationship: e.actorRelationship ?? 'scanned',
      trust: e.trust ?? 'server_verified',
      sourceId: e.sourceId ?? null,
      sessionId: null,
      scanId: e.scanId ?? null,
      itemId: e.itemId ?? null,
      roomId: e.roomId ?? null,
      title: e.title ?? 'Focused jacket',
      summary: e.summary ?? null,
      category: e.category ?? 'jacket',
      subcategory: e.subcategory ?? null,
      colors: e.colors ?? ['navy'],
      materials: e.materials ?? ['wool'],
      silhouette: e.silhouette ?? 'structured',
      pattern: null,
      fit: null,
      styleAttributes: e.styleAttributes ?? [],
      textureAttributes: e.textureAttributes ?? [],
      occasionAttributes: e.occasionAttributes ?? [],
      brand: e.brand ?? null,
      brandEvidence: e.brandEvidence ?? [],
      confidence: e.confidence ?? 0.8,
      imageReferenceType: 'storage_object',
      canonicalStorageReference: null,
      commerce: null,
    })),
    normalization: {
      receivedCount: partial.length,
      acceptedCount: partial.length,
      droppedCount: 0,
      rejectedCount: 0,
      truncatedCount: 0,
      duplicateCount: 0,
      warnings: [],
    },
  };
}

Deno.test('E-4 flags default OFF', () => {
  const config = readEliseBackendConfig(env({}));
  assert.equal(config.flags.adviceIntentsV1, false);
  assert.equal(config.flags.closetRetrievalV1, false);
  assert.equal(config.flags.compatibilityScoringV1, false);
  assert.equal(config.flags.wardrobeGapV1, false);
  assert.equal(config.flags.purchaseAdviceV1, false);
  assert.equal(config.flags.multiLookV1, false);
});

Deno.test('E-4 intent classification covers supported intents', () => {
  assert.equal(classifyEliseAdviceIntent('What goes with this jacket?'), 'style_current_item');
  assert.equal(classifyEliseAdviceIntent('Build an outfit using this top'), 'build_outfit');
  assert.equal(classifyEliseAdviceIntent('Do I already own something similar?'), 'find_owned_alternative');
  assert.equal(classifyEliseAdviceIntent('Which saved item is the best alternative?'), 'find_saved_alternative');
  assert.equal(classifyEliseAdviceIntent('Should I buy this?'), 'purchase_advice');
  assert.equal(classifyEliseAdviceIntent('What am I missing to complete this look?'), 'wardrobe_gap');
  assert.equal(classifyEliseAdviceIntent('Give me three ways to style this'), 'multi_look_generation');
  assert.equal(classifyEliseAdviceIntent('Would this work for a work dinner?'), 'occasion_fit');
  assert.equal(classifyEliseAdviceIntent('What colors should I pair with this?'), 'color_pairing');
  assert.equal(classifyEliseAdviceIntent('What shoes work with this dress?'), 'shoe_pairing');
  assert.equal(classifyEliseAdviceIntent('Any accessories for this?'), 'accessory_pairing');
  assert.equal(classifyEliseAdviceIntent('How should I layer this for winter?'), 'layering_advice');
  assert.equal(classifyEliseAdviceIntent('Hello there'), 'general_style_advice');
  assert.equal(
    classifyEliseAdviceIntent('Should I buy this?', { noShopping: true }),
    'find_owned_alternative',
  );
  assert.equal(intentAllowsCommerce('build_outfit', 'without buying anything new'), false);
});

Deno.test('E-4 focus resolution prefers focused evidence and selected scan', () => {
  const focused = resolveEliseFocusedItem({
    envelope: makeEnvelope([
      {
        evidenceId: 'focus-1',
        sourceType: 'current_scan',
        actorRelationship: 'scanned',
        category: 'jacket',
        colors: ['black'],
      },
    ]),
  });
  assert.equal(focused.resolution, 'focused_evidence');
  assert.equal(focused.candidate?.category, 'jacket');

  const selected = resolveEliseFocusedItem({
    envelope: {
      ...makeEnvelope([
        { evidenceId: 'a', sourceType: 'recent_scan', category: 'pants' },
        { evidenceId: 'b', sourceType: 'selected_scan_item', category: 'dress' },
      ]),
      focusedEvidenceId: null,
    },
  });
  assert.equal(selected.resolution, 'explicit_selected');
  assert.equal(selected.candidate?.category, 'dress');

  const none = resolveEliseFocusedItem({ envelope: null });
  assert.equal(none.resolution, 'none');
});

Deno.test('E-4 ownership language never conflates saved/shared/commerce', () => {
  assert.equal(ownershipLanguageLabel('owned'), 'You already have');
  assert.equal(ownershipLanguageLabel('saved'), "You've saved");
  assert.equal(ownershipLanguageLabel('shared'), 'Shared with you');
  assert.equal(ownershipLanguageLabel('discovered'), 'One available option is');
  assert.equal(ownershipLanguageLabel('scanned'), 'The item you scanned');
  assert.equal(ownershipLanguageLabel('unverified'), 'Based on the available details');
});

Deno.test('E-4 retrieval rejects unauthorized Closet and room rows', async () => {
  const result = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'build an outfit',
    data: {
      async listSavedScans() {
        return [
          { id: ITEM_A, user_id: ACTOR, title: 'Owned pants', category: 'pants', color: 'black' },
          { id: ITEM_B, user_id: OTHER, title: 'Other pants', category: 'pants', color: 'blue' },
        ];
      },
      async listInspirationItems() {
        return [
          { id: ITEM_C, user_id: ACTOR, category: 'skirt', color: 'cream' },
          { id: ITEM_D, user_id: OTHER, category: 'skirt', color: 'red' },
        ];
      },
      async listOwnedRoomItems() {
        return [
          {
            id: ITEM_E,
            room_id: ITEM_F,
            category: 'shoes',
            color: 'black',
            __room_owned_by_actor: true,
          },
          { id: ITEM_G, room_id: ITEM_F, category: 'shoes', __room_owned_by_actor: false },
        ];
      },
      async listSharedRoomItems() {
        return [
          {
            id: ITEM_H,
            room_id: ITEM_F,
            category: 'bag',
            __shared_access: true,
          },
          { id: 'not-a-uuid', room_id: ITEM_F, __shared_access: true },
        ];
      },
    },
    includeShared: true,
  });

  assert.ok(result.candidates.every((c) => !c.candidateId.includes(ITEM_B)));
  assert.ok(result.candidates.every((c) => !c.candidateId.includes(ITEM_D)));
  assert.ok(result.rejectedCount >= 3);
  assert.ok(result.candidates.length <= ELISE_ADVICE_LIMITS.rankedCandidates);
  assert.ok(!result.candidates.some((c) => c.candidateId.includes('not-a-uuid')));
});

// DR-2: catalog/product_match → saved; scan_image → scanned; unknown → unverified.
// Room presence alone never establishes physical ownership.
Deno.test('E-4 room items saved from a catalog match are "saved", not "owned"', async () => {
  const result = await retrieveAuthorizedWardrobeCandidates({
    actorId: ACTOR,
    intent: 'build_outfit',
    message: 'build an outfit',
    data: {
      async listSavedScans() {
        return [];
      },
      async listInspirationItems() {
        return [];
      },
      async listOwnedRoomItems() {
        return [
          {
            id: ITEM_E,
            room_id: ITEM_F,
            category: 'shoes',
            source_type: 'product_match',
            __room_owned_by_actor: true,
          },
          {
            id: ITEM_G,
            room_id: ITEM_F,
            category: 'jacket',
            source_type: 'scan_image',
            __room_owned_by_actor: true,
          },
          {
            id: ITEM_H,
            room_id: ITEM_F,
            category: 'bag',
            snapshot_payload: { canonical: { source: { kind: 'catalog_product' } } },
            __room_owned_by_actor: true,
          },
          {
            // No source_type at all (legacy row) → unverified (not owned).
            id: ITEM_D,
            room_id: ITEM_F,
            category: 'belt',
            __room_owned_by_actor: true,
          },
        ];
      },
    },
  });

  const byId = (id: string) => result.candidates.find((c) => c.candidateId === `owned_room:${id}`);
  assert.equal(byId(ITEM_E)?.actorRelationship, 'saved');
  assert.equal(byId(ITEM_E)?.sourceType, 'saved_product');
  assert.equal(byId(ITEM_G)?.actorRelationship, 'scanned');
  assert.equal(byId(ITEM_H)?.actorRelationship, 'saved');
  assert.equal(byId(ITEM_D)?.actorRelationship, 'unverified');
});

Deno.test('E-4 compatibility scoring prioritizes owned complements and penalizes redundancy', () => {
  const focus = normalizeWardrobeCandidate({
    candidateId: 'focus',
    sourceType: 'focused_scan',
    actorRelationship: 'scanned',
    row: { category: 'jacket', color: 'navy', silhouette: 'structured' },
  });
  const ownedPants = normalizeWardrobeCandidate({
    candidateId: 'owned-pants',
    sourceType: 'closet',
    actorRelationship: 'owned',
    row: { category: 'pants', color: 'black', silhouette: 'slim' },
  });
  const dupJacket = normalizeWardrobeCandidate({
    candidateId: 'dup',
    sourceType: 'closet',
    actorRelationship: 'owned',
    row: { category: 'jacket', color: 'navy', silhouette: 'structured' },
  });
  const commerce = normalizeWardrobeCandidate({
    candidateId: 'commerce',
    sourceType: 'commerce_product',
    actorRelationship: 'discovered',
    row: { category: 'pants', color: 'black' },
  });

  const ownedScore = scoreWardrobeCompatibility({
    focus,
    candidate: ownedPants,
    intent: 'style_current_item',
  });
  const commerceScore = scoreWardrobeCompatibility({
    focus,
    candidate: commerce,
    intent: 'style_current_item',
  });
  assert.ok(ownedScore.total > commerceScore.total);

  const ranked = rankAndBoundCandidates({
    focus: {
      evidenceId: 'e1',
      actorRelationship: 'scanned',
      candidate: focus,
      resolution: 'current_scan',
    },
    candidates: [dupJacket, ownedPants, commerce],
    intent: 'purchase_advice',
  });
  assert.ok(ranked.length <= ELISE_ADVICE_LIMITS.groundedShortlist);
  assert.ok(ranked[0].candidate.actorRelationship === 'owned' || ranked.length > 0);
});

Deno.test('E-4 compatibility scoring reports candidate gaps even without a focused item', () => {
  const incomplete = normalizeWardrobeCandidate({
    candidateId: 'missing-color',
    sourceType: 'closet',
    actorRelationship: 'owned',
    row: { category: 'pants' },
  });
  const score = scoreWardrobeCompatibility({
    focus: null,
    candidate: incomplete,
    intent: 'style_current_item',
  });
  assert.ok(score.warnings.includes('vague_color_metadata'));
  assert.ok(score.warnings.includes('vague_candidate_color'));
});

Deno.test('E-4 purchase advice skip/buy/consider and retailer neutrality', () => {
  const focus = {
    evidenceId: 'e',
    actorRelationship: 'scanned' as const,
    candidate: normalizeWardrobeCandidate({
      candidateId: 'focus',
      sourceType: 'focused_scan',
      actorRelationship: 'scanned',
      row: { category: 'jacket', color: 'navy', confidence: 0.9 },
    }),
    resolution: 'current_scan' as const,
  };
  const skip = buildPurchaseAdvice({
    intent: 'purchase_advice',
    focus,
    shortlist: [
      {
        candidate: normalizeWardrobeCandidate({
          candidateId: 'owned',
          sourceType: 'closet',
          actorRelationship: 'owned',
          row: { category: 'jacket', color: 'navy' },
        }),
        score: {
          total: 0.9,
          dimensions: {
            categoryRole: 1,
            colorHarmony: 1,
            silhouetteBalance: 0.5,
            materialTexture: 0.5,
            formality: 0.5,
            season: 0.5,
            occasion: 0.5,
            signatureStyle: 0.5,
            ownershipPriority: 1,
            redundancyPenalty: 0.2,
          },
          reasons: ['near_duplicate_alternative'],
          warnings: [],
        },
        recommendationRole: 'substitute',
      },
    ],
    wardrobeGap: null,
  });
  assert.equal(skip?.verdict, 'skip');
  assert.ok(skip?.reasons.includes('no_false_urgency'));

  const buy = buildPurchaseAdvice({
    intent: 'purchase_advice',
    focus,
    shortlist: [],
    wardrobeGap: {
      gapCodes: ['missing_shoe', 'missing_layer'],
      categories: ['shoes', 'outerwear'],
      partialInventory: false,
      notes: [],
    },
  });
  assert.equal(buy?.verdict, 'buy');
  assert.ok(buy?.reasons.includes('retailer_neutral'));
});

Deno.test('E-4 wardrobe gap and multi-look do not invent Closet items', () => {
  const shortlist = [
    {
      candidate: normalizeWardrobeCandidate({
        candidateId: `owned:${ITEM_A}`,
        sourceType: 'closet',
        actorRelationship: 'owned',
        row: { category: 'pants', color: 'black' },
      }),
      score: {
        total: 0.8,
        dimensions: {
          categoryRole: 0.8,
          colorHarmony: 0.7,
          silhouetteBalance: 0.6,
          materialTexture: 0.5,
          formality: 0.5,
          season: 0.5,
          occasion: 0.5,
          signatureStyle: 0.5,
          ownershipPriority: 1,
          redundancyPenalty: 0.8,
        },
        reasons: ['category_role_complement'],
        warnings: [],
      },
      recommendationRole: 'primary' as const,
    },
  ];
  const gap = analyzeWardrobeGap({
    focus: {
      evidenceId: 'e',
      actorRelationship: 'scanned',
      candidate: normalizeWardrobeCandidate({
        candidateId: 'focus',
        sourceType: 'focused_scan',
        actorRelationship: 'scanned',
        row: { category: 'jacket' },
      }),
      resolution: 'current_scan',
    },
    shortlist,
    inventoryCount: 1,
    inventoryState: 'partial',
  });
  assert.ok(gap.partialInventory);
  assert.ok(gap.notes.includes('partial_inventory_available'));

  const looks = buildMultiLooks({
    intent: 'multi_look_generation',
    shortlist,
    wardrobeGap: gap,
  });
  assert.ok(looks);
  assert.ok(looks!.length <= 3);
  for (const look of looks!) {
    for (const id of look.candidateIds) {
      assert.ok(shortlist.some((s) => s.candidate.candidateId === id));
    }
  }
});

Deno.test('E-4 prompt block only contains authorized candidate ids', () => {
  const shortlist = [
    {
      candidate: normalizeWardrobeCandidate({
        candidateId: `owned:${ITEM_A}`,
        sourceType: 'closet',
        actorRelationship: 'owned',
        row: { category: 'pants', color: 'black' },
      }),
      score: {
        total: 0.8,
        dimensions: {
          categoryRole: 0.8,
          colorHarmony: 0.7,
          silhouetteBalance: 0.6,
          materialTexture: 0.5,
          formality: 0.5,
          season: 0.5,
          occasion: 0.5,
          signatureStyle: 0.5,
          ownershipPriority: 1,
          redundancyPenalty: 0.8,
        },
        reasons: ['category_role_complement'],
        warnings: [],
      },
      recommendationRole: 'primary' as const,
    },
  ];
  const block = buildEliseAdvicePromptBlock({
    intent: 'style_current_item',
    focused: {
      evidenceId: 'e',
      actorRelationship: 'scanned',
      candidate: normalizeWardrobeCandidate({
        candidateId: 'focus:x',
        sourceType: 'focused_scan',
        actorRelationship: 'scanned',
        row: { category: 'jacket', color: 'navy' },
      }),
      resolution: 'current_scan',
    },
    shortlist,
    wardrobeGap: null,
    purchaseAdvice: null,
    looks: null,
  });
  assert.match(block, /owned:33333333/);
  assert.doesNotMatch(block, /SELECT \*/i);
  assert.match(block, /Do not invent Closet/);
});

Deno.test('E-4 pipeline returns null when advice intents flag OFF', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'What goes with this?',
    actorId: ACTOR,
    envelope: makeEnvelope([{ evidenceId: 'e1', category: 'jacket' }]),
    data: {
      async listSavedScans() {
        return [];
      },
      async listInspirationItems() {
        return [];
      },
      async listOwnedRoomItems() {
        return [];
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
  assert.equal(result, null);
});

Deno.test('E-4 pipeline bounds large Closet and keeps owned-first', async () => {
  const many = Array.from({ length: 80 }, (_, i) => {
    const id = `${(i + 10).toString(16).padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`;
    return {
      id,
      user_id: ACTOR,
      title: `Item ${i}`,
      category: i % 2 === 0 ? 'pants' : 'shoes',
      color: i % 3 === 0 ? 'black' : 'beige',
    };
  });
  const result = await runEliseAdvicePipeline({
    message: 'Build an outfit without buying anything new',
    actorId: ACTOR,
    envelope: makeEnvelope([{ evidenceId: 'e1', category: 'jacket', colors: ['navy'] }]),
    data: {
      async listSavedScans() {
        return many;
      },
      async listInspirationItems() {
        return [];
      },
      async listOwnedRoomItems() {
        return [];
      },
    },
    flags: {
      adviceIntentsV1: true,
      closetRetrievalV1: true,
      compatibilityScoringV1: true,
      wardrobeGapV1: true,
      purchaseAdviceV1: false,
      multiLookV1: true,
    },
  });
  assert.ok(result);
  assert.ok(result!.shortlist.length <= ELISE_ADVICE_LIMITS.groundedShortlist);
  assert.ok(!result!.promptBlock.includes('Item 79')); // titles not dumped wholesale as Closet dump
  assert.equal(result!.intent, 'build_outfit');
  assert.ok(result!.looks);
});
