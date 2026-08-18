/**
 * Commerce Identity Evidence (v124) — focused Deno tests.
 *
 * Fixture-based; does not claim production accuracy. The Saint Laurent L01 case
 * is the audit's deterministic ranking probe, kept here as a permanent
 * regression so the identity-loss defect cannot return silently.
 */
import { assert, assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import {
  COMMERCE_IDENTITY_DEFAULT_ENABLED,
  COMMERCE_IDENTITY_VERSION,
  identityConfidenceRank,
  isCommerceIdentityEnabled,
  MAX_DISTINCTIVE_FEATURES,
  normalizeIdentityConfidence,
} from './commerceIdentityConfig.ts';
import {
  applyScannerQualityGate,
  type CommerceIdentityEvidence,
} from './scannerQualityGate.ts';
import {
  AGREEMENT_DOMINANT_COLOR,
  IDENTITY_EXACT_MATCH_PLAUSIBLE,
  PENALTY_IDENTITY_BRAND_MISMATCH_WEAK,
  scoreCommercialIdentity,
  scoreProductAgreement,
} from './commerceRelevanceAgreement.ts';
import { buildWeightedCommerceQueries, filterAndDedupeProducts } from './qualityTuneCommerce.ts';
import { buildCategoryCommerceQueries } from './commerceRelevanceQueries.ts';
import { assertQualityMetricsPrivacy, buildQualityTuneMetrics } from './qualityTuneTelemetry.ts';
import type { RecommendedProduct } from './shoppingProvider.ts';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function product(
  partial: Partial<RecommendedProduct> & { title: string; productUrl: string },
): RecommendedProduct {
  return {
    id: partial.id || `id-${partial.title.slice(0, 12)}`,
    title: partial.title,
    source: partial.source || 'RetailerA',
    price: partial.price ?? '$1,200',
    type: partial.type || 'retail',
    imageUrl: partial.imageUrl ?? 'https://cdn.example-shop.test/img.jpg',
    productUrl: partial.productUrl,
    ...(partial.brand ? { brand: partial.brand } : {}),
  };
}

/** The scanned moto jacket from the audit probe. */
function motoGarment(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    item_type: 'outerwear',
    subtype: 'moto jacket',
    primary_color: 'black',
    material_estimate: 'leather',
    silhouette: 'cropped',
    fit: 'slim',
    pattern: 'solid',
    distinctive_features: ['asymmetric zipper', 'silver-tone hardware', 'belted hem'],
    brand_guess: 'Saint Laurent',
    ...extra,
  };
}

const CANDIDATE_A = product({
  title: 'Saint Laurent L01 Leather Motorcycle Jacket',
  productUrl: 'https://shop-a.test/p/l01',
});
const CANDIDATE_B = product({
  title: 'Black Cropped Faux Leather Moto Jacket',
  productUrl: 'https://shop-b.test/p/moto',
});
const CANDIDATE_C = product({
  title: 'Black Leather Biker Jacket',
  productUrl: 'https://shop-c.test/p/biker',
});

function rank(
  candidates: RecommendedProduct[],
  garment: Record<string, unknown>,
  identity?: CommerceIdentityEvidence,
): { title: string; score: number }[] {
  return candidates
    .map((p) => ({ title: p.title, score: scoreProductAgreement(p, garment, null, identity).score }))
    .sort((a, b) => b.score - a.score);
}

function gate(identification: Record<string, unknown>) {
  return applyScannerQualityGate(identification, undefined, { commerceIdentityEnabled: true });
}

// ── A. Flag semantics ────────────────────────────────────────────────────────

Deno.test('v124 flag: version, default, and env override semantics', () => {
  assertEquals(COMMERCE_IDENTITY_VERSION, 'v124');
  assertEquals(isCommerceIdentityEnabled(() => undefined), COMMERCE_IDENTITY_DEFAULT_ENABLED);
  assertEquals(isCommerceIdentityEnabled(() => 'true'), true);
  assertEquals(isCommerceIdentityEnabled(() => 'ON'), true);
  assertEquals(isCommerceIdentityEnabled(() => '1'), true);
  assertEquals(isCommerceIdentityEnabled(() => 'false'), false);
  assertEquals(isCommerceIdentityEnabled(() => 'off'), false);
  assertEquals(isCommerceIdentityEnabled(() => '0'), false);
  // Unrecognized values fall back to the compiled default rather than guessing.
  assertEquals(isCommerceIdentityEnabled(() => 'maybe'), COMMERCE_IDENTITY_DEFAULT_ENABLED);
});

