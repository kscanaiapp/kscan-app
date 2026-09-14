/**
 * SEC-COM-11 / SEC-COM-12 — the shared Commerce result cache must never replay
 * one customer's personalized ranking state to another.
 *
 * THE SHAPE OF THE RISK. `commerceResultCache` is a process-wide Map with no
 * actor in its key, which is correct: a cached shelf is public retailer product
 * data, and keying it per user would fragment it for no security gain. What
 * makes that safe is an exact correspondence -- EVERY input that can change
 * which candidates survive or how they order must appear in the key. A cache
 * HIT returns the stored shelf without re-running `filterAndDedupeProducts`,
 * so any ranking input missing from the key is a cross-actor influence path:
 * customer B inherits an order computed from customer A's context.
 *
 * `shoppingIntentFingerprint` states that rule in its own docstring. These
 * tests hold it to it, field by field, against the REAL edge modules.
 *
 * THE REGRESSION THIS EXISTS FOR. The Packing gap label was a ranking input
 * (`scoreContextualFit` tokenizes `gap.label` and awards
 * CTX_CONFIRMED_GAP_ALIGNMENT plus a `confirmed_gap_match` rationale fact) that
 * was NOT in the key: only gapCode and certainty were. Two customers holding
 * the same gapCode with different labels collided, and the second inherited the
 * first's order and a rationale fact their own gap never produced.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
require(path.join(ROOT, 'tools/activation/journeyHarness.js'));

const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const { buildCommerceCacheKey, fingerprintQuery } = edge('commerceResultCache.ts');
const { buildShoppingIntent, shoppingIntentFingerprint } = edge('commerceShoppingIntent.ts');
const { scoreContextualFit } = edge('commerceContextualRanking.ts');

const BASE = {
  category: 'shoes',
  subtype: 'boot',
  brand: null,
  exactItemHypothesis: null,
  queryFingerprint: fingerprintQuery('shoes'),
  locale: 'en-US',
  currency: 'USD',
  country: 'US',
};

const keyFor = (intent) =>
  buildCommerceCacheKey({ ...BASE, shoppingIntentFingerprint: shoppingIntentFingerprint(intent) });

const packingGap = (label) =>
  buildShoppingIntent(
    [{
      provenance: 'PACKING',
      category: 'shoes',
      gapRelationship: { gapCode: 'missing_role_shoe', label, certainty: 'confirmed' },
    }],
    null,
  );

const GALA_SHOE = {
  title: 'Leather Gala Dress Shoe',
  source: 'Farfetch',
  price: '$180.00',
  link: 'https://retailer.invalid/gala-dress-shoe',
};

// ── The reproduction ───────────────────────────────────────────────────────

test('the Packing gap LABEL changes ranking, so it must change the cache key', () => {
  const intentA = packingGap('dress shoes for the gala');
  const intentB = packingGap('hiking boots for the trail');

  // Premise: the label really is a ranking input. If this ever stops being
  // true, the key requirement below can be revisited -- but not before.
  const scoredA = scoreContextualFit(GALA_SHOE, intentA);
  const scoredB = scoreContextualFit(GALA_SHOE, intentB);
  assert.notEqual(scoredA.delta, scoredB.delta, 'gap label no longer affects ranking delta');
  assert.ok(scoredA.facts.includes('confirmed_gap_match'));
  assert.ok(!scoredB.facts.includes('confirmed_gap_match'));

  // The control: two actors differing ONLY in gap label must not share an entry.
  assert.notEqual(
    shoppingIntentFingerprint(intentA),
    shoppingIntentFingerprint(intentB),
    'intents that rank differently produced the same fingerprint',
  );
  assert.notEqual(
    keyFor(intentA),
    keyFor(intentB),
    'SEC-COM-11/12: customer B would inherit customer A\'s gap-ranked shelf from cache',
  );
});

// ── Every other ranking input, held to the same rule ───────────────────────

test('each ranking-relevant intent field separates the cache key', () => {
  const only = (contribution) => buildShoppingIntent([contribution], null);
  const cases = [
    ['color', { provenance: 'USER_EXPLICIT', category: 'shoes', color: 'black' },
               { provenance: 'USER_EXPLICIT', category: 'shoes', color: 'brown' }],
    ['material', { provenance: 'USER_EXPLICIT', category: 'shoes', material: 'leather' },
                  { provenance: 'USER_EXPLICIT', category: 'shoes', material: 'suede' }],
    ['budget ceiling', { provenance: 'USER_EXPLICIT', category: 'shoes', budgetCeiling: { amount: 120, currency: 'USD' } },
                        { provenance: 'USER_EXPLICIT', category: 'shoes', budgetCeiling: { amount: 400, currency: 'USD' } }],
    ['exclusions', { provenance: 'USER_EXPLICIT', category: 'shoes', exclusions: [{ axis: 'material', token: 'leather' }] },
                    { provenance: 'USER_EXPLICIT', category: 'shoes', exclusions: [{ axis: 'color', token: 'black' }] }],
    ['Closet (relevantOwned)', { provenance: 'CLOSET', category: 'shoes', relevantOwned: [{ descriptor: 'black leather boot', category: 'shoes', color: 'black', material: 'leather' }] },
                                { provenance: 'CLOSET', category: 'shoes', relevantOwned: [{ descriptor: 'tan suede boot', category: 'shoes', color: 'tan', material: 'suede' }] }],
    ['Signature Style tokens', { provenance: 'SIGNATURE_STYLE', category: 'shoes', signatureStyleTokens: ['minimal'] },
                                { provenance: 'SIGNATURE_STYLE', category: 'shoes', signatureStyleTokens: ['maximalist'] }],
    ['gap certainty', { provenance: 'PACKING', category: 'shoes', gapRelationship: { gapCode: 'missing_role_shoe', label: 'shoes', certainty: 'confirmed' } },
                       { provenance: 'PACKING', category: 'shoes', gapRelationship: { gapCode: 'missing_role_shoe', label: 'shoes', certainty: 'unconfirmed' } }],
  ];

  for (const [name, a, b] of cases) {
    assert.notEqual(keyFor(only(a)), keyFor(only(b)), `${name} does not separate the cache key`);
  }
});

// ── The other half of §26: same-customer behaviour must survive ────────────

test('the same customer with the same context still shares one cache entry', () => {
  assert.equal(
    keyFor(packingGap('dress shoes for the gala')),
    keyFor(packingGap('dress shoes for the gala')),
    'a customer stopped reusing their own cached shelf',
  );
});

test('case and whitespace variants of one label do not fragment the cache', () => {
  assert.equal(
    keyFor(packingGap('dress shoes for the gala')),
    keyFor(packingGap('Dress  Shoes   For The Gala')),
  );
});

test('the zero-context request keeps its pre-existing, byte-identical key', () => {
  const empty = shoppingIntentFingerprint(buildShoppingIntent([], null));
  assert.equal(empty, '', 'an intent constraining nothing must fingerprint to empty');
  assert.equal(
    buildCommerceCacheKey({ ...BASE, shoppingIntentFingerprint: empty }),
    buildCommerceCacheKey({ ...BASE, shoppingIntentFingerprint: null }),
    'the zero-context fast path changed key',
  );
});

test('a gap the reducer refuses adds no part to the fingerprint', () => {
  // buildShoppingIntent requires BOTH a code and a label, so a labelless gap is
  // dropped whole rather than keyed as an empty string.
  const labelless = buildShoppingIntent(
    [{ provenance: 'PACKING', category: 'shoes', gapRelationship: { gapCode: 'missing_role_shoe', label: '', certainty: 'confirmed' } }],
    null,
  );
  assert.equal(shoppingIntentFingerprint(labelless), 'cat:PACKING:shoes');
});

// ── The cache value must stay public product data ──────────────────────────

test('the cache key input type admits no actor-identifying field', () => {
  // A defence against the opposite mistake: putting a user id IN the key, which
  // would fragment the shared shelf per customer and quietly turn a public
  // product cache into personalized storage.
  const source = require('node:fs').readFileSync(
    path.join(ROOT, 'supabase/functions/scan-identify/commerceResultCache.ts'), 'utf8',
  );
  const keyBuilder = source.slice(source.indexOf('export function buildCommerceCacheKey'));
  for (const forbidden of ['userId', 'user_id', 'actorId', 'actor_id', 'ownerId', 'owner_id']) {
    assert.equal(keyBuilder.includes(forbidden), false,
      `buildCommerceCacheKey references ${forbidden}`);
  }
});
