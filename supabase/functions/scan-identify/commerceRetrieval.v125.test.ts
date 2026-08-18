/**
 * Commerce Retrieval Enrichment (v125) — focused Deno tests.
 *
 * Fixture-based; does not claim production accuracy. These pin the *decision*
 * v125 makes (which strategy, which terms) rather than exact provider results,
 * which no local test can know.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  COMMERCE_RETRIEVAL_DEFAULT_ENABLED,
  COMMERCE_RETRIEVAL_VERSION,
  isCommerceRetrievalEnabled,
  MAX_QUERY_DISTINCTIVE_FEATURES,
} from './commerceRetrievalConfig.ts';
import {
  ABSOLUTE_QUERY_MEANINGFUL_WORDS,
  TARGET_QUERY_KEY_TERMS_MAX,
} from './commerceRelevanceConfig.ts';
import {
  buildCategoryCommerceQueries,
  hypothesisCategoryCompatible,
  patternForQuery,
  resolveQueryStrategy,
  selectDistinctiveQueryFeatures,
} from './commerceRelevanceQueries.ts';
import { applyScannerQualityGate } from './scannerQualityGate.ts';
import { buildWeightedCommerceQueries } from './qualityTuneCommerce.ts';
import type { ScannerCategoryRoute } from './scannerCategoryRoute.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function gate(identification: Record<string, unknown>) {
  return applyScannerQualityGate(identification, undefined, { commerceIdentityEnabled: true });
}

const MOTO_BASE = {
  item_type: 'outerwear',
  subtype: 'moto jacket',
  primary_color: 'black',
  material_estimate: 'leather',
  silhouette: 'cropped',
  fit: 'slim',
  pattern: 'solid',
};

/** Build both the v124 and v125 query for one identification fixture. */
function queries(raw: Record<string, unknown>, route: ScannerCategoryRoute = 'apparel') {
  const gated = gate({ ...raw });
  const common = {
    identification: gated.identification,
    categoryRoute: route,
    detailLevel: 'specific' as const,
    qualityBand: gated.qualityBand,
  };
  return {
    gated,
    identity: gated.commerceIdentity!,
    v124: buildCategoryCommerceQueries(common),
    v125: buildCategoryCommerceQueries({ ...common, commerceIdentity: gated.commerceIdentity }),
  };
}

function meaningfulWordCount(q: string): number {
  return q.split(' ').filter(Boolean).length;
}

// ── A. Flag semantics ────────────────────────────────────────────────────────

Deno.test('v125 flag: version, default, and env override semantics', () => {
  assertEquals(COMMERCE_RETRIEVAL_VERSION, 'v125');
  assertEquals(isCommerceRetrievalEnabled(() => undefined), COMMERCE_RETRIEVAL_DEFAULT_ENABLED);
  assertEquals(isCommerceRetrievalEnabled(() => 'true'), true);
  assertEquals(isCommerceRetrievalEnabled(() => 'ON'), true);
  assertEquals(isCommerceRetrievalEnabled(() => '1'), true);
  assertEquals(isCommerceRetrievalEnabled(() => 'false'), false);
  assertEquals(isCommerceRetrievalEnabled(() => 'off'), false);
  assertEquals(isCommerceRetrievalEnabled(() => '0'), false);
  assertEquals(isCommerceRetrievalEnabled(() => 'maybe'), COMMERCE_RETRIEVAL_DEFAULT_ENABLED);
});

Deno.test('v125 flag is independent of v124: v124 ON + v125 OFF is a valid state', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  // Separate env var — not an overload of the v124 flag.
  assert(index.includes('isCommerceRetrievalEnabled()'));
  assert(index.includes('commerceIdentityEnabled && isCommerceRetrievalEnabled()'));
  const config = await Deno.readTextFile(new URL('./commerceRetrievalConfig.ts', import.meta.url));
  assert(config.includes('BACKEND_COMMERCE_RETRIEVAL_V125_ENABLED'));
  assert(!config.includes('BACKEND_COMMERCE_IDENTITY_ENABLED'));
});

// ── B. Strategy selection ────────────────────────────────────────────────────