// ── B. Bounded confidence vocabulary ─────────────────────────────────────────

Deno.test('confidence: bounded vocabulary; malformed values normalize to null', () => {
  assertEquals(normalizeIdentityConfidence('high'), 'high');
  assertEquals(normalizeIdentityConfidence('  MEDIUM '), 'medium');
  assertEquals(normalizeIdentityConfidence('Moderate'), 'medium');
  assertEquals(normalizeIdentityConfidence('low'), 'low');

  for (const bad of [0.9, 1, null, undefined, {}, [], true, '', 'very high indeed', 'HIGHLY']) {
    assertEquals(
      normalizeIdentityConfidence(bad as unknown),
      null,
      `expected null for ${String(bad)}`,
    );
  }
  // Prose is rejected outright rather than being coerced to a grade.
  assertEquals(normalizeIdentityConfidence('pretty sure it is Saint Laurent'), null);

  assert(identityConfidenceRank('high') > identityConfidenceRank('medium'));
  assert(identityConfidenceRank('medium') > identityConfidenceRank('low'));
  assert(identityConfidenceRank('low') > identityConfidenceRank(null));
});

// ── C. Quality gate: graded evidence instead of destruction ──────────────────

Deno.test('quality gate: VERIFIED / PLAUSIBLE / WEAK / INVALID grading', () => {
  // VERIFIED — a wordmark was actually read off the garment.
  const verified = gate(
    motoGarment({ visible_brand_text: 'Saint Laurent', brand_confidence: 'low' }),
  );
  assertEquals(verified.commerceIdentity?.brandGrade, 'verified');
  // The model cannot downgrade evidence it demonstrably has.
  assertEquals(verified.commerceIdentity?.brandConfidence, 'high');

  // VERIFIED via logo, no readable text.
  const logo = gate(motoGarment({ logo_detected: true }));
  assertEquals(logo.commerceIdentity?.brandGrade, 'verified');

  // PLAUSIBLE — declared medium, supported by distinctive construction.
  const plausible = gate(motoGarment({ brand_confidence: 'medium' }));
  assertEquals(plausible.commerceIdentity?.brandGrade, 'plausible');
  assertEquals(plausible.commerceIdentity?.brand, 'Saint Laurent');
  // Capped at medium: without a wordmark the model cannot self-certify to high.
  assertEquals(plausible.commerceIdentity?.brandConfidence, 'medium');
  const selfCertified = gate(motoGarment({ brand_confidence: 'high' }));
  assertEquals(selfCertified.commerceIdentity?.brandGrade, 'plausible');
  assertEquals(selfCertified.commerceIdentity?.brandConfidence, 'medium');

  // WEAK — declared low, or medium with nothing supporting it.
  const weak = gate(motoGarment({ brand_confidence: 'low', distinctive_features: [] }));
  assertEquals(weak.commerceIdentity?.brandGrade, 'weak');
  assertEquals(weak.commerceIdentity?.brand, 'Saint Laurent');
  const unsupported = gate(motoGarment({ brand_confidence: 'medium', distinctive_features: [] }));
  assertEquals(unsupported.commerceIdentity?.brandGrade, 'weak');

  // INVALID — the existing speculative-noise rules still remove the value.
  for (const noise of ['Saint Laurent style', 'designer-looking', 'Gucci-inspired', 'luxury']) {
    const invalid = gate(motoGarment({ brand_guess: noise, brand_confidence: 'high' }));
    assertEquals(invalid.commerceIdentity?.brandGrade, 'invalid', `expected invalid for "${noise}"`);
    assertEquals(invalid.commerceIdentity?.brand, null);
  }
  // Prose masquerading as a brand is rejected on length.
  const tooLong = gate(motoGarment({ brand_guess: 'x'.repeat(120) }));
  assertEquals(tooLong.commerceIdentity?.brandGrade, 'invalid');
});

