#!/usr/bin/env node
/**
 * Commerce V2 performance (brief §53).
 *
 * Measures LOCAL memory work only. Provider and network latency are
 * deliberately excluded and reported as such — conflating them would let a
 * slow retailer make this lane's code look expensive, or a fast one hide it.
 *
 *   node tools/commerce-v2/perf.js
 *   node tools/commerce-v2/perf.js --json
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));
const memory = require(path.join(ROOT, 'services/style-chat/commerceShelfMemory.ts'));
const activation = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));
const identity = require(path.join(ROOT, 'services/commerce/productIdentity.ts'));
const { reduceShoppingIntent } = chat('eliseCommerceIntent.ts');
const h = require(path.join(ROOT, 'tools/commerce-v2/v2Journey.js'));

const ITERATIONS = 2000;

/** A memory at EVERY bound: the most expensive state the contract permits. */
function saturatedMemory() {
  const L = memory.SHELF_MEMORY_LIMITS;
  let state = memory.emptyShelfMemory();
  state.rejected = Array.from({ length: L.maxActiveExclusions }, (_, i) => `u:${String(i).padStart(16, '0')}`);
  for (let s = 0; s < L.maxShelves; s += 1) {
    state = memory.recordShelf(state, {
      turn: s,
      products: Array.from({ length: L.maxProductsPerShelf }, (_, i) => ({
        productUrl: `https://retailer${s}.com/product/${i}?utm_source=feed&ref=x`,
        title: `Offer ${s}-${i}`,
      })),
      actorId: 'actor-1',
    });
  }
  return state;
}

const UNIVERSE = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`,
  title: `${['Black', 'Brown', 'Navy'][i % 3]} ${['Suede', 'Canvas', 'Leather'][i % 3]} Loafer ${i}`,
  price: `$${90 + i * 6}.00`,
  currency: 'USD',
  type: 'retail',
  source: ['Farfetch', 'Poshmark', 'Zappos'][i % 3],
  imageUrl: `https://img.cdn.io/${i}.jpg`,
  productUrl: `https://retailer${i % 3}.com/product/${i}`,
}));

function measure(fn) {
  fn(); // warm the path so the first call's compile cost is not the measurement
  const started = process.hrtime.bigint();
  for (let i = 0; i < ITERATIONS; i += 1) fn();
  const totalNs = Number(process.hrtime.bigint() - started);
  return { msPerOp: totalNs / ITERATIONS / 1e6 };
}

async function main() {
  const saturated = saturatedMemory();
  const serialized = JSON.parse(JSON.stringify(saturated));
  const state = {
    stateVersion: 1, category: 'footwear', color: 'black', material: 'suede', silhouette: null,
    formality: null, budget: { amount: 150, currency: 'USD' }, exclusions: [{ axis: 'material', token: 'fur' }],
    functionalRequirements: ['waterproof'], turns: 3, lastShownPrices: null, shelfMemory: serialized,
  };

  const rows = [
    { label: 'SHELF_MEMORY_RESTORE_MS', ...measure(() => memory.parseShelfMemory(serialized)) },
    {
      label: 'INTENT_REDUCER_MS',
      ...measure(() => reduceShoppingIntent({
        previous: { ...state, shelfMemory: serialized },
        message: 'Show me different ones, maybe suede.',
        payload: { material: 'suede' },
      })),
    },
    {
      label: 'EXCLUSION_FILTER_MS',
      ...measure(() => memory.selectPresentedShelf({
        universe: UNIVERSE, memory: saturated, op: 'different', limit: 6,
      })),
    },
    {
      label: 'CONTEXT_ASSEMBLY_MS',
      ...measure(() => activation.buildActivationEvidence({
        state, actorId: 'actor-1',
        closetItems: Array.from({ length: 20 }, (_, i) => ({ title: `Black Leather Loafer ${i}`, category: 'loafer', color: 'black', material: 'leather' })),
        signatureStyleTokens: ['minimal', 'tailored'],
      })),
    },
    {
      label: 'RANKING_INCREMENTAL_MS',
      ...measure(() => identity.shelfIdentities(UNIVERSE)),
    },
  ];

  // Provider discipline, measured over a whole realistic conversation.
  const c = h.conversation({ universe: h.manyLoafers(16) });
  await c.say('Show me black loafers under $150.', { category: 'loafers', color: 'black', budgetAmount: 150, budgetCurrency: 'USD' });
  await c.say('Show me different ones.');
  await c.say('Not those.');
  await c.say('Another.');
  const last = await c.say('Go back to the first one.');
  const persisted = h.persistedMemory(last);
  const refs = (persisted?.shelves ?? []).reduce((n, s) => n + s.items.length, 0);

  const report = {
    note: 'Local assembly only. Provider and network latency deliberately excluded.',
    iterations: ITERATIONS,
    timings: Object.fromEntries(rows.map((r) => [r.label, Number(r.msPerOp.toFixed(4))])),
    PRODUCT_REFS_PERSISTED_PER_THREAD: refs,
    MAX_ACTIVE_PRODUCT_EXCLUSIONS: memory.SHELF_MEMORY_LIMITS.maxActiveExclusions,
    PROVIDER_CALLS_PER_JOURNEY: c.calls,
    PERSISTED_STATE_BYTES: JSON.stringify(persisted ?? {}).length,
  };

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log(`# Commerce V2 performance (${ITERATIONS} iterations, saturated memory)`);
  console.log(`# ${report.note}\n`);
  for (const [k, v] of Object.entries(report.timings)) console.log(`${k}=${v}`);
  console.log(`PRODUCT_REFS_PERSISTED_PER_THREAD=${report.PRODUCT_REFS_PERSISTED_PER_THREAD}`);
  console.log(`MAX_ACTIVE_PRODUCT_EXCLUSIONS=${report.MAX_ACTIVE_PRODUCT_EXCLUSIONS}`);
  console.log(`PROVIDER_CALLS_PER_JOURNEY=${report.PROVIDER_CALLS_PER_JOURNEY} (5 turns)`);
  console.log(`PERSISTED_STATE_BYTES=${report.PERSISTED_STATE_BYTES}`);
}

main();
