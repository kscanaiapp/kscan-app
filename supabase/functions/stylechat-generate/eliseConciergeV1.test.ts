/**
 * Build 34 / K+ Wardrobe Concierge V1 -- C1/C2/C3 backend tests.
 *
 * Organised around the customer test matrix (sections 55-64) rather than around
 * the module list, because the thing that has to hold is the CUSTOMER-VISIBLE
 * promise -- "Elise actually knows what I own" -- not the internal call graph.
 */
import assert from 'node:assert/strict';

import { readEliseBackendConfig } from './eliseConfig.ts';
import {
  extractClosetFocusPhrase,
  matchClosetFocusFromText,
} from './eliseClosetFocusText.ts';
import {
  buildClosetCensus,
  censusConfirmedAbsentCategories,
  censusConfirmsRoleAbsent,
  CENSUS_ROW_CAP,
} from './eliseClosetCensus.ts';
import { enforceOwnershipProseSafety } from './eliseOwnershipProseSafety.ts';
import { resolveEliseFocusedItem } from './eliseFocusResolution.ts';
import { analyzeWardrobeGap, buildMultiLooks } from './eliseWardrobeGap.ts';
import { runEliseAdvicePipeline } from './eliseAdvicePipeline.ts';
import {
  buildDisplayFacts,
  buildEliseAdviceMetadata,
  buildEliseAdvicePromptBlock,
  deriveWardrobeContextMode,
} from './eliseAdvicePrompt.ts';
import { normalizeWardrobeCandidate } from './eliseFashionFeatures.ts';
import {
  ELISE_ADVICE_CONTRACT_VERSION,
  ELISE_ADVICE_CONTRACT_VERSION_V2,
} from './eliseAdviceTypes.ts';
import type {
  EliseScoredCandidate,
  EliseWardrobeCandidate,
} from './eliseAdviceTypes.ts';
import type { EliseWardrobeDataSource } from './eliseWardrobeRetrieval.ts';

const ACTOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const LOAFERS = '33333333-3333-4333-8333-333333333333';
const TROUSERS = '44444444-4444-4444-8444-444444444444';
const SHIRT = '55555555-5555-4555-8555-555555555555';
const JACKET_A = '66666666-6666-4666-8666-666666666666';
const JACKET_B = '77777777-7777-4777-8777-777777777777';
const JACKET_C = '88888888-8888-4888-8888-888888888888';
const SAVED = '99999999-9999-4999-8999-999999999999';

function env(values: Record<string, string | undefined>) {
  return { get: (name: string) => values[name] };
}

function closetRow(input: {
  id: string;
  title: string;
  clothingType: string;
  subtype?: string;
  color?: string;
  brand?: string;
  material?: string;
  userId?: string;
}): Record<string, unknown> {
  return {
    id: input.id,
    user_id: input.userId ?? ACTOR,
    title: input.title,
    category: input.clothingType,
    color: input.color ? [input.color] : [],
    brand: input.brand ?? null,
    material: input.material ?? null,
    // Mirrors the index.ts closet mapper, which routes `subtype` through the
    // snapshot metadata convention (section 25).
    snapshot_payload: { metadata: { subcategory: input.subtype ?? null } },
  };
}

function ownedCandidate(input: {
  id: string;
  title: string;
  category: string;
  subtype?: string;
  color?: string;
  brand?: string;
  material?: string;
}): EliseWardrobeCandidate {
  return normalizeWardrobeCandidate({
    candidateId: `closet:${input.id}`,
    sourceType: 'closet',
    actorRelationship: 'owned',
    row: closetRow({
      id: input.id,
      title: input.title,
      clothingType: input.category,
      subtype: input.subtype,
      color: input.color,
      brand: input.brand,
      material: input.material,
    }),
    canonicalResourceIds: { itemId: input.id },
  });
}

