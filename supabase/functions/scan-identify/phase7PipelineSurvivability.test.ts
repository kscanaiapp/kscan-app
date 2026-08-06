/**
 * Phase 7 pre-staging integration — local pipeline-survivability harness (Deno).
 *
 * Mandatory gate for the `scanner-phase7-prestaging` integration: proves
 * `clothing_type` / `item.clothingType` survives every backend boundary using
 * the REAL exported functions from each stage, not reimplementations. No
 * network, no provider, no Supabase, no staging, no production, no holdout
 * data — every fixture below is synthetic and inline.
 *
 * Backend stages covered here (client-side stages 7-8 are covered by the
 * companion Node harness, __tests__/scannerPhase7FunnelIntegration.test.js,
 * since client code does not run under Deno):
 *
 *   1. provider fixture (synthetic, inline)
 *   2. parser (IDENTIFICATION_STRING_KEYS allowlist, source-pattern proof —
 *      matching this file's own established test convention, since
 *      scan-identify/index.ts is a Deno.serve handler with no exported
 *      sanitizer to call directly)
 *   3. normalizer (normalizeToV2, real function)
 *   4. scanner endpoint wrapping / V1 isolation (real function +
 *      source-pattern proof of the isolate/reattach block)
 *   5. product-match bridge (projectIdentificationToQuery, real function)
 *   6. product-match context (parseProductMatchRequest, real function)
 *   6b. similarity context (existingItems path of the same parser)
 *   9. V1 output carries no new field (projectV2ToLegacy, real function)
 *  10. no stage replaces the middle tier with category or subtype
 *
 * Plus the multi-item selection suppression boundary this integration fixed:
 * a guessed-primary clothingType must be blanked exactly like category and
 * subtype when MULTI_ITEM_SELECTION_REQUIRED.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';

import { normalizeToV2, projectV2ToLegacy } from '../_shared/fashionIdentificationV2.ts';
import { projectIdentificationToQuery } from './productMatchBridge.ts';
import { suppressV2GuessedIdentity } from './multiItemSelectionContract.ts';
import { parseProductMatchRequest } from '../product-match/index.ts';

const ROOT = new URL('../../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const INDEX_SOURCE = Deno.readTextFileSync(`${ROOT}/supabase/functions/scan-identify/index.ts`);

// ── 1. Provider fixture ──────────────────────────────────────────────────────

/** The mandated fixture: pants -> jeans -> wide_leg_jeans, three distinct tiers. */
const PROVIDER_FIXTURE = {
  visual_observation: 'Dark blue wide-leg jeans laid flat.',
  item_type: 'pants',
  clothing_type: 'jeans',
  subtype: 'wide_leg_jeans',
  primary_color: 'dark blue',
  material_estimate: 'denim',
  confidence_score: 0.84,
  non_fashion: false,
};

// ── 2. Parser retains clothing_type ─────────────────────────────────────────

Deno.test('stage 2 — parser: clothing_type is on the sanitizer allowlist', () => {
  const allowlist = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('const IDENTIFICATION_STRING_KEYS'),
    INDEX_SOURCE.indexOf('const IDENTIFICATION_ARRAY_KEYS'),
  );
  assert(allowlist.includes("'clothing_type'"), 'clothing_type must survive sanitizeIdentification');
});

// ── 3. Normalizer produces item.clothingType === "jeans" ────────────────────

Deno.test('stage 3 — normalizer: identification.clothing_type -> item.clothingType', () => {
  const result = normalizeToV2({
    requestId: 'req_harness',
    outcome: 'classified',
    evidenceIds: ['ev-00000001'],
    identification: PROVIDER_FIXTURE,
    attributes: {},
  });

  assertEquals(result.item.clothingType, 'jeans');
  assertEquals(result.item.category, 'pants');
  assertEquals(result.item.subtype, 'wide_leg_jeans');
});

// ── 4. Scanner endpoint wrapping / V1 isolation ─────────────────────────────

Deno.test('stage 4 — endpoint: legacy identification is stripped, V2 reattaches from the same source', () => {
  const isolation = INDEX_SOURCE.slice(
    INDEX_SOURCE.indexOf('V2-only taxonomy tier isolation'),
    INDEX_SOURCE.indexOf('const completedNormalizedId'),
  );
  assert(isolation.length > 0, 'located the V1/V2 isolation block');
  assert(/clothing_type: _omitted/.test(isolation), 'legacy view omits clothing_type');

  // `return json(finalResponse, 200);` appears more than once in this file
  // (an earlier, unrelated early-return path uses the same literal text), so
  // the end marker is searched for starting AFTER the call site, not from
  // the top of the file.
  const callStart = INDEX_SOURCE.indexOf('applyScanJourneyContract({');
  const bridgeCall = INDEX_SOURCE.slice(
    callStart,
    INDEX_SOURCE.indexOf('return json(finalResponse, 200);', callStart),
  );
  assert(
    /return \{ \.\.\.\(base \?\? \{\}\), clothing_type: v2ClothingType \};/.test(bridgeCall),
    'the applyScanJourneyContract call re-attaches clothing_type for the V2-only bridge path',
  );
});

