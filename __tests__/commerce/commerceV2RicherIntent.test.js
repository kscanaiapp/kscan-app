/**
 * Deeper fashion intent: the axis gate and the provenance firewall
 * (Commerce V2 §32-§40, BLOCK-CV2-15 .. 18).
 *
 * The rule this suite exists to enforce is narrow and unpopular: a fashion
 * attribute may enter shopping intent only when the PRODUCTION RANKER actually
 * consumes it and the CUSTOMER actually said it. An axis that fails either test
 * is a control that lies about being heard.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const h = require(path.join(ROOT, 'tools/commerce-v2/v2Journey.js'));
const { conversation, makeControllableProvider, product } = h;
const ranking = require(path.join(ROOT, 'supabase/functions/scan-identify/commerceContextualRanking.ts'));
const edgeIntent = require(path.join(ROOT, 'supabase/functions/scan-identify/commerceShoppingIntent.ts'));
const intent = require(path.join(ROOT, 'supabase/functions/stylechat-generate/eliseCommerceIntent.ts'));
const actions = require(path.join(ROOT, 'supabase/functions/stylechat-generate/actions.ts'));

const candidate = (title) => ({
  title, productUrl: 'https://r.example.com/a', type: 'retail', price: '$100.00', currency: 'USD',
});
const withAxis = (axis, token) =>
  edgeIntent.buildShoppingIntent([{ provenance: 'USER_EXPLICIT', category: 'footwear', [axis]: token }]);
const bare = edgeIntent.buildShoppingIntent([{ provenance: 'USER_EXPLICIT', category: 'footwear' }]);

// ── §32: the axis gate, executed ───────────────────────────────────────────

test('AXIS GATE: the axes this lane builds on are the ones the ranker consumes', () => {
  const probe = (axis, token, title) =>
    ranking.scoreContextualFit(candidate(title), withAxis(axis, token)).delta -
    ranking.scoreContextualFit(candidate(title), bare).delta;

  assert.equal(probe('color', 'black', 'Black Leather Loafer'), 22, 'COLOR_AXIS_PRESENT');
  assert.equal(probe('material', 'suede', 'Brown Suede Loafer'), 22, 'MATERIAL_AXIS_PRESENT');
  assert.equal(probe('silhouette', 'chelsea', 'Black Chelsea Boot'), 22, 'SILHOUETTE_AXIS_PRESENT');
  assert.equal(probe('formality', 'casual', 'Casual Canvas Sneaker'), 6, 'FORMALITY_AXIS_PRESENT');

  // PATTERN_AXIS_PRESENT = NO. The field exists in the intent schema and in the
  // cache fingerprint, and the ranker never reads it. That is exactly why this
  // lane does not ship a pattern control: it would change nothing.
  assert.equal(probe('pattern', 'striped', 'Striped Cotton Shirt'), 0, 'PATTERN_AXIS_PRESENT=NO');
});

test('the unconsumed axis is therefore not proposable, and cannot be set', () => {
  const extracted = actions.extractActionsBlock(
    'ok <actions>[{"type":"find_products","shopping":{"pattern":"striped"}}]</actions>',
  );
  const validated = actions.validateStyleChatActions(extracted.rawActions, []);
  assert.equal(validated[0].payload.shopping.pattern, undefined, 'the validator has no such field');

  const reduced = intent.reduceShoppingIntent({
    previous: null, message: 'find me a striped shirt', payload: { category: 'shirt', pattern: 'striped' },
  });
  assert.equal(reduced.state.pattern, undefined, 'and neither does the persisted state');
});

// ── BLOCK-CV2-15: attribute non-hallucination ──────────────────────────────

test('BLOCK-CV2-15: unsupported model-proposed attributes are discarded', () => {
  const reduced = intent.reduceShoppingIntent({
    previous: null,
    message: 'Find me black boots.',
    payload: { category: 'boots', color: 'black', material: 'leather', silhouette: 'chelsea', formality: 'dressy' },
  });
  assert.equal(reduced.state.category, 'footwear', 'what they said survives');
  assert.equal(reduced.state.color, 'black', 'what they said survives');
  assert.equal(reduced.state.material, null, 'UNKNOWN STAYS UNKNOWN');
  assert.equal(reduced.state.silhouette, null, 'UNKNOWN STAYS UNKNOWN');
  assert.equal(reduced.state.formality, null, 'UNKNOWN STAYS UNKNOWN');
  assert.deepEqual(
    reduced.rejected.filter((r) => r.endsWith(':unsupported')).sort(),
    ['formality:unsupported', 'material:unsupported', 'silhouette:unsupported'],
    'and the rejection is reported rather than silent',
  );
});

test('a corroborated proposal IS accepted — the guard is evidence, not distrust', () => {
  const reduced = intent.reduceShoppingIntent({
    previous: null,
    message: 'I want black suede chelsea boots, something casual.',
    payload: { category: 'boots', color: 'black', material: 'suede', silhouette: 'chelsea', formality: 'casual' },
  });
  assert.equal(reduced.state.material, 'suede');
  assert.equal(reduced.state.silhouette, 'chelsea');
  assert.equal(reduced.state.formality, 'casual');
  assert.equal(reduced.rejected.length, 0);
});

test('a NEGATED attribute is an exclusion, never a request', () => {
  assert.equal(intent.userStatedToken('nothing leather please', 'leather'), false);
  assert.equal(intent.userStatedToken("I don't want any suede", 'suede'), false);
  assert.equal(intent.userStatedToken('no wide-leg trousers', 'wide-leg'), false);
  const reduced = intent.reduceShoppingIntent({
    previous: null, message: 'Show me loafers, nothing leather.',
    payload: { category: 'loafers', material: 'leather', excludeMaterials: ['leather'] },
  });
  assert.equal(reduced.state.material, null, '"nothing leather" must never become "find me leather"');
  assert.deepEqual(reduced.state.exclusions, [{ axis: 'material', token: 'leather' }]);
});

// ── BLOCK-CV2-16: material refinement reaches the real ranking axis ────────

test('BLOCK-CV2-16: "same idea, but suede" changes a real score and a real order', async () => {
  const MIXED = [
    product('x_leather_a', 'Black Leather Penny Loafer', '$130.00', { productUrl: 'https://www.farfetch.com/a' }),
    product('x_leather_b', 'Black Leather Horsebit Loafer', '$135.00', { productUrl: 'https://www.farfetch.com/b' }),
    product('x_suede', 'Black Suede Penny Loafer', '$128.00', { productUrl: 'https://www.farfetch.com/c' }),
    product('x_canvas', 'Black Canvas Penny Loafer', '$120.00', { productUrl: 'https://www.farfetch.com/d' }),
  ];
  const c = conversation({ provider: makeControllableProvider({ universe: MIXED }) });
  const t1 = await c.say('Show me black leather loafers for the office under $150.', {
    category: 'loafers', color: 'black', material: 'leather', budgetAmount: 150, budgetCurrency: 'USD',
  });
  assert.equal(t1.state.material, 'leather');
  assert.match(String(t1.productDetail[0].title), /leather/i, 'leather leads while leather is the request');

  const t2 = await c.say('Same idea, but suede.', { material: 'suede' });

  assert.equal(t2.state.material, 'suede', 'the axis was replaced, not merged');
  assert.equal(t2.state.category, 'footwear', 'category preserved');
  assert.equal(t2.state.color, 'black', 'colour preserved');
  assert.deepEqual(t2.state.budget, { amount: 150, currency: 'USD' }, 'budget preserved');

  assert.notEqual(t1.products[0], t2.products[0], 'and the ORDER actually moved');
  assert.equal(t2.products[0], 'x_suede', 'the suede option now leads');

  // The score itself, not merely the order: the ranker really consumed it.
  const suedeIntent = edgeIntent.buildShoppingIntent([
    { provenance: 'USER_EXPLICIT', category: 'footwear', color: 'black', material: 'suede' },
  ]);
  const suedeDelta = ranking.scoreContextualFit(candidate('Black Suede Penny Loafer'), suedeIntent).delta;
  const leatherDelta = ranking.scoreContextualFit(candidate('Black Leather Penny Loafer'), suedeIntent).delta;
  assert.ok(suedeDelta > leatherDelta, `suede ${suedeDelta} must outscore leather ${leatherDelta}`);

  // ELEVATION, NOT SUPPRESSION: the leather options are still on the shelf.
  assert.ok(t2.products.includes('x_leather_a'), 'a preference never deletes the market');
});

// ── BLOCK-CV2-17: relative formality works or defers, never no-ops ─────────

test('BLOCK-CV2-17 branch A: with a reference, "less formal" is a real axis change', () => {
  const t1 = intent.reduceShoppingIntent({ previous: null, message: 'I need formal shoes', payload: { category: 'shoes' } });
  assert.equal(t1.state.formality, 'formal');
  const t2 = intent.reduceShoppingIntent({ previous: t1.state, message: 'something less formal', payload: {} });
  assert.equal(t2.state.formality, 'dressy', 'one rung down the ladder');
  assert.equal(t2.needsFormalityReference, false);

  const t3 = intent.reduceShoppingIntent({ previous: t2.state, message: 'more casual still', payload: {} });
  assert.equal(t3.state.formality, 'smart');

  // And it reaches ranking.
  const before = ranking.scoreContextualFit(candidate('Dressy Leather Loafer'), withAxis('formality', 'formal')).delta;
  const after = ranking.scoreContextualFit(candidate('Dressy Leather Loafer'), withAxis('formality', 'dressy')).delta;
  assert.notEqual(before, after, 'the change is visible to the ranker');
});

test('BLOCK-CV2-17 branch B: with no reference, it DEFERS out loud', () => {
  const t1 = intent.reduceShoppingIntent({ previous: null, message: 'find me loafers', payload: { category: 'loafers' } });
  const t2 = intent.reduceShoppingIntent({ previous: t1.state, message: 'something less formal', payload: {} });
  assert.equal(t2.needsFormalityReference, true, 'RELATIVE_ATTRIBUTE_FOLLOWUP_REQUIRED is exercised');
  assert.equal(t2.state.formality, null, 'and no rung is invented to step down from');
});

test('"less formal" never seeds the axis it is moving away from', () => {
  const reduced = intent.reduceShoppingIntent({ previous: null, message: 'something less formal', payload: { category: 'shoes' } });
  assert.equal(reduced.state.formality, null, 'reading "formal" out of "less formal" would invert the request');
  assert.equal(intent.userStatedToken('something less formal', 'formal'), false);
  assert.equal(intent.userStatedToken('I want it more casual', 'casual'), false);
  assert.equal(intent.userStatedToken('I want something casual', 'casual'), true);
});

// ── BLOCK-CV2-18: missing data stays UNKNOWN ───────────────────────────────

test('BLOCK-CV2-18: absent candidate data is never a match OR a mismatch', () => {
  const suede = withAxis('material', 'suede');
  const silent = { title: 'Loafer', productUrl: 'https://r.example.com/a', type: 'retail', price: '$100.00', currency: 'USD' };
  const stated = candidate('Suede Loafer');

  const silentScore = ranking.scoreContextualFit(silent, suede);
  const statedScore = ranking.scoreContextualFit(stated, suede);

  assert.equal(statedScore.facts.includes('explicit_material_match'), true, 'a stated material matches');
  assert.equal(silentScore.facts.includes('explicit_material_match'), false, 'silence is not a match');

  // And the rationale never declares a fact the data does not support.
  const facts = ranking.buildRationaleFacts(silent, suede, silentScore, false);
  assert.equal(facts.matchedAttributes.includes('suede'), false, 'no fabricated MATCH');
  assert.equal(facts.budgetFit, 'unknown', 'unknown stays unknown');
});

test('a budget the currency cannot prove is unknown, not "within"', () => {
  const budgeted = edgeIntent.buildShoppingIntent([
    { provenance: 'USER_EXPLICIT', category: 'footwear', budgetCeiling: { amount: 150, currency: 'USD' } },
  ]);
  const noCurrency = { title: 'Loafer', productUrl: 'https://r.example.com/a', type: 'retail', price: '100' };
  assert.equal(ranking.evaluateBudgetFit(noCurrency, budgeted), 'unknown');
});

// ── §38: soft / strong / hard stay distinct ────────────────────────────────

test('§38: a material PREFERENCE and a material EXCLUSION are different things', async () => {
  const MIXED = [
    product('y_leather', 'Black Leather Loafer', '$130.00'),
    product('y_suede', 'Black Suede Loafer', '$128.00', { source: 'Poshmark' }),
  ];
  const pref = conversation({ provider: makeControllableProvider({ universe: MIXED }) });
  const soft = await pref.say('Show me black loafers, maybe suede.', { category: 'loafers', color: 'black', material: 'suede' });
  assert.equal(soft.products.length, 2, 'a preference elevates and never deletes the alternative');
  assert.equal(soft.products[0], 'y_suede', 'but it does lead');

  const hard = conversation({ provider: makeControllableProvider({ universe: MIXED }) });
  const strict = await hard.say('Show me black loafers, nothing leather.', { category: 'loafers', color: 'black', excludeMaterials: ['leather'] });
  assert.deepEqual(strict.products, ['y_suede'], 'an exclusion is a Stage A filter and really removes it');
});
