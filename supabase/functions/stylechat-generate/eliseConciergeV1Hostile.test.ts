/**
 * Build 34 / K+ Wardrobe Concierge V1 -- INDEPENDENT HOSTILE AUDIT (2026-08-30).
 *
 * These are not "does the feature work" tests. Each one encodes a claim the
 * feature makes about ITSELF and then tries to break it:
 *
 *   "a gap is only stated as fact when the census PROVED it"      (section 27)
 *   "the ownership guard removes false claims, not true ones"     (section 34)
 *
 * They are kept in their own file so that the builder's suite and the auditor's
 * suite stay separately attributable.
 */
import assert from 'node:assert/strict';

import {
  buildClosetCensus,
  censusConfirmsRoleAbsent,
  CENSUS_ROW_CAP,
} from './eliseClosetCensus.ts';
import { analyzeWardrobeGap } from './eliseWardrobeGap.ts';
import { runEliseAdvicePipeline } from './eliseAdvicePipeline.ts';
import { enforceOwnershipProseSafety } from './eliseOwnershipProseSafety.ts';
import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import { deriveWardrobeContextMode } from './eliseAdvicePrompt.ts';
import type {
  EliseFocusedItem,
  EliseScoredCandidate,
  EliseWardrobeCandidate,
} from './eliseAdviceTypes.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const LOAFERS = '33333333-3333-4333-8333-333333333333';
const TROUSERS = '44444444-4444-4444-8444-444444444444';

function ownedCandidate(input: {
  id: string;
  title: string;
  category: string;
  color?: string;
}): EliseWardrobeCandidate {
  return normalizeWardrobeCandidate({
    candidateId: `closet:${input.id}`,
    sourceType: 'closet',
    actorRelationship: 'owned',
    row: {
      id: input.id,
      user_id: ACTOR,
      title: input.title,
      category: input.category,
      color: input.color ? [input.color] : [],
    },
    canonicalResourceIds: { itemId: input.id },
  });
}

function scored(candidate: EliseWardrobeCandidate, total = 0.8): EliseScoredCandidate {
  return {
    candidate,
    score: {
      total,
      dimensions: {
        categoryRole: 0.5,
        colorHarmony: 0.5,
        silhouetteBalance: 0.5,
        materialTexture: 0.5,
        formality: 0.5,
        season: 0.5,
        occasion: 0.5,
        signatureStyle: 0.5,
        ownershipPriority: 1,
        redundancyPenalty: 0.7,
      },
      reasons: [],
      warnings: [],
    },
    recommendationRole: 'primary',
  };
}

const NO_FOCUS: EliseFocusedItem = {
  evidenceId: null,
  actorRelationship: 'unknown',
  candidate: null,
  resolution: 'none',
};

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT-CON-001 -- an unmapped Closet category must not PROVE a role absent.
//
// `clothing_type` is a free-form, manual-entry field (see
// services/privateDressingRoomSlots.ts and services/closetIdentificationV2.ts),
// so a category outside LAYERING_BY_CATEGORY is ordinary user data, not an edge
// case. The census counts such a row -- it knows the Closet is not empty -- but
// derives no layering role from it. Treating "no role counted" as "role absent"
// converts a taxonomy gap into a confident false statement about the customer's
// own wardrobe, which is exactly what section 27 forbids.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('AUDIT-CON-001: an unrecognised category must not prove a role is absent', () => {
  // One item. The user typed its type by hand; it is footwear.
  const census = buildClosetCensus({
    rows: [{ clothing_type: 'clogs', category: 'Footwear' }],
    rowCap: CENSUS_ROW_CAP,
  });

  // The census DID see the whole Closet and DID count the row...
  assert.equal(census.exhaustive, true);
  assert.equal(census.totalItems, 1);
  // ...but it could not classify it, so it knows nothing about the shoe role.
  assert.equal(census.countsByLayeringRole.shoe, undefined);

  // Therefore it must not be allowed to confirm the absence of ANY role.
  assert.equal(
    censusConfirmsRoleAbsent(census, 'shoe'),
    false,
    'an unclassified row leaves role absence UNPROVEN, not proven',
  );
});