Deno.test('MODE A exact_identity: a supported hypothesis drives the query', () => {
  const { v124, v125 } = queries({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper', 'silver-tone hardware', 'belted hem'],
    brand_guess: 'Saint Laurent',
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  });

  assertEquals(v125.strategy, 'exact_identity');
  const lower = v125.primary.toLowerCase();
  assert(lower.includes('saint laurent'), `brand missing: ${v125.primary}`);
  assert(lower.includes('l01'), `model identity missing: ${v125.primary}`);
  assertEquals(v125.identityTerms?.brandIncluded, true);
  assertEquals(v125.identityTerms?.exactHypothesisIncluded, true);

  // It must not collapse back to the generic attribute query the audit proved.
  assertEquals(v124.primary, 'black moto jacket cropped leather slim');
  assert(v125.primary !== v124.primary);
});

Deno.test('MODE B brand_distinctive: plausible brand without a model hypothesis', () => {
  const { v125 } = queries({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper', 'belted hem'],
    brand_guess: 'Saint Laurent',
    brand_confidence: 'medium',
  });

  assertEquals(v125.strategy, 'brand_distinctive');
  const lower = v125.primary.toLowerCase();
  assert(lower.includes('saint laurent'));
  // Brand coexists with real fashion identity, never floats alone.
  assert(lower.includes('moto') || lower.includes('jacket'));
  assert(lower.includes('zipper'), `distinctive construction missing: ${v125.primary}`);
  assertEquals(v125.identityTerms?.exactHypothesisIncluded, false);
});

Deno.test('MODE C attribute_only: no usable commercial identity', () => {
  const { v125 } = queries({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper', 'belted hem'],
  });

  assertEquals(v125.strategy, 'attribute_only');
  assert(v125.primary.toLowerCase().includes('moto'));
  assert(v125.primary.toLowerCase().includes('zipper'));
});

Deno.test('a plausible brand needs a real garment term to be usable', () => {
  const identity = gate({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper'],
    brand_guess: 'Saint Laurent',
    brand_confidence: 'medium',
  }).commerceIdentity!;

  assertEquals(resolveQueryStrategy(identity, 'moto jacket', 'outerwear').strategy, 'brand_distinctive');
  // Strip the accompanying fashion identity and a plausible brand is not enough.
  assertEquals(resolveQueryStrategy(identity, '', 'outerwear').strategy, 'attribute_only');

  // A verified brand stands on its own evidence.
  const verified = gate({ ...MOTO_BASE, visible_brand_text: 'Saint Laurent', brand_guess: 'Saint Laurent' })
    .commerceIdentity!;
  assertEquals(resolveQueryStrategy(verified, '', 'outerwear').strategy, 'brand_distinctive');
});

// ── C. Mandatory safety regressions ──────────────────────────────────────────

Deno.test('REGRESSION: a LOW-confidence brand must NOT enter the provider query', () => {
  const { v125, identity } = queries({
    ...MOTO_BASE,
    distinctive_features: [],
    brand_guess: 'Saint Laurent',
    brand_confidence: 'low',
  });

  assertEquals(identity.brandGrade, 'weak');
  assertEquals(v125.strategy, 'attribute_only');
  assert(
    !v125.primary.toLowerCase().includes('saint') && !v125.primary.toLowerCase().includes('laurent'),
    `weak brand poisoned the query: ${v125.primary}`,
  );
  assert(!v125.fallback.toLowerCase().includes('laurent'));
  assertEquals(v125.identityTerms?.brandIncluded, false);
});

Deno.test('REGRESSION: an incompatible model hypothesis is downgraded, not emitted', () => {
  const { v125, identity } = queries({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper'],
    brand_guess: 'Louis Vuitton',
    brand_confidence: 'medium',
    // A bag model hypothesis on an outerwear scan — the hypothesis is wrong.
    exact_item_hypothesis: 'Speedy 30 Handbag',
    exact_match_confidence: 'medium',
  });

  assertEquals(identity.exactMatchGrade, 'plausible');
  // Product identity is evidence, not command authority.
  assertEquals(v125.strategy, 'brand_distinctive');
  assert(
    !v125.primary.toLowerCase().includes('speedy'),
    `incompatible hypothesis was emitted: ${v125.primary}`,
  );
  assertEquals(v125.identityTerms?.exactHypothesisIncluded, false);
});