Deno.test('quality gate: exact-item hypothesis preserved and graded, never inflated', () => {
  const g = gate(motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  }));
  assertEquals(g.commerceIdentity?.exactItemHypothesis, 'L01 Motorcycle Jacket');
  assertEquals(g.commerceIdentity?.exactMatchGrade, 'plausible');

  // 'verified' requires verified brand evidence AND a declared high confidence.
  const withWordmark = gate(motoGarment({
    visible_brand_text: 'Saint Laurent',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'high',
  }));
  assertEquals(withWordmark.commerceIdentity?.exactMatchGrade, 'verified');

  // High confidence without verified brand evidence cannot reach 'verified'.
  const noWordmark = gate(motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'high',
  }));
  assertEquals(noWordmark.commerceIdentity?.exactMatchGrade, 'plausible');

  // Absent / unknown hypothesis is honoured as absent, not invented.
  for (const absent of [undefined, '', 'unknown', 'n/a', null]) {
    const g2 = gate(motoGarment({ exact_item_hypothesis: absent, exact_match_confidence: 'high' }));
    assertEquals(g2.commerceIdentity?.exactItemHypothesis, null);
    assertEquals(g2.commerceIdentity?.exactMatchGrade, 'invalid');
  }
});

Deno.test('quality gate: distinctive features preserved, bounded, and de-noised', () => {
  const many = Array.from({ length: 20 }, (_, i) => `panel detail ${i}`);
  const g = gate(motoGarment({
    distinctive_features: [
      'asymmetric zipper',
      'asymmetric zipper',
      'silver-tone hardware',
      'luxury designer vibes',
      42,
      'x'.repeat(200),
      ...many,
    ],
  }));
  const features = g.commerceIdentity?.distinctiveFeatures ?? [];
  assert(features.includes('asymmetric zipper'));
  assert(features.includes('silver-tone hardware'));
  // Marketing filler, duplicates, non-strings, and overlong prose are dropped.
  assert(!features.some((f) => /luxury|designer/i.test(f)));
  assertEquals(features.filter((f) => f === 'asymmetric zipper').length, 1);
  assert(features.length <= MAX_DISTINCTIVE_FEATURES);
});

// ── D. The proven regression fixture ─────────────────────────────────────────

Deno.test('REGRESSION: Saint Laurent L01 outranks generic moto jackets under supported identity', () => {
  const g = gate(motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  }));
  const identity = g.commerceIdentity!;
  assertEquals(identity.brandGrade, 'plausible');
  assertEquals(identity.exactMatchGrade, 'plausible');

  const candidates = [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C];

  // Before: the audit's demonstrated defect — the real item ranks last.
  const before = rank(candidates, g.identification);
  assertEquals(before[before.length - 1].title, CANDIDATE_A.title);

  // After: identity evidence promotes the actual commercial item.
  const after = rank(candidates, g.identification, identity);
  assertEquals(after[0].title, CANDIDATE_A.title);
  const scoreOf = (t: string) => after.find((r) => r.title === t)!.score;
  assert(scoreOf(CANDIDATE_A.title) > scoreOf(CANDIDATE_B.title));
  assert(scoreOf(CANDIDATE_A.title) > scoreOf(CANDIDATE_C.title));
});

Deno.test('REGRESSION: a LOW-confidence unsupported brand must NOT force the branded item to the top', () => {
  const g = gate(motoGarment({ brand_confidence: 'low', distinctive_features: [] }));
  const identity = g.commerceIdentity!;
  assertEquals(identity.brandGrade, 'weak');

  const candidates = [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C];
  const before = rank(candidates, g.identification);
  const after = rank(candidates, g.identification, identity);

  // A weak guess is near-inert: the ordering that category/subtype/colour
  // agreement produced must survive it.
  assertEquals(after.map((r) => r.title), before.map((r) => r.title));
  assert(after[0].title !== CANDIDATE_A.title);

  const aBefore = before.find((r) => r.title === CANDIDATE_A.title)!.score;
  const aAfter = after.find((r) => r.title === CANDIDATE_A.title)!.score;
  assert(aAfter - aBefore <= 5, `weak brand moved the score by ${aAfter - aBefore}`);
});

