/**
 * Commerce V2 required journeys (brief §49).
 *
 * J1-J5, J7, J9-J13 are proven in `commerceV2Blocking.test.js` as the gates
 * they also serve; this file covers the rest and the ones whose value is the
 * WHOLE conversation rather than a single assertion — constraint recovery, a
 * restored product whose commercial truth has gone, exhaustion under failure,
 * unstable cross-retrieval identity, and the Tier 2 boundary.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const h = require(path.join(ROOT, 'tools/commerce-v2/v2Journey.js'));
const { conversation, makeControllableProvider, persistedMemory, product, manyLoafers, LOAFERS } = h;
const identity = require(path.join(ROOT, 'services/commerce/productIdentity.ts'));
const shelfMemory = require(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts'));

const MINUTE = 60 * 1000;

// ── J6: lifting a constraint the customer put there ───────────────────────

test('J6: "actually, leather is fine" really removes the leather exclusion', async () => {
  const MIXED = [
    product('z_leather', 'Black Leather Loafer', '$130.00'),
    product('z_suede', 'Black Suede Loafer', '$128.00', { source: 'Poshmark' }),
  ];
  const c = conversation({ provider: makeControllableProvider({ universe: MIXED }) });
  const t1 = await c.say('Show me black loafers, nothing leather.', {
    category: 'loafers', color: 'black', excludeMaterials: ['leather'],
  });
  assert.deepEqual(t1.products, ['z_suede'], 'the exclusion really excluded');

  const t2 = await c.say('Actually, leather is fine.', { clearExclusions: ['leather'] });
  assert.deepEqual(t2.state.exclusions, [], 'the constraint is gone from the intent');
  assert.ok(t2.products.includes('z_leather'), 'and the market reopens');
  assert.equal(t2.state.color, 'black', 'while everything else is preserved');
});

test('J6b: the exhaustion offer is one the system can actually honour', async () => {
  // Elise\'s exhaustion copy offers to open up the budget. If saying yes did
  // nothing, the copy would be a promise the product cannot keep.
  const OVER = [
    product('o_cheap', 'Black Canvas Loafer', '$90.00'),
    product('o_dear', 'Black Leather Loafer', '$300.00', { source: 'Selfridges' }),
  ];
  const c = conversation({ provider: makeControllableProvider({ universe: OVER }) });
  const t1 = await c.say('Show me black loafers under $100.', {
    category: 'loafers', color: 'black', budgetAmount: 100, budgetCurrency: 'USD',
  });
  assert.deepEqual(t1.products, ['o_cheap'], 'the ceiling is a hard constraint');
  const t2 = await c.say('Show me different ones.');
  assert.equal(t2.status, 'exhausted', 'and then there is nothing else within it');

  const t3 = await c.say('Any price is fine.', { clearBudget: true });
  assert.equal(t3.state.budget, null);
  assert.ok(t3.products.includes('o_dear'), 'the offer was real');
});

// ── J8: a restored product whose commercial truth has gone ────────────────

test('J8: a restored product survives as a reference, never as a stale price', async () => {
  const c = conversation({ universe: LOAFERS });
  const t1 = await c.say('Show me black loafers under $150.', {
    category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD',
  });
  const first = t1.productDetail[0];
  assert.equal(first.commercialUsability, 'TRANSACTION_READY', 'it was buyable when shown');
  assert.ok(first.price, 'and it had a price');

  // Long enough later that the retained universe has expired: K Scan no longer
  // holds current truth about this offer.
  const later = Date.now() + 11 * MINUTE;
  const t2 = await c.say('Go back to the first one.', undefined, { now: later });

  assert.equal(t2.productDetail.length, 1, 'the reference still resolves');
  const restored = t2.productDetail[0];
  assert.equal(
    identity.productShelfIdentity(restored),
    identity.productShelfIdentity(first),
    'to exactly the product that was shown',
  );
  assert.equal(restored.price, undefined, 'with no revived price');
  assert.equal(restored.availability, undefined, 'and no revived availability');
  assert.equal(restored.commercialUsability, 'BROWSE_ONLY', 'so no active Buy control');
  assert.ok(t2.notices.includes('restored_not_transactable'), 'and the customer is told plainly');
  assert.equal(t2.callsThisTurn, 0, 'without spending a provider call to say so');

  // The shopping task remains usable.
  const t3 = await c.say('Show me different ones.');
  assert.equal(t3.status, 'results', 'the conversation carries on');
});

// ── J14: exhaustion AND a failed refresh ──────────────────────────────────

test('J14: "another" after exhaustion plus a retrieval failure is honest about which', async () => {
  const provider = makeControllableProvider({ universe: LOAFERS.slice(0, 3) });
  const c = conversation({ provider });
  await c.say('Show me loafers.', { category: 'loafers' });
  provider.failFrom('provider_error');

  // Staged as the real condition: a universe old enough to be worth
  // re-checking. A universe fetched seconds ago is not re-asked at all.
  const t2 = await c.say('Another.', undefined, { now: Date.now() + 5 * MINUTE });
  assert.equal(t2.status, 'error', 'a failure is not "that is everything available"');
  assert.equal(t2.callsThisTurn, 1, 'exactly one refresh attempt, never a loop');
  assert.deepEqual(t2.products, [], 'and nothing is invented to fill the gap');

  // Recovering does not require the customer to start over.
  provider.recover();
  const t3 = await c.say('Try again.', undefined, { now: Date.now() + 5 * MINUTE });
  assert.equal(t3.status, 'results');
});

// ── J15: identity across two retrievals ───────────────────────────────────

test('J15: the same offer decorated differently is still excluded by "different"', async () => {
  const FIRST = [
    product('p_a', 'Black Leather Loafer', '$130.00', { productUrl: 'https://shop.com/loafer/1' }),
    product('p_b', 'Black Suede Loafer', '$120.00', { productUrl: 'https://shop.com/loafer/2', source: 'Poshmark' }),
  ];
  // The SAME two listings, as a second retrieval might return them: tracking
  // parameters attached, trailing slash, host case. The provider ids differ.
  const SECOND = [
    product('p_a2', 'Black Leather Loafer', '$130.00', { productUrl: 'https://shop.com/loafer/1?utm_source=feed' }),
    product('p_b2', 'Black Suede Loafer', '$120.00', { productUrl: 'https://SHOP.com/loafer/2/', source: 'Poshmark' }),
    product('p_c', 'Navy Leather Loafer', '$125.00', { productUrl: 'https://shop.com/loafer/3', source: 'Zappos' }),
  ];
  const provider = makeControllableProvider({ universe: FIRST });
  const c = conversation({ provider });
  const t1 = await c.say('Show me loafers.', { category: 'loafers' });
  assert.equal(t1.products.length, 2);

  provider.setUniverse(SECOND);
  // The first two were the whole market, so this turn exhausts the retained
  // universe and — the universe now being stale — genuinely re-retrieves.
  const t2 = await c.say('Show me different ones.', undefined, { now: Date.now() + 5 * MINUTE });
  assert.deepEqual(t2.products, ['p_c'],
    'the redecorated listings are recognised as already shown; only the genuinely new one survives');

  // CROSS_RETAILER_DUPLICATE_LIMIT, stated rather than implied.
  const sameProductOtherRetailer = product('q', 'Black Leather Loafer', '$130.00', {
    productUrl: 'https://other-retailer.com/loafer/1',
  });
  assert.notEqual(
    identity.productShelfIdentity(sameProductOtherRetailer),
    identity.productShelfIdentity(FIRST[0]),
    '"different" is guaranteed at OFFER identity, not physical-product identity',
  );
});

// ── Tier 2 boundary: multi-task restore ───────────────────────────────────

test('TIER 2: a reference across a task reset clarifies rather than guessing', async () => {
  const provider = makeControllableProvider({ universe: LOAFERS });
  const c = conversation({ provider });
  await c.say('Show me black loafers.', { category: 'loafers', color: 'black' });

  provider.setUniverse([product('w_gown', 'Ivory Silk Wedding Gown', '$900.00')]);
  const t2 = await c.say('Now find me a wedding dress.', { category: 'dress' });
  assert.equal(t2.reset, true);

  const t3 = await c.say('Go back to the first one.');
  // MULTI_TASK_RESTORE_FOLLOWUP_REQUIRED=YES. The loafer shelves did not
  // survive the reset — which is the §22 firewall working — so the only
  // honest answers are the dress shelf or a question. It never resolves a
  // loafer into a dress conversation.
  const resolved = t3.productDetail[0];
  if (resolved) {
    assert.equal(String(resolved.title), 'Ivory Silk Wedding Gown', 'only the current task can be referenced');
  } else {
    assert.ok(
      t3.notices.some((n) => n.startsWith('reference_')),
      'or it says it cannot, and asks',
    );
  }
});

// ── Repeated refinement: the memory keeps working over a long thread ──────

test('a five-turn thread never repeats a rejected product and never loops a provider', async () => {
  const c = conversation({ universe: manyLoafers(16) });
  const t1 = await c.say('Show me black loafers under $150.', {
    category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD',
  });
  const t2 = await c.say('Not those.');
  const rejected = new Set(persistedMemory(t2).rejected);
  const t3 = await c.say('Show me different ones.');
  const t4 = await c.say('Another.');
  const t5 = await c.say('Not those.');

  for (const [label, turn] of [['t2', t2], ['t3', t3], ['t4', t4], ['t5', t5]]) {
    for (const id of h.identitiesOf(turn)) {
      assert.equal(rejected.has(id), false, `${label} must not re-show a rejected listing`);
    }
  }
  assert.ok(c.calls <= 2, `five turns cost ${c.calls} provider requests`);

  // And the whole thing is recoverable in one sentence.
  const t6 = await c.say('Show me everything again.');
  assert.equal(t6.memoryOp, 'clear');
  assert.deepEqual(persistedMemory(t6).rejected, [], 'the rejections are gone');
  assert.ok(t6.notices.includes('rejections_cleared'), 'and the customer is told');
});

// ── §17: the execution location, and what it must not trust ───────────────

test('ACTIVATION_EXECUTION_LOCATION=CLIENT: client state is evidence, never authority', () => {
  // The bounds are enforced on BOTH sides of the wire, so a client that writes
  // an oversized block cannot make the server carry it, and a server response
  // the client did not expect cannot make the client render it.
  const oversized = { actorId: null, shelves: [{ turn: 1, items: Array.from({ length: 50 }, (_, i) => `u:${String(i).padStart(16, '0')}`) }], rejected: [] };
  const serverIntent = require(path.join(ROOT, 'supabase/functions/stylechat-generate/eliseCommerceIntent.ts'));
  const serverSide = serverIntent.restoreShelfMemory(oversized);
  const clientSide = shelfMemory.parseShelfMemory(oversized);
  assert.equal(serverSide.shelves[0].items.length, serverIntent.ELISE_COMMERCE_INTENT_LIMITS.maxProductsPerShelf);
  assert.equal(clientSide.shelves[0].items.length, shelfMemory.SHELF_MEMORY_LIMITS.maxProductsPerShelf);
  assert.deepEqual(serverSide.shelves[0].items, clientSide.shelves[0].items, 'and they keep the same ones');
});
