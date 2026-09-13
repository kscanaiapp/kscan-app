/**
 * Elise -> Commerce activation: customer journeys (activation brief §35).
 *
 * Every journey runs the real action validator, the real reducer, the real
 * wire validator, the real client activation and the real #409 ranker. Only
 * the network is stubbed, by a fixture provider that runs that same ranker
 * over a fixed candidate universe.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const harness = require(path.join(ROOT, 'tools/activation/journeyHarness.js'));
const { runTurn, makeFixtureProvider, product } = harness;

const action = (shopping) =>
  `Here are some options.\n<actions>[{"type":"find_products","shopping":${JSON.stringify(shopping)}}]</actions>`;

// ── A. Elise outfit shopping ───────────────────────────────────────────────

test('JOURNEY A: "different shoes under $120" reaches Commerce and returns real candidates', async () => {
  const turn = await runTurn({
    message: 'I like this outfit, but show me different shoes under $120.',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
  });

  assert.equal(turn.status, 'results');
  assert.equal(turn.commerceCalls, 1, 'exactly one provider request per shopping turn');
  assert.ok(turn.products.length > 0, 'real candidates rendered');
  assert.equal(turn.products.includes('s_chelsea'), false, 'the $300 boot cannot answer a $120 request');
  assert.equal(turn.state.category, 'footwear');
  assert.deepEqual(turn.state.budget, { amount: 120, currency: 'USD' });
  // Elise's prose survives untouched; the action block never reaches the bubble.
  assert.equal(turn.prose, 'Here are some options.');
  assert.equal(/<actions>/.test(turn.prose), false);
});

// ── B / C. Refinement and constraint removal ───────────────────────────────

test('JOURNEY B: "only black" refines without losing the budget', async () => {
  const t1 = await runTurn({
    message: 'show me different shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
  });
  const t2 = await runTurn({
    message: 'Only black.',
    modelText: action({ color: 'black' }),
    priorRows: t1.rows,
  });

  assert.equal(t2.state.color, 'black');
  assert.deepEqual(t2.state.budget, { amount: 120, currency: 'USD' }, 'BLOCK-05: the ceiling survives refinement');
  assert.equal(t2.reset, false);
  // #409 treats an explicit ATTRIBUTE as a strong ranking signal (+22 match /
  // -18 miss) and an explicit EXCLUSION as a Stage A filter. "Only black" is
  // the former, so black leads and a non-black option is ranked down rather
  // than removed. Asserted against the real contract; see
  // RANKING_FOLLOWUP_REQUIRED in the activation report.
  assert.match(String(t2.productDetail[0].title).toLowerCase(), /black/, 'black leads');
  assert.ok(
    t2.productDetail[0].commerceRationale.factCodes.includes('explicit_color_match'),
    'the stated colour reached #409 as an explicit attribute',
  );
});

test('JOURNEY C: "any color is fine" removes the colour and keeps the budget', async () => {
  const t1 = await runTurn({
    message: 'different shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
  });
  const t2 = await runTurn({ message: 'Only black.', modelText: action({ color: 'black' }), priorRows: t1.rows });
  const t3 = await runTurn({
    message: 'Actually, any color is fine.',
    modelText: action({ clearColor: true }),
    priorRows: t2.rows,
  });

  assert.equal(t3.state.color, null, 'the constraint is removed, not merely ignored');
  assert.deepEqual(t3.state.budget, { amount: 120, currency: 'USD' });
});

test('COPY-ON-WRITE: turn N state is unchanged after turn N+1 refines it', async () => {
  const t1 = await runTurn({
    message: 'different shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
  });
  const snapshot = JSON.parse(JSON.stringify(t1.state));
  const persisted = JSON.parse(JSON.stringify(t1.rows[0].ui_blocks));

  await runTurn({ message: 'Only black.', modelText: action({ color: 'black' }), priorRows: t1.rows });

  assert.deepEqual(t1.state, snapshot, 'the previous state object was not mutated');
  assert.deepEqual(t1.rows[0].ui_blocks, persisted, 'the persisted block was not mutated');
});

// ── D / E. Reset and interleaving ──────────────────────────────────────────

test('JOURNEY D: a new garment category resets the shopping intent', async () => {
  const t1 = await runTurn({
    message: 'black boots under $120, nothing in leather',
    modelText: action({ category: 'boots', budgetAmount: 120, budgetCurrency: 'USD', color: 'black', excludeMaterials: ['leather'] }),
  });
  assert.equal(t1.state.category, 'footwear');
  assert.equal(t1.state.exclusions.length, 1);

  const t2 = await runTurn({
    message: 'find me a wedding dress',
    modelText: action({ category: 'dress' }),
    priorRows: t1.rows,
  });

  assert.equal(t2.reset, true);
  assert.equal(t2.state.category, 'dress');
  assert.equal(t2.state.color, null, 'boot colour does not follow a dress');
  assert.equal(t2.state.budget, null, 'the boot budget does not silently price the dress');
  assert.deepEqual(t2.state.exclusions, [], 'boot exclusions do not follow');
});

test('JOURNEY E: an interleaved return re-states the intent rather than resurrecting it', async () => {
  const boots = await runTurn({
    message: 'black boots under $120',
    modelText: action({ category: 'boots', budgetAmount: 120, budgetCurrency: 'USD', color: 'black' }),
  });
  const dress = await runTurn({ message: 'find me a wedding dress', modelText: action({ category: 'dress' }), priorRows: boots.rows });
  const back = await runTurn({
    message: 'go back to the boots',
    modelText: action({ category: 'boots' }),
    priorRows: dress.rows,
  });

  assert.equal(back.reset, true, 'returning is a new thread, not a resurrected one');
  assert.equal(back.state.category, 'footwear');
  // The honest outcome: constraints the customer has not restated are gone.
  assert.equal(back.state.budget, null);
  assert.equal(back.state.color, null);
});

// ── Relative requests (§16) ────────────────────────────────────────────────

test('"cheaper" with no reference asks instead of inventing a ceiling', async () => {
  const turn = await runTurn({ message: 'something cheaper', modelText: action({ category: 'shoes' }) });
  assert.equal(turn.needsBudgetReference, true);
  assert.equal(turn.commerceCalls, 0, 'no provider call is spent on an invented budget');
  assert.equal(turn.status, 'skipped');
  assert.equal(turn.products.length, 0);
});

test('"cheaper" against a standing ceiling resolves without a new number', async () => {
  const t1 = await runTurn({
    message: 'shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
  });
  const t2 = await runTurn({ message: 'something cheaper', modelText: action({}), priorRows: t1.rows });
  assert.equal(t2.needsBudgetReference, false);
  assert.deepEqual(t2.state.budget, { amount: 120, currency: 'USD' });
  assert.equal(t2.commerceCalls, 1);
});

test('"cheaper" resolves against the prices actually shown last turn', async () => {
  const t1 = await runTurn({ message: 'show me shoes', modelText: action({ category: 'shoes' }) });
  assert.equal(t1.status, 'results');
  const intentBlock = t1.blocks.find((b) => b.type === 'commerce_shopping_intent');
  assert.ok(intentBlock.state.lastShownPrices, 'the shown prices are recorded as the reference');

  const t2 = await runTurn({ message: 'something cheaper', modelText: action({}), priorRows: t1.rows });
  assert.equal(t2.needsBudgetReference, false);
  assert.ok(t2.state.budget, 'a concrete reference produced a real ceiling');
});

// ── H / I / J. Closet and Signature Style ──────────────────────────────────

test('JOURNEY H: an owned near-duplicate is flagged through the real ranker', async () => {
  const turn = await runTurn({
    message: 'different shoes',
    modelText: action({ category: 'shoes' }),
    actorId: 'actor-1',
    closetItems: [{ title: 'Black Leather Chelsea Boot', category: 'boot', color: 'black', material: 'leather' }],
    provider: makeFixtureProvider({ actorId: 'actor-1' }),
  });
  const dupe = turn.productDetail.find((p) => p.id === 's_chelsea');
  assert.ok(dupe, 'a near-duplicate is ranked down, never hidden');
  assert.ok(
    dupe.commerceRationale.factCodes.includes('duplicate_of_owned'),
    'the Closet context reached #409 and produced the fact',
  );
});

test('JOURNEY I: an explicit colour outranks a neutral Signature Style', async () => {
  const turn = await runTurn({
    message: 'show me black shoes',
    modelText: action({ category: 'shoes', color: 'black' }),
    actorId: 'actor-1',
    styleTokens: ['brown', 'tan'],
    provider: makeFixtureProvider({ actorId: 'actor-1' }),
  });
  assert.equal(turn.status, 'results');
  assert.match(String(turn.productDetail[0].title).toLowerCase(), /black/, 'the stated colour wins');
});

test('JOURNEY J: an empty Closet plus a valid Signature Style does not crash', async () => {
  const turn = await runTurn({
    message: 'show me shoes',
    modelText: action({ category: 'shoes' }),
    actorId: 'actor-1',
    closetItems: [],
    styleTokens: ['minimal'],
    provider: makeFixtureProvider({ actorId: 'actor-1' }),
  });
  assert.equal(turn.status, 'results');
  assert.ok(turn.products.length > 0);
});

// ── M. Provider failure ────────────────────────────────────────────────────

test('JOURNEY M: a provider failure is an error state, never an empty shelf', async () => {
  const failing = makeFixtureProvider({ failWith: 'invoke_error' });
  const turn = await runTurn({
    message: 'show me shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
    provider: failing,
  });
  assert.equal(turn.status, 'error');
  assert.equal(turn.products.length, 0, 'BLOCK-13: zero fabricated cards');
  const block = turn.blocks.find((b) => b.type === 'commerce_products');
  assert.equal(block.status, 'error', 'distinct from no_matches');
});

test('an empty-but-successful shelf is no_matches, not an error', async () => {
  const empty = makeFixtureProvider({ universe: [] });
  const turn = await runTurn({
    message: 'show me shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
    provider: empty,
  });
  assert.equal(turn.status, 'no_matches');
  assert.equal(turn.products.length, 0);
});

test('a constrained-to-nothing shelf is no_matches, not an error', async () => {
  const turn = await runTurn({
    message: 'shoes under $10',
    modelText: action({ category: 'shoes', budgetAmount: 10, budgetCurrency: 'USD' }),
  });
  assert.equal(turn.status, 'no_matches');
  assert.equal(turn.products.length, 0, 'fewer results rather than filler');
});

// ── Provider-call bound (§34) ──────────────────────────────────────────────

test('one shopping turn issues exactly one Commerce request', async () => {
  const provider = makeFixtureProvider();
  const turn = await runTurn({
    message: 'show me shoes under $120',
    modelText: action({ category: 'shoes', budgetAmount: 120, budgetCurrency: 'USD' }),
    provider,
  });
  assert.equal(turn.commerceCalls, 1);
  assert.equal(provider.calls.length, 1);
});

test('a turn with no shopping action issues no Commerce request', async () => {
  const provider = makeFixtureProvider();
  const turn = await runTurn({
    message: 'what goes with this jacket?',
    modelText: 'Try a slim trouser and a boot.',
    provider,
  });
  assert.equal(turn.commerceCalls, 0);
  assert.equal(provider.calls.length, 0);
  assert.equal(turn.blocks.length, 0, 'no blocks on a non-shopping turn');
});