Deno.test('REGRESSION: a model hypothesis with no brand behind it cannot drive retrieval', () => {
  const { v125 } = queries({
    ...MOTO_BASE,
    distinctive_features: [],
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  });
  // No brand evidence → the hypothesis is an unanchored guess.
  assertEquals(v125.strategy, 'attribute_only');
  assert(!v125.primary.toLowerCase().includes('l01'));
});

Deno.test('hypothesisCategoryCompatible: contradiction blocks, silence does not', () => {
  assert(hypothesisCategoryCompatible('L01 Motorcycle Jacket', 'outerwear'));
  assert(!hypothesisCategoryCompatible('Speedy 30 Handbag', 'outerwear'));
  assert(!hypothesisCategoryCompatible('Rockstud Pump', 'bag'));
  // No category token in the hypothesis → no contradicting evidence.
  assert(hypothesisCategoryCompatible('Speedy 30', 'bag'));
  assert(hypothesisCategoryCompatible('Air Jordan 1 High Chicago', 'footwear'));
});

// ── D. Distinctive features and pattern ──────────────────────────────────────

Deno.test('distinctive features: high-signal only, bounded, generic rejected', () => {
  const identity = gate({
    ...MOTO_BASE,
    distinctive_features: [
      'clean lines',
      'asymmetric zipper',
      'luxury designer feel',
      'belted hem',
      'contrast stitching',
      'timeless silhouette',
    ],
  }).commerceIdentity!;

  const picked = selectDistinctiveQueryFeatures(identity);
  assert(picked.length <= MAX_QUERY_DISTINCTIVE_FEATURES);
  assert(picked.includes('asymmetric zipper'));
  // Marketing adjectives and non-construction prose never earn query budget.
  assert(!picked.some((f) => /luxury|designer|timeless|clean lines/i.test(f)));

  assertEquals(selectDistinctiveQueryFeatures(undefined), []);
});

Deno.test('distinctive construction outranks generic descriptors within the cap', () => {
  const { v124, v125 } = queries({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper', 'belted hem'],
  });

  const lower = v125.primary.toLowerCase();
  assert(lower.includes('zipper'), `construction missing: ${v125.primary}`);
  // v124 spent that budget on silhouette/fit adjectives instead.
  assert(v124.primary.includes('cropped') && v124.primary.includes('slim'));
  assert(!lower.includes('slim'), `low-value fit adjective outranked construction: ${v125.primary}`);
});

Deno.test('pattern: discriminating patterns survive, "solid" never consumes budget', () => {
  assertEquals(patternForQuery('houndstooth'), 'houndstooth');
  assertEquals(patternForQuery('monogram'), 'monogram');
  assertEquals(patternForQuery('solid'), '');
  assertEquals(patternForQuery('Solid'), '');
  assertEquals(patternForQuery(''), '');
  // Unknown free-text patterns are not assumed discriminating.
  assertEquals(patternForQuery('nice texture'), '');

  const { v125 } = queries({
    item_type: 'blazer',
    subtype: 'blazer',
    primary_color: 'black',
    material_estimate: 'wool',
    pattern: 'houndstooth',
    silhouette: 'tailored',
    distinctive_features: ['notch lapel', 'double-breasted closure'],
  });
  assert(v125.primary.toLowerCase().includes('houndstooth'), `pattern lost: ${v125.primary}`);

  const solid = queries({ ...MOTO_BASE, distinctive_features: [] });
  assert(!solid.v125.primary.toLowerCase().includes('solid'));
});

// ── E. Query budget ──────────────────────────────────────────────────────────

