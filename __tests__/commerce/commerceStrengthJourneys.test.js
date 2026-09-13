/**
 * Strength through the whole Elise path (continuation brief sections 15 and 27).
 *
 * These run the REAL chain -- model text -> `extractActionsBlock` ->
 * `validateStyleChatActions` -> `reduceShoppingIntent` -> the persisted
 * `ui_blocks` row -> `parseShoppingIntentWire` -> `runCommerceActivation` ->
 * the real #409 ranker. Only the network is a fixture.
 *
 * The ranking fixtures next door prove what the weights do. These prove the
 * customer can actually reach them.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const harness = require(path.join(ROOT, 'tools/activation/journeyHarness.js'));
const { runTurn, makeFixtureProvider, product } = harness;

const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const { buildCommerceCacheKey } = edge('commerceResultCache.ts');
const { buildShoppingIntent, parseContextContributions, shoppingIntentFingerprint } =
  edge('commerceShoppingIntent.ts');
const { scoreContextualFit } = edge('commerceContextualRanking.ts');

const action = (shopping) =>
  `Let me look.\n<actions>[{"type":"find_products","shopping":${JSON.stringify(shopping)}}]</actions>`;

/**
 * A shoe universe where the black option is genuinely weaker on fit, arrives
 * last, and every alternative is a strong, buyable listing.
 */
const UNIVERSE = [
  product('j_brown', 'Brown Leather Chelsea Boot', '$180.00', { source: 'Farfetch' }),
  product('j_tan', 'Tan Leather Chelsea Boot', '$170.00', { source: 'KicksCrew' }),
  product('j_burgundy', 'Burgundy Leather Chelsea Boot', '$160.00', { source: 'Poshmark' }),
  product('j_black', 'Black Woven Espadrille', '$62.00', { source: 'Serper' }),
];

const runShoppingTurn = (message, shopping, priorRows) =>
  runTurn({
    message,
    modelText: action(shopping),
    provider: makeFixtureProvider({ universe: UNIVERSE }),
    ...(priorRows ? { priorRows } : {}),
  });

// ── J2 / J3: the same thread, the same universe, a different emphasis ───────