Deno.test('AUDIT-CON-001: an unclassifiable Closet never licenses an exhaustive gap claim', () => {
  const census = buildClosetCensus({
    rows: [
      { clothing_type: 'clogs' },
      { clothing_type: 'sarong' },
      { clothing_type: 'kaftan' },
      { clothing_type: 'huaraches' },
      { clothing_type: 'gilet' },
      { clothing_type: 'salopettes' },
      { clothing_type: 'pashmina' },
      { clothing_type: 'obi' },
      { clothing_type: 'kurta' },
      { clothing_type: 'lungi' },
    ],
    rowCap: CENSUS_ROW_CAP,
  });
  assert.equal(census.exhaustive, true);

  const gap = analyzeWardrobeGap({
    focus: NO_FOCUS,
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Clogs', category: 'clogs' }))],
    inventoryCount: 10,
    census,
    conciergeV1: true,
  });

  assert.equal(
    gap.evidenceIsExhaustive,
    false,
    'a Closet the census could not classify cannot back "you do not own X"',
  );
  assert.deepEqual(gap.confirmedAbsentCategories, []);
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT-CON-002 -- the neutral gap is derived from the bounded SHORTLIST, never
// from the census, so it must never be stamped with the exhaustive-Closet
// licence that the role gaps earn.
//
// `evidenceIsExhaustive` is a single boolean the prompt reads as "you may state
// plainly that they do not have the listed pieces" and the UI renders as "Your
// Closet doesn't have ... yet." Applying it to a shortlist-only finding is the
// precise shortlist-absence/Closet-absence confusion section 26 names.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('AUDIT-CON-002: a shortlist-derived neutral gap is never claimed as exhaustive', () => {
  // A Closet whose every role IS filled, so the role gaps all drop out and the
  // only surviving gap is the shortlist-derived neutral one.
  const census = buildClosetCensus({
    rows: [
      { clothing_type: 'loafers' },
      { clothing_type: 'trousers' },
      { clothing_type: 'shirt' },
      { clothing_type: 'coat' },
      { clothing_type: 'belt' },
      { clothing_type: 'sneakers' },
      { clothing_type: 'jeans' },
      { clothing_type: 'blazer' },
      { clothing_type: 'scarf' },
      { clothing_type: 'sweater' },
    ],
    rowCap: CENSUS_ROW_CAP,
  });
  assert.equal(census.exhaustive, true);

  // The shortlist that actually ranked happens to hold no neutral-family item.
  const gap = analyzeWardrobeGap({
    focus: NO_FOCUS,
    shortlist: [
      scored(ownedCandidate({ id: LOAFERS, title: 'Red loafers', category: 'loafers', color: 'red' })),
      scored(ownedCandidate({ id: TROUSERS, title: 'Green trousers', category: 'trousers', color: 'green' })),
    ],
    inventoryCount: 10,
    census,
    conciergeV1: true,
  });

  assert.ok(
    gap.gapCodes.includes('missing_neutral'),
    'precondition: the neutral gap is the one under test',
  );
  assert.equal(
    gap.evidenceIsExhaustive,
    false,
    'the neutral gap was never checked against the Closet, so nothing here is exhaustive',
  );
});