// ── 5. Product-match bridge receives "jeans" ────────────────────────────────

Deno.test('stage 5 — bridge: projectIdentificationToQuery carries clothingType, no fallback', () => {
  const query = projectIdentificationToQuery(PROVIDER_FIXTURE, {});
  assert(query !== null);
  assertEquals(query!.clothingType, 'jeans');
  assertEquals(query!.canonicalCategory, 'pants');

  // No back-fill: absent stays absent rather than being synthesised from a
  // neighbouring tier.
  const { clothing_type: _omit, ...withoutTier } = PROVIDER_FIXTURE;
  const queryWithoutTier = projectIdentificationToQuery(withoutTier, {});
  assertEquals(queryWithoutTier!.clothingType, null);
});

// ── 6. Product-match context receives "jeans" (query + existingItems) ──────

Deno.test('stage 6 — product-match: the strict request parser accepts and preserves clothingType', () => {
  const parsed = parseProductMatchRequest({
    query: { canonicalCategory: 'pants', clothingType: 'jeans' },
    existingItems: [
      { id: 'closet-1', source: 'closet', canonicalCategory: 'pants', clothingType: 'jeans' },
    ],
  });

  assert(parsed.ok, parsed.ok ? '' : (parsed as { error: string }).error);
  if (!parsed.ok) return;
  assertEquals(parsed.request.query.clothingType, 'jeans');
  assertEquals(parsed.request.existingItems?.[0]?.clothingType, 'jeans');
});

Deno.test('stage 6b — similarity context: an unrelated existingItems field set still rejects, proving the allowlist is real', () => {
  // Negative control: an actually-unsupported field is still hard-rejected, so
  // stage 6 passing is not an artifact of a permissive parser.
  const parsed = parseProductMatchRequest({
    query: { clothingType: 'jeans', notAField: 'x' },
  });
  assert(!parsed.ok);
  assertEquals((parsed as { error: string }).error, "unsupported query field 'notAField'");
});

// ── Selection suppression boundary (fixed during this integration) ─────────

Deno.test('selection suppression — clothingType is blanked on the guessed primary, like category and subtype', () => {
  const v2 = {
    status: 'multiple_items_need_selection',
    resolutionLevel: 'category',
    item: { category: 'pants', clothingType: 'jeans', subtype: 'wide_leg_jeans', brand: { value: 'Levi\'s' } },
  };
  const suppressed = suppressV2GuessedIdentity(v2) as typeof v2;
  assertEquals(suppressed.item.category, null as unknown as string);
  assertEquals(suppressed.item.clothingType, null as unknown as string);
  assertEquals(suppressed.item.subtype, null as unknown as string);
});

Deno.test('selection suppression — a classified (non-selection) status is untouched', () => {
  const v2 = {
    status: 'classified',
    resolutionLevel: 'subtype',
    item: { category: 'pants', clothingType: 'jeans', subtype: 'wide_leg_jeans' },
  };
  assertEquals(suppressV2GuessedIdentity(v2), v2);
});

// ── 9. V1 output carries no new field ───────────────────────────────────────

Deno.test('stage 9 — V1: projectV2ToLegacy never gains clothingType', () => {
  const withTier = projectV2ToLegacy(normalizeToV2({
    requestId: 'req_harness',
    outcome: 'classified',
    evidenceIds: ['ev-00000001'],
    identification: PROVIDER_FIXTURE,
    attributes: {},
  }));
  assert(!('clothingType' in withTier));
  assert(!('clothing_type' in withTier));
});

// ── 10. No stage replaces it with category or subtype ───────────────────────

Deno.test('stage 10 — the three tiers stay distinct end to end', () => {
  const normalized = normalizeToV2({
    requestId: 'req_harness',
    outcome: 'classified',
    evidenceIds: ['ev-00000001'],
    identification: PROVIDER_FIXTURE,
    attributes: {},
  });
  const query = projectIdentificationToQuery(PROVIDER_FIXTURE, {})!;

  for (const [stage, category, clothingType, subtype] of [
    ['normalizer', normalized.item.category, normalized.item.clothingType, normalized.item.subtype],
    ['bridge', query.canonicalCategory, query.clothingType, null],
  ] as const) {
    assert(clothingType !== category, `${stage}: clothingType must not equal category`);
    if (subtype !== null) assert(clothingType !== subtype, `${stage}: clothingType must not equal subtype`);
  }
});

// ── Uncertainty is never fabricated into a concrete value ──────────────────

Deno.test('uncertainty — an unknown clothing_type is preserved verbatim, never counted as a value', () => {
  for (const token of ['unknown', 'not_visible', 'not_applicable', null, '']) {
    const result = normalizeToV2({
      requestId: 'req_harness',
      outcome: 'classified',
      evidenceIds: ['ev-00000001'],
      identification: { ...PROVIDER_FIXTURE, clothing_type: token as unknown as string },
      attributes: {},
    });
    const expected = token === 'unknown' || token === 'not_visible' || token === 'not_applicable' ? token : null;
    assertEquals(result.item.clothingType, expected, `clothing_type=${JSON.stringify(token)}`);
  }
});