Deno.test('QUERY BUDGET: v125 never exceeds the governed caps', () => {
  const fixtures: Record<string, unknown>[] = [
    {
      ...MOTO_BASE,
      distinctive_features: ['asymmetric zipper', 'silver-tone hardware', 'belted hem'],
      brand_guess: 'Saint Laurent',
      brand_confidence: 'medium',
      exact_item_hypothesis: 'L01 Motorcycle Jacket',
      exact_match_confidence: 'medium',
    },
    {
      ...MOTO_BASE,
      pattern: 'houndstooth',
      distinctive_features: ['quilted construction', 'contrast stitching', 'belted hem'],
      visible_brand_text: 'Some Very Long Maison Name',
      brand_guess: 'Some Very Long Maison Name',
      exact_item_hypothesis: 'The Extremely Long Model Family Name',
      exact_match_confidence: 'high',
    },
    { ...MOTO_BASE, distinctive_features: [] },
  ];

  for (const raw of fixtures) {
    const { v125 } = queries(raw);
    assert(
      meaningfulWordCount(v125.primary) <= ABSOLUTE_QUERY_MEANINGFUL_WORDS,
      `primary exceeded the word cap: "${v125.primary}"`,
    );
    assert(
      meaningfulWordCount(v125.fallback) <= ABSOLUTE_QUERY_MEANINGFUL_WORDS,
      `fallback exceeded the word cap: "${v125.fallback}"`,
    );
    assert(TARGET_QUERY_KEY_TERMS_MAX > 0);
  }
});

// ── F. Fallback ──────────────────────────────────────────────────────────────

Deno.test('FALLBACK: brand-neutral, and drops identity before the garment term', () => {
  const { v125 } = queries({
    ...MOTO_BASE,
    distinctive_features: ['asymmetric zipper', 'belted hem'],
    brand_guess: 'Saint Laurent',
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  });

  assertEquals(v125.strategy, 'exact_identity');
  const fallback = v125.fallback.toLowerCase();
  // Uncertain commercial identity is what the fallback exists to undo.
  assert(!fallback.includes('saint') && !fallback.includes('laurent'));
  assert(!fallback.includes('l01'));
  // Reliable category/subtype evidence survives.
  assert(fallback.includes('moto') && fallback.includes('jacket'));
  assert(fallback.includes('black'));
  assert(fallback.includes('leather'));
  assert(v125.fallback !== v125.primary);
});

Deno.test('FALLBACK: exists for every strategy, including attribute_only', () => {
  for (
    const raw of [
      { ...MOTO_BASE, distinctive_features: [] },
      { ...MOTO_BASE, distinctive_features: [], brand_guess: 'Saint Laurent', brand_confidence: 'low' },
      { ...MOTO_BASE, distinctive_features: ['asymmetric zipper'], brand_guess: 'Saint Laurent', brand_confidence: 'medium' },
    ]
  ) {
    const { v125 } = queries(raw);
    assert(v125.fallback.length > 0, `missing fallback for ${v125.strategy}`);
    assert(!v125.fallback.toLowerCase().includes('laurent'));
  }
});

// ── G. Sneaker identity ──────────────────────────────────────────────────────

Deno.test('sneaker exact model replaces a colour-shaped footwear query', () => {
  const { v124, v125 } = queries({
    item_type: 'footwear',
    subtype: 'high top sneakers',
    primary_color: 'red',
    material_estimate: 'leather',
    pattern: 'solid',
    distinctive_features: ['perforated toe box', 'ankle collar'],
    visible_brand_text: 'Nike',
    logo_detected: true,
    brand_guess: 'Nike',
    brand_confidence: 'high',
    exact_item_hypothesis: 'Air Jordan 1 High Chicago',
    exact_match_confidence: 'high',
  }, 'footwear');

  assertEquals(v125.strategy, 'exact_identity');
  const lower = v125.primary.toLowerCase();
  assert(lower.includes('air jordan'), `model identity missing: ${v125.primary}`);
  assert(lower.includes('chicago'));
  // v124 asked for a colour-shaped description of the same shoe.
  assert(v124.primary.toLowerCase().includes('red'));
  assert(v125.primary !== v124.primary);
  // The brand-neutral fallback still describes the shoe.
  assert(v125.fallback.toLowerCase().includes('sneakers'));
});

// ── H. Flag-off equivalence ──────────────────────────────────────────────────

