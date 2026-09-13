/**
 * Explicit-attribute strength: elevate the match, never suppress the market.
 *
 * Continuation brief sections 10-16. Every assertion runs the REAL ranking
 * authority over the nine committed fixtures; nothing here re-implements a
 * score or asserts against a mock.
 *
 * The product rule under test is an ASYMMETRY:
 *
 *   "no leather"  -> a negative exclusion, and a Stage A removal.
 *   "only black"  -> a positive request, and a RANKING change only.
 *
 * A positive request of any strength must never become a disguised exclusion.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));

const {
  buildShoppingIntent,
  parseContextContributions,
  shoppingIntentFingerprint,
  normalizeAttributeStrength,
} = edge('commerceShoppingIntent.ts');
const {
  CTX_EXPLICIT_ATTRIBUTE_MATCH,
  CTX_EXPLICIT_ATTRIBUTE_MISS,
  CTX_STRONG_EXPLICIT_ATTRIBUTE_MATCH,
  scoreContextualFit,
} = edge('commerceContextualRanking.ts');
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');

const { runFixture, runAll } = require(path.join(ROOT, 'tools/activation/rankingBaseline.js'));
const { FIXTURES, ID_BOOT, U_BLACK_WEAK_LAST } = require(
  path.join(ROOT, 'tools/activation/attributeStrengthFixtures.js'),
);
const BEFORE = require(path.join(ROOT, 'tools/activation/rankingBaseline.json'));

const byId = (id) => FIXTURES.find((f) => f.id === id);
const beforeById = (id) => BEFORE.find((f) => f.id === id);
const order = (result) => result.top5.map((p) => p.id);
const scoreOf = (result, id) => result.top5.find((p) => p.id === id)?.score ?? null;

const intentFor = (contribution) =>
  buildShoppingIntent(parseContextContributions([contribution]), null);

// ── The tier contract ──────────────────────────────────────────────────────

test('an absent, unknown or malformed strength degrades to ordinary preference', () => {
  for (const raw of [undefined, null, '', 'STRONG', 'strong_explicit_preference', 42, {}, [], true]) {
    assert.equal(
      normalizeAttributeStrength(raw),
      'EXPLICIT_PREFERENCE',
      `${JSON.stringify(raw)} must not buy extra ranking weight`,
    );
  }
  assert.equal(
    normalizeAttributeStrength('STRONG_EXPLICIT_PREFERENCE'),
    'STRONG_EXPLICIT_PREFERENCE',
  );
});

test('strength is carried only on a USER_EXPLICIT field', () => {
  const explicit = intentFor({ provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' });
  assert.equal(explicit.color.strength, 'STRONG_EXPLICIT_PREFERENCE');

  // A Closet or Signature Style contribution describes the customer's wardrobe,
  // not an instruction they gave, so it cannot carry emphasis.
  for (const provenance of ['CLOSET', 'SIGNATURE_STYLE', 'SCANNER', 'PACKING', 'CONCIERGE', 'DERIVED']) {
    const other = intentFor({ provenance, color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' });
    assert.equal(other.color.strength, undefined, `${provenance} must not carry strength`);
  }
});

test('a later non-explicit write of the same axis cannot inherit the emphasis', () => {
  const intent = buildShoppingIntent(
    parseContextContributions([
      { provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
      { provenance: 'USER_EXPLICIT', color: 'red' },
    ]),
    null,
  );
  // The later explicit instruction wins the value, and it was an ordinary ask.
  assert.equal(intent.color.value, 'red');
  assert.equal(intent.color.strength, 'EXPLICIT_PREFERENCE');
});

// ── Elevation, not suppression ─────────────────────────────────────────────

test('a stronger ask raises the MATCH and leaves the MISS penalty untouched', () => {
  assert.ok(
    CTX_STRONG_EXPLICIT_ATTRIBUTE_MATCH > CTX_EXPLICIT_ATTRIBUTE_MATCH,
    'a strong request must elevate further',
  );
  // There is deliberately no second, harsher miss constant. A positive request
  // must not be able to push a non-matching candidate further down.
  const universe = U_BLACK_WEAK_LAST;
  const ordinary = intentFor({ provenance: 'USER_EXPLICIT', color: 'black' });
  const strong = intentFor({ provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' });

  for (const product of universe) {
    const a = scoreContextualFit(product, ordinary);
    const b = scoreContextualFit(product, strong);
    if (a.facts.includes('explicit_color_match')) {
      assert.ok(b.delta > a.delta, `${product.id}: a match must rise`);
    } else {
      assert.equal(b.delta, a.delta, `${product.id}: a non-match must not fall`);
      assert.equal(a.delta, CTX_EXPLICIT_ATTRIBUTE_MISS, 'the miss penalty is the shared, existing one');
    }
  }
});

test('F01 vs F04: the same universe, and the strength changes the answer', () => {
  const ordinary = runFixture(byId('F01_ordinary_black_boot'));
  const strong = runFixture(byId('F04_strong_only_black'));

  assert.deepEqual(
    ordinary.universe,
    strong.universe,
    'the differentiation claim is only meaningful over one candidate set',
  );
  assert.notDeepEqual(
    order(ordinary),
    order(strong),
    'section 13: the strength mechanism must not be a no-op',
  );

  // Ordinary: three better-fitting alternatives stay ahead of a weaker match.
  assert.equal(order(ordinary)[3], 'u1_black_weaker', 'a high-quality alternative remains competitive');
  // Strong: the viable match takes the top slot.
  assert.equal(order(strong)[0], 'u1_black_weaker', 'a strong ask elevates the match to first');
});

test('elevation costs the alternatives nothing: every non-matching score is identical', () => {
  const ordinary = runFixture(byId('F01_ordinary_black_boot'));
  const strong = runFixture(byId('F04_strong_only_black'));
  for (const id of ['u1_burgundy_chelsea', 'u1_brown_chelsea', 'u1_tan_chelsea']) {
    assert.equal(
      scoreOf(strong, id),
      scoreOf(ordinary, id),
      `${id}: "only black" must not push a brown boot down`,
    );
  }
});

test('nothing is ever removed for failing a positive preference', () => {
  for (const fixture of FIXTURES) {
    const result = runFixture(fixture);
    const before = beforeById(fixture.id);
    assert.equal(
      result.kept,
      before.kept,
      `${fixture.id}: a colour preference must not change how many candidates survive`,
    );
  }
});

test('the ordinary tier is unchanged from the committed pre-change baseline', () => {
  // Section 12: the smallest change that produces the sanctioned differentiation.
  // Ordinary requests were not retuned, so they must still order identically.
  for (const id of ['F01_ordinary_black_boot', 'F02_ordinary_red_jacket', 'F03_ordinary_navy_dress']) {
    const now = runFixture(byId(id));
    const before = beforeById(id);
    assert.deepEqual(order(now), order(before), `${id}: ordinary behaviour is untouched`);
    for (const product of now.top5) {
      assert.equal(product.score, scoreOf(before, product.id), `${id}/${product.id}: score unchanged`);
    }
  }
});

// ── The asymmetry against a real exclusion ─────────────────────────────────

test('a NEGATIVE exclusion still removes, which a positive request never does', () => {
  const excluded = buildShoppingIntent(
    parseContextContributions([
      { provenance: 'USER_EXPLICIT', exclusions: [{ axis: 'color', token: 'brown' }] },
    ]),
    null,
  );
  const res = filterAndDedupeProducts(U_BLACK_WEAK_LAST, ID_BOOT, {
    enabled: true,
    categoryRoute: 'footwear',
    shoppingContext: excluded,
    requestActorId: null,
  });
  const ids = res.products.map((p) => p.id);
  assert.equal(ids.includes('u1_brown_chelsea'), false, '"no brown" removes brown');
  assert.ok(ids.length > 0, 'and leaves the rest of the market');

  // "Only black" is NOT "no brown": the brown boot survives a strong positive ask.
  const strong = runFixture(byId('F04_strong_only_black'));
  assert.ok(order(strong).includes('u1_brown_chelsea'), '"only black" keeps the brown boot');
});

// ── Quality floor (section 14) ─────────────────────────────────────────────

test('a matching but unusable listing cannot take the top slot on a tie', () => {
  const result = runFixture(byId('F08_quality_floor_black_unusable'));
  const ids = order(result);
  const good = ids.indexOf('u5_black_good');
  const unusable = ids.indexOf('u5_black_unusable');

  assert.ok(good >= 0 && unusable >= 0, 'both remain on the shelf; neither is hidden');
  assert.ok(good < unusable, 'between two equals, the buyable one leads');
  assert.equal(ids[0], 'u5_black_good', 'colour match alone cannot buy the top slot');

  // The floor is a TIE-BREAK, not a score term: the two still score the same.
  assert.equal(
    scoreOf(result, 'u5_black_good'),
    scoreOf(result, 'u5_black_unusable'),
    'commercial usability still contributes zero to the ranking score',
  );
});

test('usability never reorders candidates the ranker scored differently', () => {
  const result = runFixture(byId('F08_quality_floor_black_unusable'));
  const scores = result.top5.map((p) => p.score);
  const sorted = [...scores].sort((a, b) => b - a);
  assert.deepEqual(scores, sorted, 'the shelf is still ordered by the one score');
});

test('a strong preference does not promote a candidate over a genuinely better one on quality alone', () => {
  // F08 pairs the unusable match against real alternatives: the unusable listing
  // outranks the brown boots only because the SCORE says so, and it is never
  // lifted above the buyable black it ties with.
  const result = runFixture(byId('F08_quality_floor_black_unusable'));
  assert.equal(order(result)[1], 'u5_black_unusable');
  assert.ok(scoreOf(result, 'u5_black_unusable') > scoreOf(result, 'u5_tan_chelsea'));
});

// ── Sparse and absent matches ──────────────────────────────────────────────

test('a sparse preferred attribute elevates the one viable match and keeps alternatives', () => {
  const result = runFixture(byId('F07_sparse_single_black'));
  assert.equal(order(result)[0], 'u4_black_chelsea');
  assert.equal(result.kept, 4, 'the alternatives are still there to choose from');
});

test('no matching candidate is not a no-results state, and invents nothing', () => {
  const result = runFixture(byId('F09_no_black_candidate'));
  assert.equal(result.kept, 3, 'useful alternatives are returned');
  assert.equal(
    order(result).some((id) => id.includes('black')),
    false,
    'a preference cannot conjure a black candidate',
  );
  for (const product of result.top5) {
    assert.equal(
      product.factCodes.includes('explicit_color_match'),
      false,
      'and nothing is labelled as matching a colour it does not have',
    );
  }
});

// ── Cache fingerprint (section 15) ─────────────────────────────────────────

test('strength is part of the intent fingerprint', () => {
  const ordinary = shoppingIntentFingerprint(intentFor({ provenance: 'USER_EXPLICIT', color: 'black' }));
  const strong = shoppingIntentFingerprint(
    intentFor({ provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' }),
  );
  assert.notEqual(ordinary, strong, '"black boots" and "only black" must not share a cache entry');
  assert.match(strong, /STRONG/);
});

test('an ordinary request keeps the exact fingerprint it had before strength existed', () => {
  // Only a STRONG strength is appended, so the default value adds no bytes.
  const withDefault = shoppingIntentFingerprint(
    intentFor({ provenance: 'USER_EXPLICIT', color: 'black', colorStrength: 'EXPLICIT_PREFERENCE' }),
  );
  const withNothing = shoppingIntentFingerprint(intentFor({ provenance: 'USER_EXPLICIT', color: 'black' }));
  assert.equal(withDefault, withNothing);
  assert.equal(withDefault, 'col:USER_EXPLICIT:black');
});

test('a zero-context request still has an empty fingerprint', () => {
  assert.equal(shoppingIntentFingerprint(null), '');
  assert.equal(shoppingIntentFingerprint(buildShoppingIntent([], null)), '');
});

// ── Zero-context equality (section 29) ─────────────────────────────────────

test('with no shopping context the shelf and its order are untouched', () => {
  const withoutContext = filterAndDedupeProducts(U_BLACK_WEAK_LAST, ID_BOOT, {
    enabled: true,
    categoryRoute: 'footwear',
  });
  // Provider order still decides ties on the cold path: the usability tie-break
  // is gated on an intent, so Scanner behaviour is byte-identical.
  assert.equal(withoutContext.stats.contextualApplied, false);
  assert.equal(withoutContext.stats.rationale, undefined);
  for (const product of withoutContext.products) {
    assert.equal(product.commerceRationale, undefined, 'no contextual metadata leaks onto a cold request');
  }
});

test('the unusable listing keeps its provider position when there is no context', () => {
  const { U_BLACK_UNUSABLE_FIRST } = require(path.join(ROOT, 'tools/activation/attributeStrengthFixtures.js'));
  const cold = filterAndDedupeProducts(U_BLACK_UNUSABLE_FIRST, ID_BOOT, {
    enabled: true,
    categoryRoute: 'footwear',
  });
  const ids = cold.products.map((p) => p.id);
  assert.ok(
    ids.indexOf('u5_black_unusable') < ids.indexOf('u5_black_good'),
    'the cold path is unchanged: provider order still breaks the tie',
  );
});

// ── The committed evidence stays honest ────────────────────────────────────

test('the committed after-state matches what the ranker actually does now', () => {
  const after = require(path.join(ROOT, 'tools/activation/rankingAfter.json'));
  const live = runAll();
  assert.deepEqual(
    live.map((r) => ({ id: r.id, kept: r.kept, order: order(r) })),
    after.map((r) => ({ id: r.id, kept: r.kept, order: order(r) })),
    'tools/activation/rankingAfter.json is stale — re-run with --write-after',
  );
});
