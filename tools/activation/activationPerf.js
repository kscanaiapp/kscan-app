#!/usr/bin/env node
/**
 * Activation performance (activation brief section 37).
 *
 * Measures LOCAL assembly cost only. Provider and network latency are
 * deliberately excluded and reported as such: conflating them would let a slow
 * retailer make this lane's code look expensive, or a fast one hide it.
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));

const { validateStyleChatActions, extractActionsBlock } = chat('actions.ts');
const { reduceShoppingIntent } = chat('eliseCommerceIntent.ts');
const activation = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');
const { buildShoppingIntent, parseContextContributions } = edge('commerceShoppingIntent.ts');

const CLOSET = Array.from({ length: 40 }, (_, i) => ({
  title: i % 3 === 0 ? `Black Leather Boot ${i}` : `Navy Wool Coat ${i}`,
  category: i % 3 === 0 ? 'boot' : 'outerwear',
  color: i % 3 === 0 ? 'black' : 'navy',
  material: i % 3 === 0 ? 'leather' : 'wool',
}));

const STYLE_TOKENS = ['minimal', 'tailored', 'neutral'];

const MODEL_TEXT =
  'Here are a few options.\n<actions>[{"type":"find_products","shopping":{"category":"shoes","budgetAmount":120,"budgetCurrency":"USD","excludeMaterials":["leather"]}}]</actions>';

const UNIVERSE = Array.from({ length: 20 }, (_, i) => ({
  id: `p${i}`,
  title: `${['Black', 'Brown', 'Navy'][i % 3]} ${['Suede', 'Canvas', 'Leather'][i % 3]} ${['Boot', 'Loafer', 'Derby'][i % 3]} ${i}`,
  price: `$${60 + i * 7}.00`,
  currency: 'USD',
  type: 'retail',
  source: ['Farfetch', 'Poshmark', 'KicksCrew', 'Serper', 'Brave'][i % 5],
  imageUrl: `https://img.cdn.io/p${i}.jpg`,
  productUrl: `https://www.shop${i % 5}.com/p${i}.aspx`,
}));

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

function timed(fn, iterations) {
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const t = process.hrtime.bigint();
    fn();
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  return +median(samples).toFixed(4);
}

function run() {
  const WARMUP = 200;
  const N = 500;

  const parseAction = () => {
    const extracted = extractActionsBlock(MODEL_TEXT);
    return validateStyleChatActions(extracted.rawActions, [])[0];
  };
  const act = parseAction();

  const reduce = () => reduceShoppingIntent({ previous: null, message: 'different shoes under $120', payload: act.payload.shopping });
  const reduced = reduce();
  const wire = activation.parseShoppingIntentWire({ blockType: 'commerce_shopping_intent', state: reduced.state, needsBudgetReference: false });

  const closetSelect = () => activation.selectClosetContext({ actorId: 'a', category: 'footwear', items: CLOSET });
  const styleSelect = () => activation.selectSignatureStyleContext({ actorId: 'a', tokens: STYLE_TOKENS });
  const buildEvidence = () => activation.buildActivationEvidence({
    state: wire.state, actorId: 'a', closetItems: CLOSET, signatureStyleTokens: STYLE_TOKENS,
  });
  const evidence = buildEvidence();

  const rankBaseline = () => filterAndDedupeProducts(UNIVERSE, evidence.identification, { enabled: true, categoryRoute: 'footwear' });
  const contextIntent = buildShoppingIntent(parseContextContributions(evidence.shoppingContext), 'a');
  const rankWithContext = () => filterAndDedupeProducts(UNIVERSE, evidence.identification, {
    enabled: true, categoryRoute: 'footwear', shoppingContext: contextIntent, requestActorId: 'a',
  });

  for (let i = 0; i < WARMUP; i += 1) { parseAction(); reduce(); buildEvidence(); rankBaseline(); rankWithContext(); }

  const actionMs = timed(parseAction, N);
  const reduceMs = timed(reduce, N);
  const closetMs = timed(closetSelect, N);
  const styleMs = timed(styleSelect, N);
  const evidenceMs = timed(buildEvidence, N);
  const baselineRankMs = timed(rankBaseline, N);
  const contextRankMs = timed(rankWithContext, N);

  const contextAssembly = +(actionMs + reduceMs + evidenceMs).toFixed(4);
  const rankingOverhead = +(contextRankMs - baselineRankMs).toFixed(4);

  return {
    candidates: UNIVERSE.length,
    closetSize: CLOSET.length,
    iterations: N,
    ELISE_CONTEXT_ASSEMBLY_MS: contextAssembly,
    CLOSET_SELECTION_MS: closetMs,
    SIGNATURE_STYLE_CONTEXT_MS: styleMs,
    PACKING_BRIDGE_MS: timed(
      () => require(path.join(ROOT, 'supabase/functions/scan-identify/commercePackingBridge.ts'))
        .contributionFromPackingGap({ code: 'missing_weather_layer', label: 'A light rain layer', certainty: 'confirmed', source: 'weather' }),
      N,
    ),
    LOCAL_ACTIVATION_OVERHEAD_MS: +(contextAssembly + rankingOverhead).toFixed(4),
    RANKING_OVERHEAD_MS: rankingOverhead,
    breakdown: { actionParseMs: actionMs, reducerMs: reduceMs, evidenceBuildMs: evidenceMs, baselineRankMs, contextRankMs },
    MAX_CLOSET_CONTEXT_ITEMS: activation.MAX_CLOSET_CONTEXT_ITEMS,
    MODEL_TURNS_PER_NORMAL_ELISE_TURN: 1,
    MODEL_TURNS_PER_COMMERCE_ELISE_TURN: 1,
    TOOL_TURNS_ADDED: 0,
    COMMERCE_SIDE_LLM_CALLS_ADDED: 0,
    COMMERCE_PROVIDER_CALLS_PER_JOURNEY: 1,
    LATENCY_TO_SHELF_MS: 'NOT MEASURED — dominated by the provider round trip, which this lane does not change and cannot measure offline',
    FIRST_TEXT_MS_COMMERCE_TURN: 'UNCHANGED — the optimistic assistant renders before Commerce runs (hooks/useStyleChat.ts)',
    benchmarkStatus: 'INTERNAL ENGINEERING EVIDENCE ONLY',
  };
}

if (require.main === module) console.log(JSON.stringify(run(), null, 2));
module.exports = { run };