Deno.test('FLAG OFF: queries are byte-identical to v124 for every fixture', () => {
  const fixtures: [Record<string, unknown>, ScannerCategoryRoute][] = [
    [{ ...MOTO_BASE, distinctive_features: ['asymmetric zipper'] }, 'apparel'],
    [{
      ...MOTO_BASE,
      brand_guess: 'Saint Laurent',
      brand_confidence: 'medium',
      exact_item_hypothesis: 'L01 Motorcycle Jacket',
      exact_match_confidence: 'medium',
      distinctive_features: ['asymmetric zipper', 'belted hem'],
    }, 'apparel'],
    [{ item_type: 'bag', subtype: 'tote', primary_color: 'brown', material_estimate: 'leather' }, 'bags'],
    [{ item_type: 'footwear', subtype: 'ankle boots', primary_color: 'black' }, 'footwear'],
    [{ item_type: 'accessory', subtype: 'belt', primary_color: 'black' }, 'accessories'],
    [{ item_type: 'top', subtype: 'knit sweater', primary_color: 'cream' }, 'general'],
  ];

  for (const [raw, route] of fixtures) {
    const gated = gate({ ...raw });
    const common = {
      identification: gated.identification,
      categoryRoute: route,
      detailLevel: 'specific' as const,
      qualityBand: gated.qualityBand,
    };
    const off = buildCategoryCommerceQueries(common);
    const alsoOff = buildCategoryCommerceQueries({ ...common, commerceIdentity: undefined });

    assertEquals(alsoOff.primary, off.primary, `primary drifted for ${route}`);
    assertEquals(alsoOff.fallback, off.fallback, `fallback drifted for ${route}`);
    assertEquals(off.strategy, undefined);
    assertEquals(off.identityTerms, undefined);
  }
});

Deno.test('FLAG OFF: buildWeightedCommerceQueries is unchanged without identity', () => {
  const gated = gate({
    ...MOTO_BASE,
    brand_guess: 'Saint Laurent',
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  });

  for (const detailLevel of ['specific', 'moderate', 'broad'] as const) {
    for (const relevanceRoute of [undefined, 'apparel' as const]) {
      const base = { identification: gated.identification, detailLevel, relevanceRoute };
      const off = buildWeightedCommerceQueries(base);
      const alsoOff = buildWeightedCommerceQueries({ ...base, commerceIdentity: undefined });
      assertEquals(alsoOff, off);
      assertEquals(off.strategy, undefined);
    }
  }

  // The legacy (non-relevance) paths never consume identity at all.
  const legacy = buildWeightedCommerceQueries({
    identification: gated.identification,
    detailLevel: 'specific',
    commerceIdentity: gated.commerceIdentity,
  });
  const legacyOff = buildWeightedCommerceQueries({
    identification: gated.identification,
    detailLevel: 'specific',
  });
  assertEquals(legacy, legacyOff);
});

// ── I. Retrieval topology is untouched ───────────────────────────────────────

Deno.test('v125 changes query content only: no fan-out, timeout, or order change', async () => {
  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

  // Exactly one Gemini call site, as before.
  assertEquals((index.match(/:generateContent/g) ?? []).length, 1);

  // One primary query assignment and one fallback assignment — no fan-out.
  assertEquals((router.match(/query = weighted\.primary/g) ?? []).length, 1);
  assertEquals((router.match(/fallbackQuery = weighted\.fallback/g) ?? []).length, 1);

  // The retrieval flag must not reach provider selection, thresholds, or timeouts.
  for (
    const forbidden of [
      'SUFFICIENT_THRESHOLD',
      'PROVIDER_TIMEOUT_MS',
      'searchFarfetchProducts',
      'searchKicksCrewProducts',
      'getShoppingResults',
    ]
  ) {
    assert(
      !new RegExp(`commerceRetrievalEnabled[\\s\\S]{0,200}${forbidden}`).test(router),
      `retrieval flag influences ${forbidden}`,
    );
  }

  // No provider is named in the query builder — retailer neutrality.
  const queriesSrc = await Deno.readTextFile(
    new URL('./commerceRelevanceQueries.ts', import.meta.url),
  );
  for (const retailer of ['Farfetch', 'KicksCrew', 'Serper', 'Brave', 'farfetch', 'kickscrew']) {
    assert(!queriesSrc.includes(retailer), `query builder names retailer ${retailer}`);
  }
});

Deno.test('privacy: v125 telemetry carries the version and route, never the query', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = index.indexOf('commerce_retrieval_version=%s');
  assert(start > 0, 'v125 telemetry line is missing');
  const block = index.slice(start, start + 400);

  assert(block.includes('COMMERCE_RETRIEVAL_VERSION'));
  for (const leak of ['weighted.primary', 'query,', 'commerceIdentity?.brand']) {
    assert(!block.includes(leak), `v125 telemetry leaks ${leak}`);
  }
});
