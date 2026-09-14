#!/usr/bin/env node
/**
 * Commerce V2 conversational journey harness.
 *
 * Wraps the #410 journey harness so a whole CONVERSATION can be run turn by
 * turn against one fixture market, with the real action validator, the real
 * reducer, the real wire validator, the real shelf-memory selection and the
 * real #409 ranker in the path. Only the network is stubbed.
 *
 * `priorRows` are threaded exactly as the server reads them, so intent and
 * shelf memory travel through the REAL persisted `ui_blocks` shape rather than
 * being handed around in memory — which is what makes a journey result
 * evidence about the shipped storage contract rather than about the test.
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const harness = require(path.join(ROOT, 'tools/activation/journeyHarness.js'));
const shelfMemory = require(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts'));
const identity = require(path.join(ROOT, 'services/commerce/productIdentity.ts'));

const { runTurn, makeFixtureProvider, product } = harness;

/** Ten real-shaped loafer offers: enough market for "different" to mean something. */
const LOAFERS = [
  product('l_black_leather', 'Black Leather Penny Loafer', '$140.00'),
  product('l_black_suede', 'Black Suede Driving Loafer', '$120.00', { source: 'Poshmark' }),
  product('l_navy_leather', 'Navy Leather Tassel Loafer', '$130.00', { source: 'KicksCrew' }),
  product('l_black_canvas', 'Black Canvas Casual Loafer', '$90.00', { source: 'Serper' }),
  product('l_brown_suede', 'Brown Suede Casual Loafer', '$99.00', { source: 'Mr Porter' }),
  product('l_black_horsebit', 'Black Leather Horsebit Loafer', '$145.00', { source: 'Selfridges' }),
  product('l_black_chunky', 'Black Chunky Platform Loafer', '$119.00', { source: 'Nordstrom' }),
  product('l_black_suede_casual', 'Black Suede Casual Loafer', '$105.00', { source: 'Zappos' }),
  product('l_tan_leather', 'Tan Leather Penny Loafer', '$128.00', { source: 'Mr Porter' }),
  product('l_black_formal', 'Black Leather Formal Loafer', '$149.00', { source: 'Harrods' }),
];

/**
 * A deeper market. Three or four conversational turns can consume ten offers
 * entirely, at which point "another" is legitimately answering an exhausted
 * universe — a real behaviour, but not the one a provider-discipline test is
 * trying to measure.
 */
function manyLoafers(count = 16) {
  const out = [];
  for (let i = 0; i < count; i += 1) {
    out.push(product(
      `m_loafer_${i}`,
      `Black Leather Loafer Style ${i}`,
      `$${100 + i}.00`,
      { source: ['Farfetch', 'Poshmark', 'Nordstrom', 'Zappos'][i % 4], productUrl: `https://www.retailer${i % 4}.com/loafer/${i}` },
    ));
  }
  return out;
}

const JACKETS = [
  product('j_red_suede', 'Red Suede Moto Jacket', '$220.00'),
  product('j_red_leather', 'Red Leather Biker Jacket', '$260.00', { source: 'Selfridges' }),
  product('j_red_wool', 'Red Wool Overcoat', '$180.00', { source: 'Nordstrom' }),
  product('j_black_suede', 'Black Suede Jacket', '$210.00', { source: 'Mr Porter' }),
];

const RAIN_LAYERS = [
  product('r_shell', 'Waterproof Packable Rain Shell', '$120.00'),
  product('r_trench', 'Waterproof Cotton Trench Coat', '$180.00', { source: 'Selfridges' }),
  product('r_anorak', 'Lightweight Waterproof Anorak', '$95.00', { source: 'Nordstrom' }),
  product('r_parka', 'Insulated Waterproof Parka', '$210.00', { source: 'Zappos' }),
];

/**
 * A provider whose behaviour can change BETWEEN turns.
 *
 * Needed for the failure journeys: "the universe is exhausted AND the refresh
 * fails" is a different customer experience from either half alone, and it
 * cannot be staged with a provider that is either always up or always down.
 */
function makeControllableProvider(options = {}) {
  const state = { failWith: options.failWith ?? null, universe: options.universe ?? LOAFERS };
  const calls = [];
  const inner = () => makeFixtureProvider({ universe: state.universe, actorId: options.actorId ?? null });
  const fetchCommerce = async (evidence) => {
    calls.push(evidence);
    if (state.failWith) {
      return {
        status: 'error', purchaseOptions: [], enrichmentCandidates: [],
        cacheHit: false, errorType: state.failWith, retryable: true,
      };
    }
    return inner().fetchCommerce(evidence);
  };
  return {
    fetchCommerce,
    calls,
    failFrom(errorType) { state.failWith = errorType; },
    recover() { state.failWith = null; },
    setUniverse(next) { state.universe = next; },
  };
}

const action = (shopping) =>
  `Let me look at that.\n<actions>[{"type":"find_products","shopping":${JSON.stringify(shopping ?? {})}}]</actions>`;

/**
 * One conversation. Each `say()` is a full turn through the real path, and the
 * rows it returns are what the next turn reads — the same contract the server's
 * `findLatestShoppingIntent` uses.
 */
function conversation(options = {}) {
  shelfMemory.clearCandidateUniverses();
  const provider = options.provider ?? makeControllableProvider({
    universe: options.universe ?? LOAFERS,
    actorId: options.actorId ?? null,
  });
  let rows = options.priorRows ?? [];
  const history = [];

  return {
    provider,
    get rows() { return rows; },
    get history() { return history; },
    /** Provider requests made so far across the whole conversation. */
    get calls() { return provider.calls.length; },
    async say(message, shopping, extra = {}) {
      const before = provider.calls.length;
      const turn = await runTurn({
        message,
        modelText: action(shopping),
        priorRows: rows,
        provider,
        actorId: options.actorId ?? null,
        ...extra,
      });
      rows = turn.rows;
      turn.callsThisTurn = provider.calls.length - before;
      history.push(turn);
      return turn;
    },
  };
}

/** Identities as the memory records them, from the products a turn rendered. */
const identitiesOf = (turn) => identity.shelfIdentities(turn.productDetail ?? []);

/** The shelf memory a turn persisted, read back out of the real block. */
function persistedMemory(turn) {
  const block = (turn.blocks ?? []).find((b) => b.type === 'commerce_shopping_intent');
  return block?.state?.shelfMemory ?? null;
}

module.exports = {
  conversation,
  manyLoafers,
  makeControllableProvider,
  identitiesOf,
  persistedMemory,
  action,
  product,
  LOAFERS,
  JACKETS,
  RAIN_LAYERS,
  shelfMemory,
  identity,
};