Deno.test('ranking safety: exact model agreement outweighs repeating a colour adjective', () => {
  assert(IDENTITY_EXACT_MATCH_PLAUSIBLE > AGREEMENT_DOMINANT_COLOR);
});

Deno.test('ranking safety: brand mismatch scales with evidence strength', () => {
  const rival = product({
    title: 'Leather Motorcycle Jacket',
    productUrl: 'https://shop-d.test/p/rival',
    brand: 'Acme Leathers',
  });

  const verified = gate(motoGarment({ visible_brand_text: 'Saint Laurent' })).commerceIdentity!;
  const weak = gate(motoGarment({ brand_confidence: 'low', distinctive_features: [] }))
    .commerceIdentity!;

  const verifiedMismatch = scoreCommercialIdentity(rival, verified);
  const weakMismatch = scoreCommercialIdentity(rival, weak);

  assert(verifiedMismatch.brandMismatched);
  assert(verifiedMismatch.delta < 0, 'verified mismatch should meaningfully reduce the candidate');
  assertEquals(weakMismatch.brandMismatched, true);
  assertEquals(weakMismatch.delta, PENALTY_IDENTITY_BRAND_MISMATCH_WEAK);

  // A listing that declares no brand at all is not evidence of conflict.
  const untitled = product({
    title: 'Leather Motorcycle Jacket',
    productUrl: 'https://shop-e.test/p/x',
  });
  assertEquals(scoreCommercialIdentity(untitled, verified).brandMismatched, false);
});

// ── E. Provider brand normalization ──────────────────────────────────────────

Deno.test('provider brand survives normalization and feeds identity matching', () => {
  const identity = gate(motoGarment({ brand_confidence: 'medium' })).commerceIdentity!;

  // Brand carried only in the provider field — the title never names it.
  const providerBranded = product({
    title: 'L01 Leather Motorcycle Jacket',
    productUrl: 'https://shop-f.test/p/l01',
    brand: 'Saint Laurent',
  });
  assert(scoreCommercialIdentity(providerBranded, identity).brandMatched);

  const noBrand = product({
    title: 'L01 Leather Motorcycle Jacket',
    productUrl: 'https://shop-g.test/p/l01',
  });
  assertEquals(scoreCommercialIdentity(noBrand, identity).brandMatched, false);
});

Deno.test('providers extract brand from provider payloads only, never from titles', async () => {
  // Phase 3: Farfetch3 and KicksCrew are URL-driven enrichment adapters
  // (farfetch3Provider.ts / kicksCrewProvider.ts), not keyword-search
  // adapters — the retired farfetchProvider.ts no longer exists. The
  // underlying guarantee this test protects is unchanged: brand comes only
  // from a provider-declared field, never derived from title or retailer.
  const farfetch = await Deno.readTextFile(new URL('./farfetch3Provider.ts', import.meta.url));
  const kickscrew = await Deno.readTextFile(new URL('./kicksCrewProvider.ts', import.meta.url));
  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));

  // Both specialized providers read and carry a provider-declared brand field.
  assert(/const brandField = data\.brand as/.test(farfetch));
  assert(/const brand = str\(brandField\?\.name\)/.test(farfetch));
  assert(/const brand = str\(product\.vendor\)/.test(kickscrew));
  assert(farfetch.includes('...(brand ? { brand } : {})'));
  assert(kickscrew.includes('...(brand ? { brand } : {})'));

  // The router boundary that previously discarded it now forwards it, gated.
  assert(router.includes('includeBrand && p.brand'));
  assert(router.includes('normalizeToRecommendedProduct(p, identityEnabled)'));

  // Brand is never taken from retailer identity.
  assert(!/brand:\s*(p\.)?source/.test(router));
  assert(!/const brand = str\(brandField\?\.name\)[\s\S]{0,400}\.(source|retailer)\b/.test(farfetch));
});

// ── F. Retailer neutrality ───────────────────────────────────────────────────