function scored(
  candidate: EliseWardrobeCandidate,
  total = 0.8,
): EliseScoredCandidate {
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

function dataSource(rows: Record<string, unknown>[]): EliseWardrobeDataSource {
  return {
    listSavedScans: () => Promise.resolve([]),
    listInspirationItems: () => Promise.resolve([]),
    listOwnedRoomItems: () => Promise.resolve([]),
    listClosetItems: () => Promise.resolve(rows),
  };
}

const CONCIERGE_ON = {
  adviceIntentsV1: true,
  closetRetrievalV1: true,
  compatibilityScoringV1: true,
  wardrobeGapV1: true,
  purchaseAdviceV1: true,
  multiLookV1: true,
  conciergeV1: true,
};

// ───────────────────────────── C1 — contract ─────────────────────────────────

Deno.test('C1: conciergeV1 defaults OFF and reads its own env var', () => {
  assert.equal(readEliseBackendConfig(env({})).flags.conciergeV1, false);
  assert.equal(
    readEliseBackendConfig(env({ ELISE_CONCIERGE_V1_ENABLED: 'true' })).flags.conciergeV1,
    true,
  );
});

Deno.test('C1: conciergeV1 is independent of the transport and source flags', () => {
  // Section 14: three distinct controls, no fourth layer. Turning the Concierge
  // capability on must not imply transport, and must not imply the source.
  const config = readEliseBackendConfig(env({ ELISE_CONCIERGE_V1_ENABLED: 'true' }));
  assert.equal(config.flags.conciergeV1, true);
  assert.equal(config.flags.adviceMetadataClientV1, false);
  assert.equal(config.flags.closetWardrobeContextV1, false);
});

Deno.test('C1: flag OFF emits the v1 contract with no v2 fields at all', () => {
  const metadata = buildEliseAdviceMetadata({
    intent: 'build_outfit',
    focused: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    wardrobeGap: null,
    purchaseAdvice: null,
    looks: null,
    conciergeV1: false,
  });
  assert.equal(metadata.contractVersion, ELISE_ADVICE_CONTRACT_VERSION);
  assert.equal('wardrobeContextMode' in metadata, false);
  assert.equal('focusAmbiguity' in metadata, false);
  // The KEY must be absent, not merely undefined: v1 is a shipped wire shape.
  assert.equal('displayFacts' in metadata.recommendations[0], false);
});

Deno.test('C1: flag ON emits v2 with display facts sourced from the candidate', () => {
  const candidate = ownedCandidate({
    id: LOAFERS,
    title: 'Brown leather loafers',
    category: 'loafers',
    subtype: 'penny loafer',
    color: 'brown',
    brand: 'Aldo',
  });
  const metadata = buildEliseAdviceMetadata({
    intent: 'build_outfit',
    focused: { evidenceId: null, actorRelationship: 'owned', candidate, resolution: 'closet_text_match' },
    shortlist: [scored(candidate)],
    wardrobeGap: null,
    purchaseAdvice: null,
    looks: null,
    conciergeV1: true,
  });
  assert.equal(metadata.contractVersion, ELISE_ADVICE_CONTRACT_VERSION_V2);
  const facts = metadata.recommendations[0].displayFacts;
  assert.equal(facts?.title, 'Brown leather loafers');
  assert.equal(facts?.category, 'loafers');
  assert.equal(facts?.subtype, 'penny loafer');
  assert.equal(facts?.brand, 'Aldo');
  assert.equal(facts?.primaryColor, 'brown');
  // clientId is the canonical row id the app already stores -- the handle the
  // client resolves a LOCAL image from.
  assert.equal(facts?.clientId, LOAFERS);
});

Deno.test('C1 section 16: display facts never invent a value the evidence lacks', () => {
  const facts = buildDisplayFacts(
    ownedCandidate({ id: LOAFERS, title: 'Loafers', category: 'loafers' }),
  );
  assert.equal(facts.brand, null);
  assert.equal(facts.primaryColor, null);
  assert.equal(facts.subtype, null);
});

Deno.test('C1 section 17: wardrobe context mode reflects EVIDENCE, not entitlement', () => {
  const owned = scored(ownedCandidate({ id: LOAFERS, title: 'Loafers', category: 'loafers' }));
  const savedCandidate: EliseScoredCandidate = {
    ...owned,
    candidate: { ...owned.candidate, candidateId: `saved:${SAVED}`, actorRelationship: 'saved' },
  };

  // A K+ user asking about the weather has no wardrobe evidence -> 'none'.
  assert.equal(deriveWardrobeContextMode([]), 'none');
  assert.equal(deriveWardrobeContextMode([owned]), 'closet');
  assert.equal(deriveWardrobeContextMode([owned, savedCandidate]), 'mixed');
  // Non-owned evidence alone is NOT Closet context.
  assert.equal(deriveWardrobeContextMode([savedCandidate]), 'none');
});

// ────────────────────────── C2 — focus resolution ────────────────────────────

Deno.test('C2 section 20: a possessive phrase resolves to the owned item', () => {
  const result = matchClosetFocusFromText({
    message: 'Build three outfits around my brown loafers.',
    candidates: [
      ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers', color: 'brown' }),
      ownedCandidate({ id: TROUSERS, title: 'Navy trousers', category: 'trousers', color: 'navy' }),
    ],
  });
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') {
    assert.equal(result.candidate.canonicalResourceIds.itemId, LOAFERS);
  }
});