test('J2 then J3: "black shoes" then "only black" reach Commerce with different intents', async () => {
  const j2 = await runShoppingTurn('Show me black shoes.', { category: 'shoes', color: 'black' });
  const j3 = await runShoppingTurn(
    'Only black.',
    { color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    j2.rows,
  );

  assert.equal(j2.state.color, 'black');
  assert.equal(j2.state.colorStrength, 'EXPLICIT_PREFERENCE', 'a plain statement stays ordinary');
  assert.equal(j3.state.colorStrength, 'STRONG_EXPLICIT_PREFERENCE', 'insisting raises the tier');
  assert.equal(j3.reset, false, 'still the same shopping thread');

  assert.equal(j2.commerceCalls, 1, 'one provider request per shopping turn');
  assert.equal(j3.commerceCalls, 1);

  // The elevation reaches the real ranker, measured on the intent that actually
  // travelled: the matching candidate gains, and no other candidate moves.
  //
  // ORDER IS NOT ASSERTED HERE, AND THAT IS A PROPERTY OF THIS PATH, NOT A GAP
  // IN THE MECHANISM. Elise has no scanned garment, so it synthesises an
  // identification from the shopping intent that carries only `item_type` and
  // `subtype`. Every candidate in a shoe search therefore agrees with it almost
  // equally, and a stated colour is the only axis left that separates them --
  // so a colour preference of either tier already orders the shelf, and asking
  // harder widens the gap rather than reshuffling it. The ordering
  // differentiation is proved in `commerceAttributeStrength.test.js`, over a
  // Scanner-grade identification where candidates genuinely differ on secondary
  // fashion attributes. See RANKING_IDENTIFICATION_DEPTH in the report.
  const deltaFor = (turn, id) => {
    const contributions = parseContextContributions(turn.providerCalls[0].shoppingContext);
    const intent = buildShoppingIntent(contributions, null);
    return scoreContextualFit(UNIVERSE.find((p) => p.id === id), intent).delta;
  };
  assert.ok(
    deltaFor(j3, 'j_black') > deltaFor(j2, 'j_black'),
    'insisting elevates the match further',
  );
  for (const id of ['j_brown', 'j_tan', 'j_burgundy']) {
    assert.equal(deltaFor(j3, id), deltaFor(j2, id), `${id}: and costs the alternatives nothing`);
  }
});

test('J2 / J3: the alternatives survive both tiers', async () => {
  const j2 = await runShoppingTurn('Show me black shoes.', { category: 'shoes', color: 'black' });
  const j3 = await runShoppingTurn(
    'Only black.',
    { color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    j2.rows,
  );
  for (const id of ['j_brown', 'j_tan', 'j_burgundy']) {
    assert.ok(j2.products.includes(id), `${id} is on the ordinary shelf`);
    assert.ok(j3.products.includes(id), `${id} survives "only black" -- ranked down, never removed`);
  }
});

test('J2 / J3 cannot share a cache entry, and a cold request keeps its key', async () => {
  const j2 = await runShoppingTurn('Show me black shoes.', { category: 'shoes', color: 'black' });
  const j3 = await runShoppingTurn(
    'Only black.',
    { color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' },
    j2.rows,
  );

  const fingerprintFor = (turn) => {
    const contributions = parseContextContributions(turn.providerCalls[0].shoppingContext);
    return shoppingIntentFingerprint(buildShoppingIntent(contributions, null));
  };
  const f2 = fingerprintFor(j2);
  const f3 = fingerprintFor(j3);
  assert.notEqual(f2, f3, 'the two turns must not collide in the result cache');

  const base = { category: 'footwear', subtype: 'shoes', queryFingerprint: 'black shoes' };
  const keyOrdinary = buildCommerceCacheKey({ ...base, shoppingIntentFingerprint: f2 });
  const keyStrong = buildCommerceCacheKey({ ...base, shoppingIntentFingerprint: f3 });
  const keyCold = buildCommerceCacheKey(base);

  assert.notEqual(keyOrdinary, keyStrong, 'a cache hit must not serve the wrong ordering');
  assert.notEqual(keyCold, keyOrdinary);
  assert.equal(
    keyCold,
    buildCommerceCacheKey({ ...base, shoppingIntentFingerprint: null }),
    'a zero-context request keys exactly as it did before any of this existed',
  );
});

// ── Classification from the customer's own words ───────────────────────────

test('the customer\'s wording can raise the tier without the model proposing it', async () => {
  const turn = await runShoppingTurn('I really want black.', { category: 'shoes', color: 'black' });
  assert.equal(turn.state.colorStrength, 'STRONG_EXPLICIT_PREFERENCE');
});

test('a hedge stays ordinary even when the model proposes STRONG', async () => {
  // The model is the party more likely to over-read enthusiasm, so a hedge in
  // the customer's own sentence wins over its proposal.
  const turn = await runShoppingTurn('Black if possible.', {
    category: 'shoes',
    color: 'black',
    colorStrength: 'STRONG_EXPLICIT_PREFERENCE',
  });
  assert.equal(turn.state.colorStrength, 'EXPLICIT_PREFERENCE');
});

test('a malformed strength cannot buy ranking weight', async () => {
  for (const junk of ['STRONG', 'very strong', 9, true, { tier: 'STRONG' }]) {
    const turn = await runShoppingTurn('Show me black shoes.', {
      category: 'shoes',
      color: 'black',
      colorStrength: junk,
    });
    assert.equal(turn.state.colorStrength, 'EXPLICIT_PREFERENCE', `${JSON.stringify(junk)} degrades`);
  }
});

// ── Lifetime: emphasis follows the colour it qualifies ─────────────────────

test('a new colour is a fresh ask and does not inherit the old emphasis', async () => {
  const t1 = await runShoppingTurn('Only black.', {
    category: 'shoes',
    color: 'black',
    colorStrength: 'STRONG_EXPLICIT_PREFERENCE',
  });
  assert.equal(t1.state.colorStrength, 'STRONG_EXPLICIT_PREFERENCE');

  const t2 = await runShoppingTurn('Actually, brown.', { color: 'brown' }, t1.rows);
  assert.equal(t2.state.color, 'brown');
  assert.equal(t2.state.colorStrength, 'EXPLICIT_PREFERENCE', 'insistence does not transfer');
});

test('J4: "any color is fine" clears the colour and its strength, and keeps the budget', async () => {
  const t1 = await runShoppingTurn('Only black shoes under $200.', {
    category: 'shoes',
    color: 'black',
    colorStrength: 'STRONG_EXPLICIT_PREFERENCE',
    budgetAmount: 200,
    budgetCurrency: 'USD',
  });
  const t2 = await runShoppingTurn('Any color is fine.', { clearColor: true }, t1.rows);
  assert.equal(t2.state.color, null);
  assert.equal(t2.state.colorStrength, null, 'a strength with no colour is meaningless');
  assert.deepEqual(t2.state.budget, { amount: 200, currency: 'USD' }, 'the ceiling survives');
});

test('J15: a category reset drops the colour, its strength and the budget', async () => {
  const t1 = await runShoppingTurn('Only black boots under $200.', {
    category: 'shoes',
    color: 'black',
    colorStrength: 'STRONG_EXPLICIT_PREFERENCE',
    budgetAmount: 200,
    budgetCurrency: 'USD',
  });
  const t2 = await runShoppingTurn('Now show me a wedding dress.', { category: 'dress' }, t1.rows);
  assert.equal(t2.reset, true);
  assert.equal(t2.state.color, null);
  assert.equal(t2.state.colorStrength, null);
  assert.equal(t2.state.budget, null);
});

// ── The persisted block stays copy-on-write ────────────────────────────────

test('refining the strength does not mutate the turn already persisted', async () => {
  const t1 = await runShoppingTurn('Show me black shoes.', { category: 'shoes', color: 'black' });
  const snapshot = JSON.stringify(t1.state);
  await runShoppingTurn('Only black.', { color: 'black', colorStrength: 'STRONG_EXPLICIT_PREFERENCE' }, t1.rows);
  assert.equal(JSON.stringify(t1.state), snapshot, 'turn N is untouched by turn N+1');
});