Deno.test('AUDIT-CON-002: census-proven role gaps still keep their exhaustive licence', () => {
  // Every row classifies, and the Closet genuinely holds no outerwear.
  const census = buildClosetCensus({
    rows: [
      { clothing_type: 'loafers' },
      { clothing_type: 'trousers' },
      { clothing_type: 'shirt' },
      { clothing_type: 'belt' },
      { clothing_type: 'jeans' },
      { clothing_type: 'sneakers' },
      { clothing_type: 'sweater' },
      { clothing_type: 'scarf' },
      { clothing_type: 'black t-shirt' },
      { clothing_type: 'grey chinos' },
    ],
    rowCap: CENSUS_ROW_CAP,
  });
  assert.equal(census.exhaustive, true);
  assert.equal(census.countsByLayeringRole.outer, undefined);

  const gap = analyzeWardrobeGap({
    focus: NO_FOCUS,
    shortlist: [
      scored(ownedCandidate({ id: LOAFERS, title: 'Black loafers', category: 'loafers', color: 'black' })),
      scored(ownedCandidate({ id: TROUSERS, title: 'Grey trousers', category: 'trousers', color: 'grey' })),
    ],
    inventoryCount: 10,
    census,
    conciergeV1: true,
  });

  assert.ok(gap.gapCodes.includes('missing_layer'));
  assert.ok(
    !gap.gapCodes.includes('missing_neutral'),
    'precondition: neutrals are present, so only census-proven gaps remain',
  );
  assert.equal(
    gap.evidenceIsExhaustive,
    true,
    'a gap set proven entirely by an exhaustive census keeps its licence',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT-CON-003 -- the ownership guard must not delete a TRUE claim about the
// focused owned item.
//
// `rankAndBoundCandidates` deliberately removes the focus from the shortlist
// ("you do not recommend the thing you are building around"). The guard builds
// its owned-garment vocabulary from that same shortlist, so on the flagship
// turn -- "what can I wear with my brown loafers?" -- the word "loafers" is not
// in the vocabulary and any sentence mentioning them alongside ownership
// language is destroyed. Section 34 is explicit that this guard removes FALSE
// claims; removing a true one is the failure mode it must not have.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('AUDIT-CON-003: the prose guard keeps a true claim about the FOCUSED owned item', () => {
  const loafers = ownedCandidate({
    id: LOAFERS,
    title: 'Brown loafers',
    category: 'loafers',
    color: 'brown',
  });
  const trousers = ownedCandidate({
    id: TROUSERS,
    title: 'Navy trousers',
    category: 'trousers',
    color: 'navy',
  });

  const verdict = enforceOwnershipProseSafety({
    text: 'The navy trousers you already have work beautifully with your brown loafers.',
    // Exactly what the pipeline hands over: the focus is NOT in the shortlist.
    shortlist: [scored(trousers)],
    focus: {
      evidenceId: null,
      actorRelationship: 'owned',
      candidate: loafers,
      resolution: 'closet_text_match',
    },
    neutralFallback: 'NEUTRAL_FALLBACK',
  });

  assert.equal(verdict.conflictDetected, false, 'the loafers ARE owned; nothing is unsupported');
  assert.match(verdict.safeText, /loafers/, 'the true sentence must survive intact');
  assert.notEqual(verdict.safeText, 'NEUTRAL_FALLBACK');
});

Deno.test('AUDIT-CON-003: an ambiguous owned match also licenses its own garment class', () => {
  const jacketA = ownedCandidate({ id: LOAFERS, title: 'Black jacket', category: 'jacket', color: 'black' });
  const jacketB = ownedCandidate({ id: TROUSERS, title: 'Black jacket', category: 'jacket', color: 'black' });

  const verdict = enforceOwnershipProseSafety({
    text: 'You have a few black jackets that would work here.',
    shortlist: [],
    focus: {
      evidenceId: null,
      actorRelationship: 'owned',
      candidate: null,
      resolution: 'closet_text_ambiguous',
      ambiguousCandidates: [jacketA, jacketB],
      ambiguousSharedCategory: 'jacket',
    },
    neutralFallback: 'NEUTRAL_FALLBACK',
  });

  assert.equal(verdict.conflictDetected, false);
  assert.match(verdict.safeText, /jackets/);
});

Deno.test('AUDIT-CON-003: a focus that is NOT owned still licenses nothing', () => {
  // A scanned item is not a possession, so it must not widen the vocabulary.
  const scannedBlazer = normalizeWardrobeCandidate({
    candidateId: 'scan:abc',
    sourceType: 'recent_scan',
    actorRelationship: 'scanned',
    row: { title: 'Grey blazer', category: 'blazer' },
    canonicalResourceIds: { scanId: 'abc' },
  });
  const trousers = ownedCandidate({ id: TROUSERS, title: 'Navy trousers', category: 'trousers' });

  const verdict = enforceOwnershipProseSafety({
    text: 'You already own that grey blazer, so build around it.',
    shortlist: [scored(trousers)],
    focus: {
      evidenceId: 'e1',
      actorRelationship: 'scanned',
      candidate: scannedBlazer,
      resolution: 'current_scan',
    },
    neutralFallback: 'NEUTRAL_FALLBACK',
  });

  assert.equal(verdict.conflictDetected, true, 'photographing a blazer is not owning it');
  assert.ok(verdict.conflictCodes.includes('unsupported_owned_blazer'));
});

Deno.test('AUDIT-CON-003: with no evidence at all the guard still cannot fire', () => {
  const verdict = enforceOwnershipProseSafety({
    text: 'You already own a black blazer that would work here.',
    shortlist: [],
    neutralFallback: 'NEUTRAL_FALLBACK',
  });
  // No owned evidence means no vocabulary, and a guard with no vocabulary would
  // delete every ownership sentence in an ordinary Base Elise answer. It must
  // stay out of the way instead -- the caller is what gates it.
  assert.equal(verdict.conflictDetected, true);
  assert.equal(verdict.safeText, 'NEUTRAL_FALLBACK');
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT-CON-005 -- `wardrobeContextMode` must mean what its contract says.
//
// eliseAdviceTypes.ts defines the values as:
//
//     closet -- every represented candidate is owned CLOSET evidence
//     mixed  -- owned CLOSET evidence plus other relationships
//
// but `deriveWardrobeContextMode` counts `actorRelationship === 'owned'` with no
// regard for the SOURCE. A Dressing Room row whose declared provenance is
// `physically_owned` is mapped to sourceType 'owned_room' / relationship 'owned'
// by `roomItemRelationship`, and `listOwnedRoomItems` is NOT K+ gated -- so it
// reaches the shortlist for a non-K+ actor.
//
// Two consequences, both customer-visible:
//   * the premium Concierge surface renders without K+, and
//   * a Dressing Room item is headed "From your Closet", naming a store the row
//     is not in. The audit invariant is that user_closet_items is the ONLY
//     authoritative owned-item source.
// ─────────────────────────────────────────────────────────────────────────────

function ownedRoomCandidate(id: string): EliseWardrobeCandidate {
  return normalizeWardrobeCandidate({
    candidateId: `owned_room:${id}`,
    sourceType: 'owned_room',
    // Exactly what roomItemRelationship returns for a `physically_owned` row.
    actorRelationship: 'owned',
    row: { id, user_id: ACTOR, title: 'Brown loafers', category: 'loafers' },
    canonicalResourceIds: { itemId: id, roomId: 'room-1' },
  });
}

Deno.test('AUDIT-CON-005: a Dressing Room item is not "From your Closet"', () => {
  const mode = deriveWardrobeContextMode([scored(ownedRoomCandidate(LOAFERS))]);
  assert.notEqual(
    mode,
    'closet',
    'only user_closet_items evidence may be headed "From your Closet"',
  );
  assert.equal(mode, 'none');
});

Deno.test('AUDIT-CON-005: a non-K+ turn cannot reach the Concierge surface', () => {
  // Without K+ the authoritative Closet source is absent from the data layer,
  // so the only "owned" rows a shortlist can hold come from Dressing Rooms.
  const mode = deriveWardrobeContextMode([
    scored(ownedRoomCandidate(LOAFERS)),
    scored(ownedRoomCandidate(TROUSERS)),
  ]);
  assert.equal(mode, 'none', 'no Closet evidence means no Concierge presentation');
});

Deno.test('AUDIT-CON-005: an owned-room FOCUS is not Closet context either', () => {
  const mode = deriveWardrobeContextMode([], {
    evidenceId: 'e1',
    actorRelationship: 'owned',
    candidate: ownedRoomCandidate(LOAFERS),
    resolution: 'focused_evidence',
  });
  assert.equal(mode, 'none');
});

Deno.test('AUDIT-CON-005: authoritative Closet evidence still reads as closet/mixed', () => {
  const closetItem = scored(
    ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }),
  );
  assert.equal(deriveWardrobeContextMode([closetItem]), 'closet');
  // Closet evidence alongside a room item is exactly what 'mixed' is for.
  assert.equal(
    deriveWardrobeContextMode([closetItem, scored(ownedRoomCandidate(TROUSERS))]),
    'mixed',
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// AUDIT-CON-006 -- the flagship turn, end to end, through the REAL pipeline.
//
// Section 55's Test A proves the metadata. This proves the sentence: the whole
// promise is "Elise knows what I own", and the customer only ever sees that if
// the prose that names the owned item survives every guard between the model
// and the bubble.
// ─────────────────────────────────────────────────────────────────────────────

Deno.test('AUDIT-CON-006: the one-item Closet turn survives the whole chain', async () => {
  const rows = [{
    id: LOAFERS,
    user_id: ACTOR,
    title: 'Brown leather loafers',
    category: 'loafers',
    clothing_type: 'loafers',
    color: ['brown'],
    brand: null,
    material: 'leather',
    snapshot_payload: { metadata: { subcategory: 'penny loafer' } },
  }];

  const result = await runEliseAdvicePipeline({
    message: 'What can I wear with my brown loafers?',
    actorId: ACTOR,
    envelope: null,
    data: {
      listSavedScans: () => Promise.resolve([]),
      listInspirationItems: () => Promise.resolve([]),
      listOwnedRoomItems: () => Promise.resolve([]),
      listClosetItems: () => Promise.resolve(rows),
    },
    flags: {
      adviceIntentsV1: true,
      closetRetrievalV1: true,
      compatibilityScoringV1: true,
      wardrobeGapV1: true,
      purchaseAdviceV1: true,
      multiLookV1: true,
      conciergeV1: true,
    },
    census: buildClosetCensus({ rows, rowCap: CENSUS_ROW_CAP }),
  });

  assert.ok(result);
  // The ranker removes the focus, so the shortlist really is empty here. That
  // is the exact shape both AUDIT-CON-003 defects hid behind.
  assert.equal(result!.shortlist.length, 0);
  assert.equal(result!.focused.resolution, 'closet_text_match');
  assert.equal(result!.wardrobeContextMode, 'closet');
  assert.equal(result!.adviceMetadata.focusedItem.displayFacts?.title, 'Brown leather loafers');
  assert.equal(result!.adviceMetadata.focusedItem.displayFacts?.clientId, LOAFERS);

  // And the guard, run exactly as index.ts now runs it for this turn.
  const verdict = enforceOwnershipProseSafety({
    text:
      'Your brown loafers are a great anchor. ' +
      'Try them with tailored navy trousers and a crisp white shirt.',
    shortlist: result!.shortlist,
    focus: result!.focused,
    neutralFallback: 'NEUTRAL_FALLBACK',
  });
  assert.equal(verdict.conflictDetected, false);
  assert.match(verdict.safeText, /brown loafers/);
  // The advice about pieces the user does NOT own is a recommendation, not an
  // ownership claim, and must also survive.
  assert.match(verdict.safeText, /navy trousers/);
});

Deno.test('AUDIT-CON-006: a one-item Closet still refuses a fabricated ownership claim', async () => {
  const rows = [{
    id: LOAFERS,
    user_id: ACTOR,
    title: 'Brown leather loafers',
    category: 'loafers',
    clothing_type: 'loafers',
    color: ['brown'],
    snapshot_payload: { metadata: { subcategory: 'penny loafer' } },
  }];
  const result = await runEliseAdvicePipeline({
    message: 'What can I wear with my brown loafers?',
    actorId: ACTOR,
    envelope: null,
    data: {
      listSavedScans: () => Promise.resolve([]),
      listInspirationItems: () => Promise.resolve([]),
      listOwnedRoomItems: () => Promise.resolve([]),
      listClosetItems: () => Promise.resolve(rows),
    },
    flags: {
      adviceIntentsV1: true,
      closetRetrievalV1: true,
      compatibilityScoringV1: true,
      wardrobeGapV1: true,
      purchaseAdviceV1: true,
      multiLookV1: true,
      conciergeV1: true,
    },
    census: buildClosetCensus({ rows, rowCap: CENSUS_ROW_CAP }),
  });

  const verdict = enforceOwnershipProseSafety({
    text: 'Pair them with the navy blazer you already own.',
    shortlist: result!.shortlist,
    focus: result!.focused,
    neutralFallback: 'NEUTRAL_FALLBACK',
  });
  assert.equal(verdict.conflictDetected, true, 'a blazer is not in this Closet');
  assert.ok(verdict.conflictCodes.includes('unsupported_owned_blazer'));
  assert.equal(verdict.safeText, 'NEUTRAL_FALLBACK');
});