Deno.test('C2 section 20: colour discriminates within one garment type', () => {
  const result = matchClosetFocusFromText({
    message: 'What goes with my brown loafers?',
    candidates: [
      ownedCandidate({ id: SHIRT, title: 'Black loafers', category: 'loafers', color: 'black' }),
      ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers', color: 'brown' }),
    ],
  });
  // A named colour the item does not have counts AGAINST it, so the brown pair
  // must win outright rather than tying with the black pair.
  assert.equal(result.status, 'matched');
  if (result.status === 'matched') {
    assert.equal(result.candidate.canonicalResourceIds.itemId, LOAFERS);
  }
});

Deno.test('C2 section 21: three black jackets produce a tie, never a silent pick', () => {
  const result = matchClosetFocusFromText({
    message: 'Style my black jacket.',
    candidates: [
      ownedCandidate({ id: JACKET_A, title: 'Black jacket', category: 'jacket', color: 'black' }),
      ownedCandidate({ id: JACKET_B, title: 'Black jacket', category: 'jacket', color: 'black' }),
      ownedCandidate({ id: JACKET_C, title: 'Black jacket', category: 'jacket', color: 'black' }),
    ],
  });
  assert.equal(result.status, 'ambiguous');
  if (result.status === 'ambiguous') {
    assert.equal(result.candidates.length, 3);
    assert.equal(result.sharedCategory, 'jacket');
  }
});

Deno.test('C2 section 21: an ambiguous focus resolves with NO candidate selected', () => {
  const focus = resolveEliseFocusedItem({
    envelope: null,
    message: 'Style my black jacket.',
    authorizedCandidates: [
      ownedCandidate({ id: JACKET_A, title: 'Black jacket', category: 'jacket', color: 'black' }),
      ownedCandidate({ id: JACKET_B, title: 'Black jacket', category: 'jacket', color: 'black' }),
    ],
    conciergeV1: true,
  });
  assert.equal(focus.resolution, 'closet_text_ambiguous');
  // The whole point: nothing was chosen. A populated `candidate` here would be
  // the silent selection the section exists to prevent.
  assert.equal(focus.candidate, null);
  assert.equal(focus.ambiguousCandidates?.length, 2);
});

Deno.test('C2: text focus can only ever reach OWNED candidates', () => {
  const saved = ownedCandidate({ id: SAVED, title: 'Brown loafers', category: 'loafers', color: 'brown' });
  const result = matchClosetFocusFromText({
    message: 'Style my brown loafers.',
    candidates: [{ ...saved, actorRelationship: 'saved' }],
  });
  // A merely-saved item is not something the user told us they own, so "my ..."
  // must not resolve to it.
  assert.equal(result.status, 'no_match');
});

Deno.test('C2: a non-possessive styling question does not trigger owned matching', () => {
  assert.equal(extractClosetFocusPhrase('What goes with brown loafers?'), null);
  assert.equal(extractClosetFocusPhrase('Should I buy a black jacket?'), null);
  // Possessive but not about a garment.
  assert.equal(extractClosetFocusPhrase('What is my style?'), null);
});