Deno.test('retailer neutrality: the provider that returned a listing never scores', () => {
  const identity = gate(motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  })).commerceIdentity!;
  const garment = motoGarment();

  const base = {
    title: CANDIDATE_A.title,
    productUrl: 'https://shop-h.test/p/l01',
    brand: 'Saint Laurent',
  };
  const scores = ['Farfetch', 'KicksCrew', 'Poshmark', 'Serper', 'Brave', 'RetailerA'].map((source) =>
    scoreProductAgreement(product({ ...base, source }), garment, null, identity).score
  );
  assertEquals(new Set(scores).size, 1, 'retailer identity changed the score');

  const agreementSource = Deno.readTextFileSync(
    new URL('./commerceRelevanceAgreement.ts', import.meta.url),
  );
  // The identity scorer must not read the retailer fields at all.
  const identityBlock = agreementSource.slice(
    agreementSource.indexOf('export function scoreCommercialIdentity'),
  );
  assert(!/\.source\b/.test(identityBlock));
  assert(!/\.retailer\b/.test(identityBlock));
});

// ── G. Existing protections still hold ───────────────────────────────────────

Deno.test('existing penalties survive: category conflict and unsafe URLs', () => {
  const identity = gate(motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  })).commerceIdentity!;
  const garment = motoGarment();

  // A branded bag is still a clear category conflict against a jacket scan.
  const bagVsJacket = scoreProductAgreement(
    product({
      title: 'Saint Laurent L01 Leather Tote Handbag',
      productUrl: 'https://shop-k.test/p/bag',
      brand: 'Saint Laurent',
    }),
    garment,
    null,
    identity,
  );
  assert(bagVsJacket.clearCategoryConflict, 'category conflict detection was weakened');

  // Malformed / unsafe destinations stay rejected even for the identity match.
  const good = scoreProductAgreement(
    product({
      title: CANDIDATE_A.title,
      productUrl: 'https://shop-l.test/p/l01',
      brand: 'Saint Laurent',
    }),
    garment,
    null,
    identity,
  );
  for (const bad of ['not-a-url', 'http://localhost/p/1', 'https://example.com/p/1']) {
    const r = scoreProductAgreement(
      product({ title: CANDIDATE_A.title, productUrl: bad, brand: 'Saint Laurent' }),
      garment,
      null,
      identity,
    );
    assert(r.score < good.score, `unsafe URL "${bad}" was not penalized`);
  }
});

// ── H. Query builder invariance (hard v124 boundary) ─────────────────────────

Deno.test('QUERY INVARIANCE: identity evidence never reaches commerce query construction', () => {
  const plain = motoGarment();
  const withIdentity = motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  });

  for (const detailLevel of ['specific', 'moderate', 'broad'] as const) {
    const a = buildWeightedCommerceQueries({ identification: plain, detailLevel });
    const b = buildWeightedCommerceQueries({ identification: withIdentity, detailLevel });
    assertEquals(b, a, `weighted queries changed at detailLevel=${detailLevel}`);

    const ca = buildCategoryCommerceQueries({
      identification: plain,
      categoryRoute: 'apparel',
      detailLevel,
    });
    const cb = buildCategoryCommerceQueries({
      identification: withIdentity,
      categoryRoute: 'apparel',
      detailLevel,
    });
    assertEquals(cb, ca, `category queries changed at detailLevel=${detailLevel}`);
  }

  // Neither the hypothesis nor the confidence vocabulary leaks into a query.
  const q = buildCategoryCommerceQueries({
    identification: withIdentity,
    categoryRoute: 'apparel',
    detailLevel: 'specific',
  });
  for (const text of [q.primary, q.fallback]) {
    assert(!/l01/i.test(text), `hypothesis leaked into query: ${text}`);
    assert(!/\b(medium|high|low)\b/i.test(text), `confidence leaked into query: ${text}`);
  }
});

