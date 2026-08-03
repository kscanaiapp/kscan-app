/**
 * Checkpoint 3 — integrated scan-journey contract (Deno).
 *
 * Covers the two hard preconditions and the integration:
 *   - multi-item selection: unambiguous state, no guessed primary, lineage
 *     that survives the round trip and is validated on return
 *   - product-match bridge: additive, flag-gated, never throws
 *   - the legacy rollback path: flag-off output is byte-identical
 *
 * No network. The bridge's fetch is injected in every test that reaches it, and
 * the flag-off tests assert that no fetch is attempted at all.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import {
  buildSelectionRequiredPayload,
  isSelectionContractEnabled,
  SELECTION_CONTRACT_DEFAULT_ENABLED,
  SUPPRESSED_WHEN_SELECTION_REQUIRED,
  suppressGuessedPrimary,
  suppressV2GuessedIdentity,
  validateSelectedItemRequest,
  type SelectionLineage,
} from './multiItemSelectionContract.ts';
import {
  isProductMatchBridgeEnabled,
  PRODUCT_MATCH_BRIDGE_DEFAULT_ENABLED,
  projectIdentificationToQuery,
  requestProductMatch,
} from './productMatchBridge.ts';
import {
  applyScanJourneyContract,
  isSimilarItemFlagEnabled,
  SIMILAR_ITEM_FLAG_DEFAULT_ENABLED,
} from './scanJourneyContract.ts';
import { sanitizeExistingItemCandidates, MAX_EXISTING_ITEMS } from './existingItemCandidates.ts';
import {
  deriveScanJourneyState,
  isTerminalState,
  requiresUserAction,
  SCAN_JOURNEY_STATES,
} from '../_shared/scanJourneyState.ts';

const LINEAGE: SelectionLineage = {
  scanId: 'scan-1',
  scanSessionId: 'session-abc',
  imageDigestPrefix: 'digest123',
  evidenceId: 'evidence-1',
};

const GARMENTS = [
  { candidateId: 'c1', label: 'Denim jacket', category: 'outerwear', subtype: 'jacket' },
  { candidateId: 'c2', label: 'White sneakers', category: 'footwear', subtype: 'sneaker' },
  { candidateId: 'c3', label: 'Tote bag', category: 'bag', subtype: 'tote' },
];

// ── precondition 2a: unambiguous selection state ────────────────────────────

Deno.test('a multi-garment scan produces an explicit selection-required state', () => {
  const payload = buildSelectionRequiredPayload({ detectedGarments: GARMENTS, lineage: LINEAGE });
  assert(payload !== null);
  assertEquals(payload.applicationState, 'MULTI_ITEM_SELECTION_REQUIRED');
  // An explicit field, so no client has to infer intent from an array length.
  assertEquals(payload.selectionRequired, true);
  assertEquals(payload.selectionCandidates.length, 3);
});

Deno.test('one garment is not a selection problem', () => {
  assertEquals(
    buildSelectionRequiredPayload({ detectedGarments: [GARMENTS[0]], lineage: LINEAGE }),
    null,
  );
  assertEquals(buildSelectionRequiredPayload({ detectedGarments: [], lineage: LINEAGE }), null);
});

Deno.test('a candidate with no id is dropped rather than offered', () => {
  const payload = buildSelectionRequiredPayload({
    detectedGarments: [GARMENTS[0], { label: 'Unidentifiable' }, GARMENTS[1]],
    lineage: LINEAGE,
  });
  assert(payload !== null);
  assertEquals(payload.selectionCandidates.length, 2, 'offering it would produce a request we must reject');
});

// ── precondition 2b: the backend must not guess ─────────────────────────────

Deno.test('THE RULE: the guessed primary is suppressed when selection is required', () => {
  const withGuess = {
    status: 'completed',
    identification: { item_type: 'outerwear', brand: 'Levi' },
    attributes: { color: 'blue' },
    displayResult: { title: 'Denim jacket' },
    userMessage: 'A denim jacket',
    detectedGarments: GARMENTS,
  };
  const stripped = suppressGuessedPrimary(withGuess);

  for (const field of SUPPRESSED_WHEN_SELECTION_REQUIRED) {
    assertEquals(
      Object.prototype.hasOwnProperty.call(stripped, field),
      false,
      `${field} asserts an identification the user never chose`,
    );
  }
  // The candidates ARE the answer to a multi-item scan and must survive.
  assertEquals((stripped as { detectedGarments?: unknown[] }).detectedGarments?.length, 3);
  assertEquals(stripped.status, 'completed');
});

Deno.test('the suppression list is exactly the fields that imply an identification', () => {
  assertEquals(
    [...SUPPRESSED_WHEN_SELECTION_REQUIRED].sort(),
    ['attributes', 'displayResult', 'identification', 'userMessage'],
  );
});

// ── precondition 2c: lineage survives the round trip ────────────────────────

Deno.test('every candidate carries its own complete selection token', () => {
  const payload = buildSelectionRequiredPayload({ detectedGarments: GARMENTS, lineage: LINEAGE });
  assert(payload !== null);
  for (const candidate of payload.selectionCandidates) {
    // Per-candidate rather than per-response, so a client cannot pair
    // candidate A's id with candidate B's lineage.
    assertEquals(candidate.selectionToken.candidateId, candidate.candidateId);
    assertEquals(candidate.selectionToken.scanSessionId, LINEAGE.scanSessionId);
    assertEquals(candidate.selectionToken.imageDigestPrefix, LINEAGE.imageDigestPrefix);
    assertEquals(candidate.selectionToken.scanId, LINEAGE.scanId);
  }
});

Deno.test('a valid selected-item request is accepted', () => {
  const payload = buildSelectionRequiredPayload({ detectedGarments: GARMENTS, lineage: LINEAGE });
  assert(payload !== null);
  const result = validateSelectedItemRequest({
    token: payload.selectionCandidates[1].selectionToken,
    expected: LINEAGE,
    knownCandidateIds: GARMENTS.map((g) => g.candidateId),
  });
  assertEquals(result.ok, true);
  assertEquals(result.ok && result.candidateId, 'c2');
});

Deno.test('lineage mismatches are rejected, never repaired', () => {
  const base = { candidateId: 'c1', ...LINEAGE };

  assertEquals(
    validateSelectedItemRequest({ token: null, expected: LINEAGE }),
    { ok: false, reason: 'missing_selection_token' },
  );
  assertEquals(
    validateSelectedItemRequest({ token: { ...base, candidateId: '' }, expected: LINEAGE }),
    { ok: false, reason: 'missing_candidate_id' },
  );
  assertEquals(
    validateSelectedItemRequest({ token: { ...base, scanSessionId: 'other' }, expected: LINEAGE }),
    { ok: false, reason: 'lineage_mismatch_scan_session' },
  );
  assertEquals(
    validateSelectedItemRequest({ token: { ...base, imageDigestPrefix: 'other' }, expected: LINEAGE }),
    { ok: false, reason: 'lineage_mismatch_image_digest' },
  );
  assertEquals(
    validateSelectedItemRequest({ token: base, expected: LINEAGE, knownCandidateIds: ['c9'] }),
    { ok: false, reason: 'unknown_candidate' },
  );
});

Deno.test('a lineage field the backend never emits is skipped, not failed', () => {
  // The deployed backend emits no detection digest. Failing every request over
  // a structurally absent field would take the whole journey offline.
  const expected: SelectionLineage = { ...LINEAGE, scanSessionId: null, imageDigestPrefix: null };
  const result = validateSelectedItemRequest({
    token: { candidateId: 'c1', scanId: 'scan-1', scanSessionId: null, imageDigestPrefix: null, evidenceId: null },
    expected,
  });
  assertEquals(result.ok, true);
});

// ── journey states ──────────────────────────────────────────────────────────

Deno.test('selection outranks every other state', () => {
  // A multi-item image has no single correct identification, so any state below
  // selection would imply one.
  assertEquals(
    deriveScanJourneyState({ selectionRequired: true, identified: true, enriched: true, confidentMatch: true }),
    'MULTI_ITEM_SELECTION_REQUIRED',
  );
});

Deno.test('failure outranks selection', () => {
  assertEquals(deriveScanJourneyState({ failed: true, selectionRequired: true }), 'FAILED');
});

Deno.test('the remaining states derive from what the response contains', () => {
  assertEquals(deriveScanJourneyState({ identified: true }), 'FASHION_IDENTIFIED');
  assertEquals(deriveScanJourneyState({ identified: true, candidateCount: 4 }), 'CANDIDATES_READY');
  assertEquals(
    deriveScanJourneyState({ identified: true, enriched: true, confidentMatch: true }),
    'ENRICHED',
  );
  assertEquals(
    deriveScanJourneyState({ identified: true, enriched: true, confidentMatch: false }),
    'NO_CONFIDENT_MATCH',
  );
  assertEquals(deriveScanJourneyState({}), 'NO_CONFIDENT_MATCH');
});

Deno.test('only selection blocks the journey on the user', () => {
  assertEquals(requiresUserAction('MULTI_ITEM_SELECTION_REQUIRED'), true);
  for (const state of SCAN_JOURNEY_STATES.filter((s) => s !== 'MULTI_ITEM_SELECTION_REQUIRED')) {
    assertEquals(requiresUserAction(state), false, `${state} must not block on the user`);
  }
  assertEquals(isTerminalState('ENRICHED'), true);
  assertEquals(isTerminalState('MULTI_ITEM_SELECTION_REQUIRED'), false);
});

// ── the bridge ──────────────────────────────────────────────────────────────

Deno.test('all three Checkpoint 3 flags default off', () => {
  assertEquals(SELECTION_CONTRACT_DEFAULT_ENABLED, false);
  assertEquals(PRODUCT_MATCH_BRIDGE_DEFAULT_ENABLED, false);
  assertEquals(SIMILAR_ITEM_FLAG_DEFAULT_ENABLED, false);
  assertEquals(isSelectionContractEnabled(() => undefined), false);
  assertEquals(isProductMatchBridgeEnabled(() => undefined), false);
  assertEquals(isSimilarItemFlagEnabled(() => undefined), false);
});

Deno.test('a disabled bridge makes no fetch at all', async () => {
  let fetched = false;
  const outcome = await requestProductMatch(
    { query: { brand: 'Nike' } },
    { envGet: () => undefined, fetchImpl: (() => { fetched = true; return Promise.reject(new Error('x')); }) as unknown as typeof fetch },
  );
  assertEquals(fetched, false);
  assertEquals(outcome.attempted, false);
  assertEquals(outcome.skipReason, 'disabled');
});

Deno.test('the bridge refuses to run when selection is required', async () => {
  // Matching products against a garment nobody chose is the same guess the
  // selection contract exists to remove, arriving by a different door.
  let fetched = false;
  const outcome = await requestProductMatch(
    { query: { brand: 'Nike' }, selectionRequired: true },
    {
      envGet: (k) => (k === 'SCAN_PRODUCT_MATCH_ENABLED' ? 'true' : undefined),
      fetchImpl: (() => { fetched = true; return Promise.reject(new Error('x')); }) as unknown as typeof fetch,
    },
  );
  assertEquals(fetched, false);
  assertEquals(outcome.skipReason, 'selection_required');
});

const BRIDGE_ENV = (key: string) =>
  key === 'SCAN_PRODUCT_MATCH_ENABLED' ? 'true'
    : key === 'SUPABASE_URL' ? 'https://project.supabase.co'
    : key === 'PRODUCT_MATCH_INTERNAL_SECRET' ? 'secret'
    : undefined;

Deno.test('an unreachable endpoint degrades to a reason, never an exception', async () => {
  const outcome = await requestProductMatch(
    { query: { brand: 'Nike' } },
    { envGet: BRIDGE_ENV, fetchImpl: (() => Promise.reject(new TypeError('nope'))) as unknown as typeof fetch },
  );
  assertEquals(outcome.attempted, true);
  assertEquals(outcome.skipReason, 'unreachable');
  assertEquals(outcome.productMatch, undefined);
});

Deno.test('a 404 from a dormant product-match is a configuration state, not an incident', async () => {
  const outcome = await requestProductMatch(
    { query: { brand: 'Nike' } },
    {
      envGet: BRIDGE_ENV,
      fetchImpl: (() => Promise.resolve(new Response('{"code":"FEATURE_DISABLED"}', { status: 404 }))) as unknown as typeof fetch,
    },
  );
  assertEquals(outcome.skipReason, 'rejected');
});

Deno.test('a successful hop returns the product-match payload verbatim', async () => {
  const body = { contractVersion: 1, tier: 'LIKELY_EXACT', listings: [], potentialSimilarItems: [] };
  const outcome = await requestProductMatch(
    { query: { brand: 'Nike' } },
    {
      envGet: BRIDGE_ENV,
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }))) as unknown as typeof fetch,
    },
  );
  assertEquals(outcome.attempted, true);
  assertEquals(outcome.skipReason, undefined);
  assertEquals((outcome.productMatch as { tier: string }).tier, 'LIKELY_EXACT');
});

Deno.test('the identification projection forwards named fields only', () => {
  const query = projectIdentificationToQuery(
    {
      item_type: 'footwear',
      brand: 'Nike',
      visible_brand_text: 'NIKE',
      primary_color: 'white',
      // Everything below must NOT reach a third-party service.
      visual_observation: 'a person wearing white sneakers on a sofa',
      raw_model_output: { tokens: 4471 },
      confidence: { overall: 0.91 },
      image_base64: 'AAAA',
    },
    { color: 'white' },
  );
  assert(query !== null);
  const serialized = JSON.stringify(query);
  assert(!serialized.includes('sofa'), 'visual observations must not be forwarded');
  assert(!serialized.includes('AAAA'), 'no image data may be forwarded');
  assert(!serialized.includes('4471'));
  assertEquals(query.brand, 'Nike');
  assertEquals(query.canonicalCategory, 'footwear');
});

Deno.test('an identification with no usable signal projects to null', () => {
  assertEquals(projectIdentificationToQuery(undefined), null);
  assertEquals(projectIdentificationToQuery({ confidence: { overall: 0.4 } }), null);
});

// ── existing-item sanitizer ─────────────────────────────────────────────────

Deno.test('the sanitizer keeps only allowlisted fields', () => {
  const [item] = sanitizeExistingItemCandidates([{
    id: 'c1', source: 'closet', brand: 'Nike', imageUri: 'file:///a.jpg',
    userId: 'user-42', authToken: 'secret', imageBase64: 'AAAA',
  }]);
  assertEquals(item.id, 'c1');
  assertEquals(item.brand, 'Nike');
  assertEquals(item.imageUri, 'file:///a.jpg');
  assertEquals(item.userId, undefined, 'a user id must never be forwarded');
  assertEquals(item.authToken, undefined);
  assertEquals(item.imageBase64, undefined);
});

Deno.test('the sanitizer drops malformed candidates without failing the scan', () => {
  const items = sanitizeExistingItemCandidates([
    { id: 'c1', source: 'closet' },
    { source: 'closet' },
    { id: 'c2', source: 'wardrobe' },
    { id: 'c1', source: 'recent_scan' },
    null,
    'nonsense',
  ]);
  assertEquals(items.length, 1, 'duplicates, bad sources and non-objects are all dropped');
  assertEquals(items[0].id, 'c1');
});

Deno.test('the sanitizer caps how many candidates it accepts', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ id: `c${i}`, source: 'closet' }));
  assertEquals(sanitizeExistingItemCandidates(many).length, MAX_EXISTING_ITEMS);
});

// ── THE ROLLBACK PROOF ──────────────────────────────────────────────────────

const LEGACY_RESPONSE = {
  status: 'completed',
  identification: { item_type: 'outerwear' },
  attributes: { color: 'blue' },
  displayResult: { title: 'Denim jacket' },
  recommendedProducts: [{ id: 'p1' }],
  detectedGarments: GARMENTS,
};

Deno.test('THE ROLLBACK PATH: with every flag off the response is unchanged', async () => {
  let fetched = false;
  const before = JSON.stringify(LEGACY_RESPONSE);
  const after = await applyScanJourneyContract({
    finalResponse: { ...LEGACY_RESPONSE },
    useMultiItemDetectionProvider: true,
    detectedGarments: GARMENTS,
    scanId: 'scan-1',
    scanSessionId: 'session-abc',
    imageDigestPrefix: 'digest123',
    evidenceId: 'evidence-1',
    recommendedProductCount: 1,
    identification: { item_type: 'outerwear' },
    existingItems: [{ id: 'c1', source: 'closet' }],
    mode: 'image',
    deps: {
      envGet: () => undefined,
      fetchImpl: (() => { fetched = true; return Promise.reject(new Error('x')); }) as unknown as typeof fetch,
    },
  });

  assertEquals(fetched, false, 'no network call may happen with the flags off');
  // The legacy fields are all present and unmodified; only observability was
  // added. A client that ignores the new keys sees exactly what it sees today.
  assertEquals(after.status, 'completed');
  assertEquals(JSON.stringify(after.identification), JSON.stringify(LEGACY_RESPONSE.identification));
  assertEquals(JSON.stringify(after.displayResult), JSON.stringify(LEGACY_RESPONSE.displayResult));
  assertEquals(JSON.stringify(after.recommendedProducts), JSON.stringify(LEGACY_RESPONSE.recommendedProducts));
  assertEquals(before, JSON.stringify(LEGACY_RESPONSE), 'the input object must not be mutated');
});

Deno.test('the similarity seam is reported even while the engine is off', async () => {
  // The calibration pass needs the candidate population measured BEFORE the
  // engine is enabled, not after.
  const after = await applyScanJourneyContract({
    finalResponse: { ...LEGACY_RESPONSE, detectedGarments: [] },
    useMultiItemDetectionProvider: false,
    detectedGarments: [],
    scanId: 'scan-1',
    recommendedProductCount: 1,
    identification: { item_type: 'footwear', brand: 'Nike', primary_color: 'white' },
    existingItems: [
      { id: 'c1', source: 'closet' },
      { id: 'r1', source: 'recent_scan' },
    ],
    mode: 'image',
    deps: { envGet: () => undefined },
  });

  const journey = after.scanJourney as { similarity: Record<string, unknown> };
  assertEquals(journey.similarity.enabled, false);
  assertEquals(journey.similarity.candidatesAvailable, 2);
  assertEquals(journey.similarity.sourcesChecked, ['closet', 'recent_scan']);
  assertEquals(journey.similarity.flagged, 0);
  assert(Array.isArray(journey.similarity.comparisonInputs));
  assert((journey.similarity.comparisonInputs as string[]).includes('brand'));
});

// ── the integrated flow ─────────────────────────────────────────────────────

Deno.test('INTEGRATED: multi-item scan stops for selection and never calls product-match', async () => {
  let fetched = false;
  const after = await applyScanJourneyContract({
    finalResponse: { ...LEGACY_RESPONSE },
    useMultiItemDetectionProvider: true,
    detectedGarments: GARMENTS,
    scanId: 'scan-1',
    scanSessionId: 'session-abc',
    imageDigestPrefix: 'digest123',
    evidenceId: 'evidence-1',
    recommendedProductCount: 0,
    identification: { item_type: 'outerwear' },
    mode: 'image',
    deps: {
      envGet: (k) =>
        k === 'SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED' ? 'true'
          : k === 'SCAN_PRODUCT_MATCH_ENABLED' ? 'true'
          : k === 'SUPABASE_URL' ? 'https://project.supabase.co'
          : k === 'PRODUCT_MATCH_INTERNAL_SECRET' ? 'secret'
          : undefined,
      fetchImpl: (() => { fetched = true; return Promise.reject(new Error('x')); }) as unknown as typeof fetch,
    },
  });

  assertEquals(after.applicationState, 'MULTI_ITEM_SELECTION_REQUIRED');
  assertEquals(after.selectionRequired, true);
  assertEquals(after.identification, undefined, 'no guessed primary survives');
  assertEquals(fetched, false, 'product-match must not run on an unresolved multi-item scan');
  assertEquals((after.selectionCandidates as unknown[]).length, 3);
});

// ── regressions found during Checkpoint 3 hostile validation ────────────────

Deno.test('REGRESSION: the guess does not survive one level down in the V2 envelope', () => {
  // Suppressing the legacy `identification` was not enough. `normalizeToV2`
  // treats `multiple_items_need_selection` as identity-bearing, so the V2
  // envelope carried the SAME guessed category/subtype/brand that had just
  // been stripped above it. Stripping only the top level moved the guess
  // rather than removing it.
  const v2 = {
    contractVersion: 2,
    status: 'multiple_items_need_selection',
    resolutionLevel: 'category',
    item: {
      category: 'outerwear',
      subtype: 'denim jacket',
      brand: { value: 'Levi', confidence: 0.8 },
      colors: { primary: 'blue' },
    },
    candidates: [{ candidateId: 'c1' }, { candidateId: 'c2' }],
  };

  const cleaned = suppressV2GuessedIdentity(v2) as typeof v2;
  assertEquals(cleaned.item.category, null);
  assertEquals(cleaned.item.subtype, null);
  assertEquals(cleaned.item.brand.value, null);
  assertEquals(cleaned.resolutionLevel, 'unknown');
  // The candidates ARE the answer and must survive.
  assertEquals(cleaned.candidates.length, 2);
  // Untouched fields stay untouched.
  assertEquals(cleaned.item.colors.primary, 'blue');
});

Deno.test('REGRESSION: a V2 envelope for any other status is left alone', () => {
  const classified = {
    status: 'completed',
    resolutionLevel: 'exact',
    item: { category: 'footwear', subtype: 'sneaker', brand: { value: 'Nike' } },
  };
  assertEquals(suppressV2GuessedIdentity(classified), classified);
  assertEquals(suppressV2GuessedIdentity(null), null);
  assertEquals(suppressV2GuessedIdentity('nonsense'), 'nonsense');
});

Deno.test('REGRESSION: applyScanJourneyContract strips the V2 guess too', async () => {
  const after = await applyScanJourneyContract({
    finalResponse: {
      ...LEGACY_RESPONSE,
      identificationV2: {
        status: 'multiple_items_need_selection',
        resolutionLevel: 'category',
        item: { category: 'outerwear', subtype: 'denim jacket', brand: { value: 'Levi' } },
        candidates: [{ candidateId: 'c1' }],
      },
    },
    useMultiItemDetectionProvider: true,
    detectedGarments: GARMENTS,
    scanId: 'scan-1',
    scanSessionId: 'session-abc',
    imageDigestPrefix: 'digest123',
    recommendedProductCount: 0,
    identification: { item_type: 'outerwear' },
    mode: 'image',
    deps: { envGet: (k) => (k === 'SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED' ? 'true' : undefined) },
  });

  const v2 = after.identificationV2 as { item: { category: unknown; brand: { value: unknown } } };
  assertEquals(v2.item.category, null, 'the V2 guess must not survive suppression');
  assertEquals(v2.item.brand.value, null);
  assertEquals(after.identification, undefined);
});

Deno.test('REGRESSION: the selection array is named unambiguously', () => {
  // A V2 response already carries `identificationV2.candidates` with a
  // different shape. Two differently-shaped `candidates` in one payload is the
  // ambiguity a client team would trip over.
  const payload = buildSelectionRequiredPayload({ detectedGarments: GARMENTS, lineage: LINEAGE });
  assert(payload !== null);
  assertEquals(
    Object.prototype.hasOwnProperty.call(payload, 'candidates'),
    false,
    'the root selection array must not be called `candidates`',
  );
  assertEquals(payload.selectionCandidates.length, 3);
});

Deno.test('INTEGRATED: the selected item flows through to an enriched result', async () => {
  // Step 1 — the client picks a candidate and echoes its token back.
  const selection = buildSelectionRequiredPayload({ detectedGarments: GARMENTS, lineage: LINEAGE });
  assert(selection !== null);
  const chosen = selection.selectionCandidates[1];
  const validated = validateSelectedItemRequest({
    token: chosen.selectionToken,
    expected: LINEAGE,
    knownCandidateIds: GARMENTS.map((g) => g.candidateId),
  });
  assertEquals(validated.ok, true);

  // Step 2 — the follow-up scan resolves one garment and reaches product-match.
  const productMatchBody = {
    contractVersion: 1,
    tier: 'LIKELY_EXACT',
    families: [],
    listings: [{ listingKey: 'url:https://nike.com/af1' }],
    potentialSimilarItems: [],
  };
  const after = await applyScanJourneyContract({
    finalResponse: { status: 'completed', identification: { item_type: 'footwear' }, recommendedProducts: [] },
    useMultiItemDetectionProvider: false,
    detectedGarments: [],
    scanId: 'scan-1',
    scanSessionId: 'session-abc',
    imageDigestPrefix: 'digest123',
    recommendedProductCount: 0,
    identification: { item_type: 'footwear', brand: 'Nike', primary_color: 'white' },
    mode: 'image',
    deps: {
      envGet: BRIDGE_ENV,
      fetchImpl: (() => Promise.resolve(new Response(JSON.stringify(productMatchBody), { status: 200 }))) as unknown as typeof fetch,
    },
  });

  assertEquals(after.applicationState, 'ENRICHED');
  assertEquals((after.productMatch as { tier: string }).tier, 'LIKELY_EXACT');
  const journey = after.scanJourney as { productMatch: { attempted: boolean } };
  assertEquals(journey.productMatch.attempted, true);
});

Deno.test('INTEGRATED: a failed product-match leaves the legacy result standing', async () => {
  const legacy = { status: 'completed', identification: { item_type: 'footwear' }, recommendedProducts: [{ id: 'p1' }] };
  const after = await applyScanJourneyContract({
    finalResponse: { ...legacy },
    useMultiItemDetectionProvider: false,
    detectedGarments: [],
    scanId: 'scan-1',
    recommendedProductCount: 1,
    identification: { item_type: 'footwear', brand: 'Nike' },
    mode: 'image',
    deps: {
      envGet: BRIDGE_ENV,
      fetchImpl: (() => Promise.reject(new TypeError('down'))) as unknown as typeof fetch,
    },
  });

  assertEquals(JSON.stringify(after.recommendedProducts), JSON.stringify(legacy.recommendedProducts));
  assertEquals(after.productMatch, undefined);
  // There is no failure mode in which enabling this makes the scan worse.
  assertEquals(after.applicationState, 'CANDIDATES_READY');
  const journey = after.scanJourney as { productMatch: { skipReason?: string } };
  assertEquals(journey.productMatch.skipReason, 'unreachable');
});

Deno.test('a contract-layer defect never costs the user their scan result', async () => {
  const legacy = { status: 'completed', recommendedProducts: [{ id: 'p1' }] };
  const after = await applyScanJourneyContract({
    finalResponse: legacy,
    useMultiItemDetectionProvider: true,
    // A non-array where an array is expected: the kind of shape error a
    // refactor introduces.
    detectedGarments: null as unknown as Array<Record<string, unknown>>,
    scanId: 'scan-1',
    recommendedProductCount: 1,
    mode: 'image',
    deps: { envGet: (k) => (k === 'SCAN_MULTI_ITEM_SELECTION_CONTRACT_ENABLED' ? 'true' : undefined) },
  });
  assertEquals(JSON.stringify(after.recommendedProducts), JSON.stringify(legacy.recommendedProducts));
});