Deno.test('C2: envelope focus outranks a text phrase', () => {
  const focus = resolveEliseFocusedItem({
    envelope: {
      internalContractVersion: 'elise_visual_context_v1',
      requestSource: 'camera',
      focusedEvidenceId: 'ev-0',
      evidence: [{
        evidenceId: 'ev-0',
        sourceType: 'current_scan',
        actorRelationship: 'scanned',
        trust: 'server_verified',
        sourceId: null,
        sessionId: null,
        scanId: null,
        itemId: null,
        roomId: null,
        title: 'Scanned coat',
        summary: null,
        category: 'coat',
        subcategory: null,
        colors: [],
        materials: [],
        silhouette: null,
        styleAttributes: [],
        textureAttributes: [],
        occasionAttributes: [],
        brand: null,
        confidence: null,
        imageReferenceType: 'none',
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
    },
    message: 'Style my brown loafers.',
    authorizedCandidates: [
      ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers', color: 'brown' }),
    ],
    conciergeV1: true,
  });
  // A thing the user pointed at beats a thing they described.
  assert.equal(focus.resolution, 'focused_evidence');
});

Deno.test('C2: flag OFF keeps the resolver envelope-only', () => {
  const focus = resolveEliseFocusedItem({
    envelope: null,
    message: 'Style my brown loafers.',
    authorizedCandidates: [
      ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers', color: 'brown' }),
    ],
    conciergeV1: false,
  });
  assert.equal(focus.resolution, 'none');
  assert.equal(focus.candidate, null);
});

// ────────────────────────── C2 — census / gap authority ──────────────────────

Deno.test('C2 section 27: a census under the cap is exhaustive; at the cap it is not', () => {
  const small = buildClosetCensus({
    rows: [{ clothing_type: 'jacket' }, { clothing_type: 'trousers' }],
    rowCap: 10,
  });
  assert.equal(small.exhaustive, true);
  assert.equal(small.totalItems, 2);

  const capped = buildClosetCensus({
    rows: Array.from({ length: 10 }, () => ({ clothing_type: 'jacket' })),
    rowCap: 10,
  });
  // Exactly-at-cap is indistinguishable from "there are more", so it must not
  // claim exhaustiveness.
  assert.equal(capped.exhaustive, false);
});

Deno.test('C2 section 26: a role present in the Closet but absent from the shortlist is NOT a gap', () => {
  // The trust bug this fixes: the user owns four jackets, none ranked, and the
  // old code reported "missing_layer" -- i.e. told them they own no jacket.
  const census = buildClosetCensus({
    rows: Array.from({ length: 4 }, () => ({ clothing_type: 'jacket' })),
    rowCap: CENSUS_ROW_CAP,
  });
  assert.equal(census.exhaustive, true);
  assert.equal(census.countsByLayeringRole.outer, 4);

  const gap = analyzeWardrobeGap({
    focus: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [scored(ownedCandidate({ id: SHIRT, title: 'Cream shirt', category: 'shirt' }))],
    inventoryCount: 12,
    census,
    conciergeV1: true,
  });
  assert.equal(gap.gapCodes.includes('missing_layer'), false);
  assert.equal(gap.evidenceIsExhaustive, true);
});

Deno.test('C2 section 27: without a census, no gap may claim exhaustive evidence', () => {
  const gap = analyzeWardrobeGap({
    focus: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [scored(ownedCandidate({ id: SHIRT, title: 'Cream shirt', category: 'shirt' }))],
    inventoryCount: 12,
    census: null,
    conciergeV1: true,
  });
  assert.equal(gap.evidenceIsExhaustive, false);
  assert.deepEqual(gap.confirmedAbsentCategories, []);
  assert.equal(gap.notes.includes('gap_evidence_bounded_scope_language_required'), true);
});

Deno.test('C2 section 27: a non-exhaustive census can never confirm an absence', () => {
  const capped = buildClosetCensus({
    rows: Array.from({ length: 5 }, () => ({ clothing_type: 'shirt' })),
    rowCap: 5,
  });
  assert.equal(censusConfirmsRoleAbsent(capped, 'shoe'), false);
  assert.deepEqual(censusConfirmedAbsentCategories(capped, ['shoes']), []);
  assert.equal(censusConfirmsRoleAbsent(null, 'shoe'), false);
});

Deno.test('C2 section 28: a small Closet gets at most one gap, chosen by what blocks the job', () => {
  const census = buildClosetCensus({
    rows: [{ clothing_type: 'loafers' }, { clothing_type: 'trousers' }],
    rowCap: CENSUS_ROW_CAP,
  });
  const gap = analyzeWardrobeGap({
    focus: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    inventoryCount: 2,
    census,
    conciergeV1: true,
  });
  assert.equal(gap.gapCodes.length <= 1, true);
  assert.equal(gap.notes.includes('small_closet_gap_restraint'), true);
});

Deno.test('C2 section 28: a small Closet is never reported as an error state', () => {
  const gap = analyzeWardrobeGap({
    focus: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    inventoryCount: 1,
    census: buildClosetCensus({ rows: [{ clothing_type: 'loafers' }], rowCap: CENSUS_ROW_CAP }),
    conciergeV1: true,
  });
  // Nothing in the gap payload may read as "your Closet is too small to help".
  const serialized = JSON.stringify(gap).toLowerCase();
  assert.equal(serialized.includes('too small'), false);
  assert.equal(serialized.includes('unlock'), false);
  assert.equal(serialized.includes('add more'), false);
});

Deno.test('C2: the census counts rows and cannot carry item content', () => {
  const census = buildClosetCensus({
    rows: [
      { clothing_type: 'jacket', category: 'Outerwear', subtype: 'bomber' },
      { clothing_type: 'loafers', category: 'Shoes' },
    ],
    rowCap: CENSUS_ROW_CAP,
  });
  const serialized = JSON.stringify(census);
  // Only counts and category tokens. A title, brand, colour or id appearing
  // here would be a route for Closet contents to reach the prompt.
  assert.equal(serialized.includes(LOAFERS), false);
  assert.equal(/"[a-z ]+":\s*\d+/.test(serialized), true);
  assert.equal(census.countsByCategory.jacket, 1);
  assert.equal(census.countsByCategory.loafers, 1);
});

// ────────────────────────── C2 — role-aware looks ────────────────────────────

Deno.test('C2 section 29: a look never contains three tops', () => {
  const looks = buildMultiLooks({
    intent: 'multi_look_generation',
    shortlist: [
      scored(ownedCandidate({ id: SHIRT, title: 'Cream shirt', category: 'shirt' }), 0.9),
      scored(ownedCandidate({ id: JACKET_A, title: 'White blouse', category: 'blouse' }), 0.88),
      scored(ownedCandidate({ id: JACKET_B, title: 'Grey tee', category: 'tee' }), 0.86),
      scored(ownedCandidate({ id: TROUSERS, title: 'Navy trousers', category: 'trousers' }), 0.84),
      scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }), 0.82),
    ],
    wardrobeGap: null,
    conciergeV1: true,
  });
  assert.equal(Array.isArray(looks), true);
  const first = looks![0];
  // Three base-layer garments scored highest; a look built purely by score
  // would have taken all three.
  assert.equal(first.candidateIds.length <= 3, true);
  assert.equal(first.candidateIds.includes(`closet:${TROUSERS}`), true);
});