Deno.test('QUERY INVARIANCE: raw identity fields never reach the query module', async () => {
  // v125 deliberately lets the query builder consume identity — but only the
  // *graded* envelope, passed explicitly. Reading the raw model fields would
  // bypass the quality gate's VERIFIED/PLAUSIBLE/WEAK/INVALID grading, which is
  // the whole protection against a weak guess steering retrieval.
  const queries = await Deno.readTextFile(
    new URL('./commerceRelevanceQueries.ts', import.meta.url),
  );
  for (
    const forbidden of [
      'exact_item_hypothesis',
      'brand_confidence',
      'exact_match_confidence',
    ]
  ) {
    assert(
      !queries.includes(forbidden),
      `commerceRelevanceQueries.ts reads raw ${forbidden} instead of the graded envelope`,
    );
  }
  // Retailer neutrality: no provider may be named in query construction.
  for (const retailer of ['Farfetch', 'KicksCrew', 'Serper', 'Brave']) {
    assert(!queries.includes(retailer), `commerceRelevanceQueries.ts names retailer ${retailer}`);
  }
});

// ── I. Flag-off equivalence ──────────────────────────────────────────────────

Deno.test('FLAG OFF: quality gate result is identical to v123', () => {
  const raw = motoGarment({
    brand_confidence: 'medium',
    exact_item_hypothesis: 'L01 Motorcycle Jacket',
    exact_match_confidence: 'medium',
  });
  const off = applyScannerQualityGate({ ...raw }, undefined);
  const on = applyScannerQualityGate({ ...raw }, undefined, { commerceIdentityEnabled: true });

  assertEquals(off.commerceIdentity, undefined);
  assert(on.commerceIdentity !== undefined);

  // Everything the rest of the pipeline reads is untouched — including the
  // unchanged brand suppression that keeps the query builder deterministic.
  const { commerceIdentity: _drop, ...onRest } = on;
  assertEquals(onRest, off);
  assertEquals(on.qualityScore, off.qualityScore);
  assertEquals(on.qualityBand, off.qualityBand);
  assertEquals(on.commerceQueryDetailLevel, off.commerceQueryDetailLevel);
  assertEquals(on.brandSuppressed, off.brandSuppressed);
  assertEquals(on.label, off.label);
  // The unsupported hypothesis is still removed from the client-facing shape.
  assertEquals(on.identification.brand_guess, null);
});

Deno.test('FLAG OFF: agreement score and result ordering are identical to v122', () => {
  const garment = motoGarment();
  const candidates = [CANDIDATE_A, CANDIDATE_B, CANDIDATE_C];

  for (const p of candidates) {
    const withoutIdentity = scoreProductAgreement(p, garment, null);
    const explicitUndefined = scoreProductAgreement(p, garment, null, undefined);
    assertEquals(explicitUndefined, withoutIdentity);
    assertEquals(withoutIdentity.identity, undefined);
  }

  const relevance = {
    enabled: true as const,
    categoryRoute: 'apparel' as const,
    qualityBand: 'high' as const,
  };
  const off = filterAndDedupeProducts(candidates, garment, relevance);
  const alsoOff = filterAndDedupeProducts(candidates, garment, {
    ...relevance,
    commerceIdentity: undefined,
  });
  assertEquals(alsoOff.products.map((p) => p.title), off.products.map((p) => p.title));
  assertEquals(alsoOff.stats.agreementScores, off.stats.agreementScores);
});

Deno.test('FLAG OFF: identity fields are dropped from the sanitized identification', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  // The additive allowlist exists and is gated, not unconditional.
  assert(index.includes('IDENTIFICATION_IDENTITY_STRING_KEYS'));
  assert(index.includes('if (allowCommerceIdentity) {'));
  assert(index.includes('allowCommerceIdentity = false'));
  // The v124 schema and prompt are selected only when the flag is on.
  assert(index.includes('responseSchema: commerceIdentityEnabled'));
  assert(index.includes('SELECTED_ITEM_RESPONSE_SCHEMA_V124'));
  assert(index.includes('buildSelectedItemPrompt(selectedCandidate, commerceIdentityEnabled)'));
  // Identity requires the relevance layer, matching the v121→v123 chain.
  assert(index.includes('relevanceEnabled && isCommerceIdentityEnabled()'));
});

// ── J. Additive selected-item contract ───────────────────────────────────────

