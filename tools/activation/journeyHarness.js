#!/usr/bin/env node
/**
 * Elise -> Commerce journey harness (activation brief sections 11 and 35).
 *
 * Runs the REAL pieces end to end with exactly one thing stubbed: the network.
 * The model's action goes through the real `validateStyleChatActions`, the real
 * `reduceShoppingIntent`, the real wire validator, the real client activation,
 * and the real #409 `filterAndDedupeProducts`. Only `fetchDeferredCommerce` is
 * replaced, by a fixture provider that runs the real ranking over a fixed
 * candidate universe.
 *
 * That is what makes a journey result evidence rather than a mock agreeing
 * with itself.
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));
const client = (n) => require(path.join(ROOT, 'services/style-chat', n));

const { validateStyleChatActions, extractActionsBlock } = chat('actions.ts');
const { reduceShoppingIntent, findLatestShoppingIntent } = chat('eliseCommerceIntent.ts');
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');
const { buildShoppingIntent, parseContextContributions } = edge('commerceShoppingIntent.ts');
const { attachCommercialUsability } = edge('commerceContextualRanking.ts');
const activation = client('commerceActivation.ts');

const product = (id, title, price, o = {}) => ({
  id,
  title,
  price,
  currency: o.currency === null ? undefined : (o.currency ?? 'USD'),
  type: o.type ?? 'retail',
  source: o.source ?? 'Farfetch',
  imageUrl: `https://img.cdn.io/${id}.jpg`,
  productUrl: o.productUrl ?? `https://www.farfetch.com/shopping/${id}.aspx`,
  ...(o.availability ? { availability: o.availability } : {}),
  ...(o.extra ?? {}),
});

/** The shoe universe Journey A searches. Fixed, so ordering claims are checkable. */
const SHOE_UNIVERSE = [
  product('s_chelsea', 'Black Leather Chelsea Boot', '$300.00'),
  product('s_suede', 'Black Suede Ankle Boot', '$110.00', { source: 'Poshmark' }),
  product('s_derby', 'Brown Leather Derby Shoe', '$95.00', { source: 'KicksCrew' }),
  product('s_loafer', 'Black Canvas Loafer', '$70.00', { source: 'Serper' }),
];

const ROUTE_BY_CATEGORY = {
  footwear: 'footwear',
  outerwear: 'outerwear',
  dress: 'apparel',
  pants: 'apparel',
  top: 'apparel',
  bag: 'accessory',
  accessory: 'accessory',
};

/**
 * A fixture provider that runs the REAL #409 path.
 *
 * It performs the server's job for a `commerce_only` body: re-validate the
 * client's context contributions, rank the universe, and attach the
 * response-boundary annotations. Nothing about ranking is reimplemented.
 */
function makeFixtureProvider(options = {}) {
  const calls = [];
  const universe = options.universe ?? SHOE_UNIVERSE;
  const fetchCommerce = async (evidence) => {
    calls.push(evidence);
    if (options.failWith) {
      return { status: 'error', purchaseOptions: [], enrichmentCandidates: [], cacheHit: false, errorType: options.failWith, retryable: true };
    }
    const identification = evidence.identification ?? {};
    const contributions = parseContextContributions(evidence.shoppingContext);
    const intent = buildShoppingIntent(contributions, options.actorId ?? null);
    const route = ROUTE_BY_CATEGORY[String(identification.item_type)] ?? 'apparel';
    const res = filterAndDedupeProducts(universe, identification, {
      enabled: true,
      categoryRoute: route,
      shoppingContext: intent,
      requestActorId: options.actorId ?? null,
    });
    const annotated = attachCommercialUsability(res.products);
    return {
      status: annotated.length > 0 ? 'success' : 'empty',
      purchaseOptions: annotated,
      enrichmentCandidates: [],
      cacheHit: false,
      retryable: annotated.length === 0,
    };
  };
  return { fetchCommerce, calls };
}

/**
 * One full turn: model text -> action -> reducer -> wire -> client -> block.
 *
 * `priorRows` are the persisted assistant rows, exactly as the server reads
 * them, so intent continuity is exercised through the real storage shape
 * rather than by handing state around in memory.
 */
async function runTurn(input) {
  const modelText = input.modelText ?? '';
  const extracted = extractActionsBlock(modelText);
  const actions = validateStyleChatActions(extracted.rawActions, []);
  const commerceAction = actions.find((a) => a.type === 'find_products');

  const previous = findLatestShoppingIntent(input.priorRows ?? []);
  if (!commerceAction) {
    return { prose: extracted.text.trim(), blocks: [], status: 'skipped', commerceCalls: 0, state: previous };
  }

  const reduced = reduceShoppingIntent({
    previous,
    message: input.message,
    payload: commerceAction.payload.shopping ?? null,
  });

  const wire = activation.parseShoppingIntentWire({
    blockType: 'commerce_shopping_intent',
    state: reduced.state,
    needsBudgetReference: reduced.needsBudgetReference,
  });

  const provider = input.provider ?? makeFixtureProvider({ actorId: input.actorId ?? null });
  const outcome = await activation.runCommerceActivation({
    wire,
    actorId: input.actorId ?? null,
    deps: {
      fetchCommerce: provider.fetchCommerce,
      ...(input.closetItems ? { loadClosetItems: async () => input.closetItems } : {}),
      ...(input.styleTokens ? { loadSignatureStyleTokens: async () => input.styleTokens } : {}),
    },
  });

  const productsBlock = outcome.blocks.find((b) => b.type === 'commerce_products');
  return {
    prose: extracted.text.trim(),
    blocks: outcome.blocks,
    status: outcome.status,
    needsBudgetReference: outcome.needsBudgetReference,
    commerceCalls: outcome.commerceCalls,
    reset: reduced.reset,
    state: reduced.state,
    products: productsBlock?.products?.map((p) => p.id) ?? [],
    productDetail: productsBlock?.products ?? [],
    providerCalls: provider.calls,
    /** The rows a client would persist, for the next turn. */
    rows: [{ sender: 'assistant', ui_blocks: outcome.blocks }, ...(input.priorRows ?? [])],
  };
}

module.exports = { runTurn, makeFixtureProvider, SHOE_UNIVERSE, product };

if (require.main === module) {
  (async () => {
    const a = await runTurn({
      message: 'I like this outfit, but show me different shoes under $120.',
      modelText: 'Here are a few that would work.\n<actions>[{"type":"find_products","shopping":{"category":"shoes","budgetAmount":120,"budgetCurrency":"USD"}}]</actions>',
    });
    console.log(JSON.stringify({ prose: a.prose, products: a.products, status: a.status, calls: a.commerceCalls }, null, 1));
  })();
}