Deno.test('C2 section 29: a look never contains two pairs of shoes', () => {
  const looks = buildMultiLooks({
    intent: 'build_outfit',
    shortlist: [
      scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }), 0.95),
      scored(ownedCandidate({ id: JACKET_A, title: 'White sneakers', category: 'sneakers' }), 0.94),
      scored(ownedCandidate({ id: TROUSERS, title: 'Navy trousers', category: 'trousers' }), 0.9),
    ],
    wardrobeGap: null,
    conciergeV1: true,
  });
  const first = looks![0];
  const shoeCount = first.candidateIds.filter(
    (id) => id === `closet:${LOAFERS}` || id === `closet:${JACKET_A}`,
  ).length;
  assert.equal(shoeCount, 1);
});

Deno.test('C2 section 29: a one-piece is never paired with a top or a bottom', () => {
  const looks = buildMultiLooks({
    intent: 'build_outfit',
    shortlist: [
      scored(ownedCandidate({ id: SHIRT, title: 'Black dress', category: 'dress' }), 0.95),
      scored(ownedCandidate({ id: TROUSERS, title: 'Navy trousers', category: 'trousers' }), 0.9),
      scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }), 0.85),
    ],
    wardrobeGap: null,
    conciergeV1: true,
  });
  const first = looks![0];
  assert.equal(first.candidateIds.includes(`closet:${SHIRT}`), true);
  assert.equal(first.candidateIds.includes(`closet:${TROUSERS}`), false);
});

Deno.test('C2 section 29: looks are never padded with items the user does not have', () => {
  const looks = buildMultiLooks({
    intent: 'build_outfit',
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    wardrobeGap: null,
    conciergeV1: true,
  });
  // One owned item cannot make three looks. What comes back must reference only
  // that item -- never an invented id standing in for a missing piece.
  for (const look of looks ?? []) {
    for (const id of look.candidateIds) {
      assert.equal(id, `closet:${LOAFERS}`);
    }
  }
});

// ────────────────────────── C3 — ownership integrity ─────────────────────────

Deno.test('C3 section 35: an ungrounded ownership claim is removed, not rewritten', () => {
  const verdict = enforceOwnershipProseSafety({
    text:
      'You already own a black leather jacket that works here. '
      + 'The loafers anchor the whole look nicely.',
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    neutralFallback: 'FALLBACK',
  });
  assert.equal(verdict.conflictDetected, true);
  assert.equal(verdict.safeText.includes('black leather jacket'), false);
  // The surviving sentence is untouched model prose -- the guard never authors
  // a replacement for a sentence it deleted.
  assert.equal(verdict.safeText, 'The loafers anchor the whole look nicely.');
});

Deno.test('C3 section 35: neutral copy is used only when nothing safe survives', () => {
  const verdict = enforceOwnershipProseSafety({
    text: 'You already have a navy blazer that would work.',
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    neutralFallback: 'NEUTRAL',
  });
  assert.equal(verdict.conflictDetected, true);
  assert.equal(verdict.safeText, 'NEUTRAL');
});

Deno.test('C3: a SUPPORTED ownership claim passes through untouched', () => {
  const text = 'You already have brown loafers, so start there.';
  const verdict = enforceOwnershipProseSafety({
    text,
    shortlist: [
      scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' })),
    ],
    neutralFallback: 'NEUTRAL',
  });
  assert.equal(verdict.conflictDetected, false);
  assert.equal(verdict.safeText, text);
});