Deno.test('selected-item schema: v124 is strictly additive over v123', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = index.indexOf('const SELECTED_ITEM_RESPONSE_SCHEMA_V124');
  assert(start > 0, 'v124 selected-item schema is missing');
  const block = index.slice(start, index.indexOf('const SELECTED_ITEM_COMMERCE_IDENTITY_PROMPT'));

  // Existing properties and required lists are spread, never re-declared.
  assert(block.includes('...SELECTED_ITEM_RESPONSE_SCHEMA.properties'));
  assert(block.includes('...SELECTED_ITEM_RESPONSE_SCHEMA.properties.identification.properties'));
  assert(block.includes('[...SELECTED_ITEM_RESPONSE_SCHEMA.properties.identification.required]'));
  assert(block.includes('[...SELECTED_ITEM_RESPONSE_SCHEMA.required]'));

  // Every new identity field is present and none is required.
  for (
    const field of [
      'brand_guess',
      'brand_confidence',
      'visible_brand_text',
      'logo_detected',
      'distinctive_features',
      'style_tags',
      'exact_item_hypothesis',
      'exact_match_confidence',
    ]
  ) {
    assert(block.includes(`${field}:`), `schema is missing ${field}`);
  }
  // Confidence fields are enum-bounded in the schema itself.
  assertEquals(block.match(/enum: \['low', 'medium', 'high'\]/g)?.length, 2);
});

Deno.test('selected-item prompt: bounded identity analysis without weakening privacy', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = index.indexOf('const SELECTED_ITEM_COMMERCE_IDENTITY_PROMPT');
  const block = index.slice(start, index.indexOf('function buildSelectedItemPrompt'));

  // Bounded hypothesis with an explicit permission to decline.
  assert(/Omit this field entirely/.test(block));
  assert(/Do not invent a model name/.test(block));
  assert(block.includes('"high" | "medium" | "low"'));

  // Privacy prohibitions are restated, not relaxed.
  assert(/Never identify a person/.test(block));
  assert(/protected trait/.test(block));
  assert(/Ignore the person, face, body, background/.test(block));

  // Selected-item constraint is preserved: no switching garments.
  assert(/only the selected garment/i.test(block));
});

// ── K. Privacy ───────────────────────────────────────────────────────────────

Deno.test('privacy: identity telemetry emits grades only, never model-derived text', async () => {
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));
  const start = index.indexOf('commerce_identity_version=%s');
  assert(start > 0, 'v124 telemetry line is missing');
  const block = index.slice(start, start + 600);

  assert(block.includes('brandGrade'));
  assert(block.includes('exactMatchGrade'));
  assert(block.includes('distinctiveFeatures.length'));
  // The brand string, hypothesis, and feature text are never logged.
  for (const leak of ['commerceIdentity?.brand,', 'exactItemHypothesis', 'visibleBrandText']) {
    assert(!block.includes(leak), `identity telemetry leaks ${leak}`);
  }

  // The existing scrubbed-metrics contract still holds.
  const metrics = buildQualityTuneMetrics({
    requestMode: 'selected_item',
    qualityScore: 80,
    qualityBand: 'high',
  } as never);
  assertQualityMetricsPrivacy(metrics);
});

// ── L. Retrieval boundary ────────────────────────────────────────────────────

Deno.test('v124 changes ranking only: no extra call, no provider-order change', async () => {
  const router = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  const index = await Deno.readTextFile(new URL('./index.ts', import.meta.url));

  // Provider fan-out constants are untouched by this phase.
  assert(!/commerceIdentity[\s\S]{0,200}SUFFICIENT_THRESHOLD/.test(router));
  assert(!/SUFFICIENT_THRESHOLD[\s\S]{0,200}commerceIdentity/.test(router));

  // Identity evidence reaches ranking (relevance options) and, under v125,
  // query construction. It must never reach provider selection or fan-out.
  const providerSectionStart = router.indexOf('if (isSneaker)');
  assert(providerSectionStart > 0, 'provider selection block not found');
  const providerSection = router.slice(providerSectionStart);
  assert(
    !/input\.commerceIdentity\b/.test(providerSection),
    'identity evidence is read by provider selection / fan-out',
  );
  assert(
    !/commerceRetrievalEnabled[\s\S]{0,200}searchKicksCrewProducts/.test(router),
    'retrieval flag influences provider selection',
  );

  // Exactly one Gemini generateContent call site, as before v124.
  assertEquals((index.match(/:generateContent/g) ?? []).length, 1);
});