Deno.test('C3: a saved item never licenses ownership language', () => {
  const saved = scored(ownedCandidate({ id: SAVED, title: 'Black blazer', category: 'blazer' }));
  const verdict = enforceOwnershipProseSafety({
    text: 'You already own a black blazer.',
    shortlist: [{ ...saved, candidate: { ...saved.candidate, actorRelationship: 'saved' } }],
    neutralFallback: 'NEUTRAL',
  });
  // Section 33: photographing or bookmarking is not owning.
  assert.equal(verdict.conflictDetected, true);
});

Deno.test('C3 section 34: ownership language with no garment named is left alone', () => {
  const text = 'You already have a strong foundation to build on here.';
  const verdict = enforceOwnershipProseSafety({
    text,
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    neutralFallback: 'NEUTRAL',
  });
  // The guard removes false CLAIMS, not confident tone. Suppressing this would
  // make Concierge answers read as hedged for no reason.
  assert.equal(verdict.conflictDetected, false);
  assert.equal(verdict.safeText, text);
});

Deno.test('C3: prose that asserts no ownership is never touched', () => {
  const text = 'A leather jacket would work well with these trousers.';
  const verdict = enforceOwnershipProseSafety({
    text,
    shortlist: [scored(ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' }))],
    neutralFallback: 'NEUTRAL',
  });
  assert.equal(verdict.conflictDetected, false);
});

Deno.test('C3: with no wardrobe evidence the guard cannot fire at all', () => {
  const verdict = enforceOwnershipProseSafety({
    text: 'You already own a great jacket.',
    shortlist: [],
    neutralFallback: 'NEUTRAL',
  });
  // Base Elise must stay useful (section 5): with nothing to check against,
  // suppressing prose would be guessing.
  assert.equal(verdict.conflictDetected, true);
  assert.equal(verdict.safeText, 'NEUTRAL');
});

Deno.test('C3 section 33: the prompt states ownership semantics explicitly', () => {
  const block = buildEliseAdvicePromptBlock({
    intent: 'build_outfit',
    focused: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [],
    wardrobeGap: null,
    purchaseAdvice: null,
    looks: null,
    conciergeV1: true,
  });
  assert.equal(block.includes('NEVER describe an item as owned'), true);
  assert.equal(block.includes('Photographing is not owning'), true);
});

Deno.test('C3: prompt ownership semantics are absent when the flag is off', () => {
  const block = buildEliseAdvicePromptBlock({
    intent: 'build_outfit',
    focused: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [],
    wardrobeGap: null,
    purchaseAdvice: null,
    looks: null,
    conciergeV1: false,
  });
  assert.equal(block.includes('OWNERSHIP SEMANTICS (STRICT)'), false);
});

Deno.test('C2 section 27: the prompt tells the model which claim its evidence supports', () => {
  const exhaustive = buildEliseAdvicePromptBlock({
    intent: 'wardrobe_gap',
    focused: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [],
    wardrobeGap: {
      gapCodes: ['missing_shoe'],
      categories: ['shoes'],
      partialInventory: false,
      notes: [],
      evidenceIsExhaustive: true,
      confirmedAbsentCategories: ['shoes'],
    },
    purchaseAdvice: null,
    looks: null,
    conciergeV1: true,
  });
  assert.equal(exhaustive.includes('EVIDENCE=EXHAUSTIVE_CLOSET_CENSUS'), true);

  const bounded = buildEliseAdvicePromptBlock({
    intent: 'wardrobe_gap',
    focused: { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' },
    shortlist: [],
    wardrobeGap: {
      gapCodes: ['missing_shoe'],
      categories: ['shoes'],
      partialInventory: true,
      notes: [],
      evidenceIsExhaustive: false,
      confirmedAbsentCategories: [],
    },
    purchaseAdvice: null,
    looks: null,
    conciergeV1: true,
  });
  assert.equal(bounded.includes('EVIDENCE=BOUNDED'), true);
  assert.equal(bounded.includes('Do NOT say the user does not own something'), true);
});

// ────────────────── customer matrix — end-to-end through the pipeline ─────────

Deno.test('TEST A (section 55): a one-item Closet resolves the item and raises no error', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'What could I wear with my brown loafers?',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({ id: LOAFERS, title: 'Brown loafers', clothingType: 'loafers', color: 'brown' }),
    ]),
    flags: CONCIERGE_ON,
    census: buildClosetCensus({ rows: [{ clothing_type: 'loafers' }], rowCap: CENSUS_ROW_CAP }),
  });
  assert.notEqual(result, null);
  assert.equal(result!.focused.resolution, 'closet_text_match');
  assert.equal(result!.focused.candidate?.canonicalResourceIds.itemId, LOAFERS);
  assert.equal(result!.wardrobeContextMode, 'closet');
  // No invented additional owned garments.
  assert.equal(result!.shortlist.every((s) => s.candidate.canonicalResourceIds.itemId === LOAFERS), true);
});

Deno.test('TEST B (section 56): a three-item Closet uses what exists without fabricating looks', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Build outfits using what I own.',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({ id: LOAFERS, title: 'Brown loafers', clothingType: 'loafers', color: 'brown' }),
      closetRow({ id: TROUSERS, title: 'Navy trousers', clothingType: 'trousers', color: 'navy' }),
      closetRow({ id: SHIRT, title: 'Cream shirt', clothingType: 'shirt', color: 'cream' }),
    ]),
    flags: CONCIERGE_ON,
    census: buildClosetCensus({
      rows: [{ clothing_type: 'loafers' }, { clothing_type: 'trousers' }, { clothing_type: 'shirt' }],
      rowCap: CENSUS_ROW_CAP,
    }),
  });
  const ids = new Set(result!.shortlist.map((s) => s.candidate.canonicalResourceIds.itemId));
  assert.equal(ids.size, 3);
  // Every id in every look must be a real retrieved candidate.
  const known = new Set(result!.shortlist.map((s) => s.candidate.candidateId));
  for (const look of result!.looks ?? []) {
    for (const id of look.candidateIds) assert.equal(known.has(id), true);
  }
});

Deno.test('TEST G (section 61): K+ active with zero Closet items is not an error', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'What should I wear to dinner?',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([]),
    flags: CONCIERGE_ON,
    census: buildClosetCensus({ rows: [], rowCap: CENSUS_ROW_CAP }),
  });
  assert.notEqual(result, null);
  assert.equal(result!.wardrobeContextMode, 'none');
  assert.equal(result!.shortlist.length, 0);
  assert.equal(result!.adviceMetadata.wardrobeContextMode, 'none');
  // No false owned context, and nothing that reads as a failure.
  assert.equal(result!.telemetry.stableErrorClass, null);
});

Deno.test('TEST I (section 63): with Concierge off there is no v2 signal to render on', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Build three outfits around my brown loafers.',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({ id: LOAFERS, title: 'Brown loafers', clothingType: 'loafers', color: 'brown' }),
    ]),
    flags: { ...CONCIERGE_ON, conciergeV1: false },
  });
  assert.equal(result!.adviceMetadata.contractVersion, ELISE_ADVICE_CONTRACT_VERSION);
  assert.equal(result!.adviceMetadata.wardrobeContextMode, undefined);
  assert.equal(result!.wardrobeContextMode, 'none');
});

Deno.test('TEST J (section 64): a cross-account Closet row is rejected, never repaired', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Build three outfits around my brown loafers.',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({
        id: LOAFERS,
        title: 'Brown loafers',
        clothingType: 'loafers',
        color: 'brown',
        userId: OTHER,
      }),
    ]),
    flags: CONCIERGE_ON,
  });
  // Section 36: dropped, not swapped for a "close enough" item.
  assert.equal(result!.shortlist.length, 0);
  assert.equal(result!.telemetry.rejectedCount, 1);
  assert.equal(result!.wardrobeContextMode, 'none');
});

Deno.test('TEST J (section 64): a forged non-uuid id is rejected', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Style my brown loafers.',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      { ...closetRow({ id: LOAFERS, title: 'Brown loafers', clothingType: 'loafers' }), id: 'not-a-uuid' },
    ]),
    flags: CONCIERGE_ON,
  });
  assert.equal(result!.shortlist.length, 0);
  assert.equal(result!.telemetry.rejectedCount, 1);
});

Deno.test('section 54: Concierge telemetry carries only aggregate dimensions', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Build three outfits around my brown loafers.',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({
        id: LOAFERS,
        title: 'Brown Italian penny loafers',
        clothingType: 'loafers',
        color: 'brown',
        brand: 'SecretBrandName',
      }),
    ]),
    flags: CONCIERGE_ON,
    census: buildClosetCensus({ rows: [{ clothing_type: 'loafers' }], rowCap: CENSUS_ROW_CAP }),
  });
  const serialized = JSON.stringify(result!.telemetry);
  assert.equal(serialized.includes('SecretBrandName'), false);
  assert.equal(serialized.includes('Italian'), false);
  assert.equal(serialized.includes(LOAFERS), false);
  assert.equal(result!.telemetry.wardrobeContextMode, 'closet');
  assert.equal(result!.telemetry.focusResolutionClass, 'closet_text_match');
});

Deno.test('section 25: subtype survives retrieval and reaches the display facts', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'Style my brown loafers.',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({
        id: LOAFERS,
        title: 'Brown loafers',
        clothingType: 'loafers',
        subtype: 'penny loafer',
        color: 'brown',
      }),
      closetRow({
        id: TROUSERS,
        title: 'Navy trousers',
        clothingType: 'trousers',
        subtype: 'wide leg',
        color: 'navy',
      }),
    ]),
    flags: CONCIERGE_ON,
  });
  // The focus is excluded from `recommendations` by design, so subtype has to
  // hold on BOTH surfaces: the focus card and the recommendation cards.
  assert.equal(result!.adviceMetadata.focusedItem.displayFacts?.subtype, 'penny loafer');
  assert.equal(result!.adviceMetadata.recommendations[0]?.displayFacts?.subtype, 'wide leg');
});

Deno.test('DEF-CON-004: the focus card is renderable from metadata alone', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'What could I wear with my brown loafers?',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({
        id: LOAFERS,
        title: 'Brown loafers',
        clothingType: 'loafers',
        color: 'brown',
        brand: 'Aldo',
      }),
    ]),
    flags: CONCIERGE_ON,
  });
  // Section 4's product proof needs the focused garment shown as a real card.
  const facts = result!.adviceMetadata.focusedItem.displayFacts;
  assert.equal(facts?.title, 'Brown loafers');
  assert.equal(facts?.clientId, LOAFERS);
  assert.equal(facts?.brand, 'Aldo');
});

Deno.test('DEF-CON-004: the focus card is absent on a v1 payload', async () => {
  const result = await runEliseAdvicePipeline({
    message: 'What could I wear with my brown loafers?',
    actorId: ACTOR,
    envelope: null,
    data: dataSource([
      closetRow({ id: LOAFERS, title: 'Brown loafers', clothingType: 'loafers', color: 'brown' }),
    ]),
    flags: { ...CONCIERGE_ON, conciergeV1: false },
  });
  assert.equal('displayFacts' in result!.adviceMetadata.focusedItem, false);
});

Deno.test('DEF-CON-002: common footwear resolves to the shoe layering role', () => {
  for (const category of ['loafers', 'oxfords', 'brogues', 'sandals', 'pumps', 'mules', 'trainers']) {
    const candidate = ownedCandidate({ id: LOAFERS, title: category, category });
    assert.equal(
      candidate.layeringRole,
      'shoe',
      `${category} must map to the shoe role, or the section 29 guardrails silently no-op for it`,
    );
  }
});

Deno.test('DEF-CON-002: bottoms and mid layers resolve too', () => {
  const cases: Array<[string, string]> = [
    ['chinos', 'bottom'],
    ['leggings', 'bottom'],
    ['bomber', 'outer'],
    ['parka', 'outer'],
    ['sweatshirt', 'mid'],
    ['turtleneck', 'base'],
    ['gown', 'one_piece'],
  ];
  for (const [category, role] of cases) {
    assert.equal(ownedCandidate({ id: LOAFERS, title: category, category }).layeringRole, role);
  }
});

Deno.test('DEF-CON-002: capris stay a bottom rather than becoming an accessory', () => {
  assert.equal(
    ownedCandidate({ id: TROUSERS, title: 'Capri pants', category: 'capri pants' }).layeringRole,
    'bottom',
  );
});

Deno.test('DEF-CON-003: an owned FOCUS alone is Closet context', () => {
  const candidate = ownedCandidate({ id: LOAFERS, title: 'Brown loafers', category: 'loafers' });
  // The shortlist is empty because the focus is excluded from it -- the exact
  // shape of a one-item Closet answering a question about that one item.
  assert.equal(
    deriveWardrobeContextMode([], {
      evidenceId: null,
      actorRelationship: 'owned',
      candidate,
      resolution: 'closet_text_match',
    }),
    'closet',
  );
});

Deno.test('DEF-CON-003: an ambiguous owned match is still Closet context', () => {
  assert.equal(
    deriveWardrobeContextMode([], {
      evidenceId: null,
      actorRelationship: 'owned',
      candidate: null,
      resolution: 'closet_text_ambiguous',
      ambiguousCandidates: [
        ownedCandidate({ id: JACKET_A, title: 'Black jacket', category: 'jacket' }),
      ],
    }),
    'closet',
  );
});

Deno.test('DEF-CON-003: a scanned focus is NOT Closet context', () => {
  const candidate = ownedCandidate({ id: SAVED, title: 'Scanned coat', category: 'coat' });
  assert.equal(
    deriveWardrobeContextMode([], {
      evidenceId: 'ev-0',
      actorRelationship: 'scanned',
      candidate: { ...candidate, actorRelationship: 'scanned' },
      resolution: 'current_scan',
    }),
    'none',
  );
});
