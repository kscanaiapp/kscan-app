/**
 * Rationale facts and the transaction floor, as the client sees them (§7, §18,
 * §19, §20). One set of facts, two renderings — never two explanations.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Edge-function modules are Deno TypeScript. They run fine under `node --test`
 * (type stripping), but a STATIC `require('../../supabase/functions/...')`
 * makes the root `tsc` follow the specifier into a tree its tsconfig
 * deliberately excludes, and the Deno globals there then fail the root
 * typecheck. Resolving through a computed path keeps the runtime behaviour
 * identical and the static graph honest — the same approach
 * `__tests__/multiItemCommerceV127Rollback.test.js` and the Curiosity Gap
 * suite already use.
 */
const ROOT = path.resolve(__dirname, '../..');
const edge = (name) => require(path.join(ROOT, 'supabase/functions/scan-identify', name));
const client = (name) => require(path.join(ROOT, 'services/commerce', name));


const {
  rationaleLines,
  recommendationLabel,
  eliseRationaleFacts,
  ownershipStatement,
} = client('commerceRationale.ts');
const {
  resolveCommercialUsability,
  canActivateTransaction,
  availabilityLabel,
} = client('commercialUsability.ts');
const {
  buildShoppingContext,
  closetContribution,
  signatureStyleContribution,
  packingGapContribution,
} = client('shoppingContext.ts');

/**
 * `commerceHydration.ts` pulls in the Supabase client, and `ProductShelf.tsx`
 * pulls in React Native; neither loads under `node --test`. The established
 * pattern in `__tests__/commerceHydrationV127.test.js` is to transpile the real
 * module and shim its one transport dependency, which is what this does — so
 * "the body carried the context" means the real builder produced it.
 *
 * ProductShelf's gating is asserted two ways: its shared authority is exercised
 * directly (it is the same module the component calls), and the component's
 * wiring to it is asserted against source.
 */
function loadWithShim(relativePath, shims = {}) {
  const source = fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
  const ts = require('typescript');
  const js = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const requireShim = (id) => {
    if (Object.prototype.hasOwnProperty.call(shims, id)) return shims[id];
    if (id.startsWith('node:')) return require(id);
    return {};
  };
  new Function('exports', 'module', 'require', js)(mod.exports, mod, requireShim);
  return mod.exports;
}

const { buildCommerceOnlyBody } = loadWithShim('services/commerceHydration.ts', {
  './supabaseClient': { supabase: { functions: { invoke: async () => ({ data: null, error: null }) } } },
});

const PRODUCT_SHELF_SOURCE = fs.readFileSync(
  path.join(__dirname, '../../components/ProductShelf.tsx'),
  'utf8',
);

/** The exact decision ProductShelf.canShopProduct delegates to. */
function canShopProduct(product) {
  return canActivateTransaction(resolveCommercialUsability({
    commercialUsability: product?.commercialUsability,
    type: product?.type,
    price: product?.price,
    availability: product?.availability,
    destinationUrl: product?.productUrl ?? null,
  }));
}
const productCommercialUsability = (product) => resolveCommercialUsability({
  commercialUsability: product?.commercialUsability,
  type: product?.type,
  price: product?.price,
  availability: product?.availability,
  destinationUrl: product?.productUrl ?? null,
});
const canWatchProduct = (product) => product?.watchCapability === 'refreshable_listing';

function facts(overrides = {}) {
  return {
    matchedAttributes: [],
    factCodes: [],
    budgetFit: 'unknown',
    usability: 'TRANSACTION_READY',
    gap: null,
    relationship: 'external',
    priceComparable: false,
    ...overrides,
  };
}

// ── One set of facts, two renderings ───────────────────────────────────────

test('the product UI and Elise are handed the SAME facts', () => {
  const f = facts({ factCodes: ['confirmed_gap_match', 'budget_within'], budgetFit: 'within', matchedAttributes: ['waterproof'] });
  const forElise = eliseRationaleFacts(f);
  assert.deepEqual(forElise.factCodes, f.factCodes, 'Elise gets the codes, not the rendered copy');
  assert.deepEqual(forElise.matchedAttributes, f.matchedAttributes);
  assert.equal(forElise.budgetFit, 'within');
  assert.deepEqual(rationaleLines(f), ['Fills a gap in what you packed', 'Within your budget']);
});

test('Elise receives codes, never prose — so there is no second explanation', () => {
  const forElise = eliseRationaleFacts(facts({ factCodes: ['duplicate_of_owned'] }));
  const serialized = JSON.stringify(forElise);
  assert.equal(serialized.includes('Closet'), false, 'no rendered copy may leak into the conversational path');
  assert.deepEqual(forElise.factCodes, ['duplicate_of_owned']);
});

test('an unconfirmed gap is hedged in the words a user actually reads', () => {
  const lines = rationaleLines(facts({ factCodes: ['unconfirmed_gap_context'] }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /couldn't confirm/i, 'the firewall must survive into the copy');
  assert.equal(/don't have|do not have/i.test(lines[0]), false);
});

test('rationale is bounded — a card explains itself, it does not recite a scorecard', () => {
  const lines = rationaleLines(facts({
    factCodes: ['explicit_color_match', 'explicit_material_match', 'functional_requirement_met', 'budget_within', 'occasion_match'],
  }));
  assert.ok(lines.length <= 3);
});

test('an unknown fact code renders nothing rather than a placeholder', () => {
  assert.deepEqual(rationaleLines(facts({ factCodes: ['not_a_real_code'] })), []);
  assert.deepEqual(rationaleLines(null), []);
});

test('every Commerce candidate states the same ownership truth', () => {
  assert.equal(ownershipStatement(facts()), 'Not in your Closet');
  assert.equal(ownershipStatement(null), 'Not in your Closet');
});

// ── Transaction floor (§19) ────────────────────────────────────────────────

test('Buy availability derives from usability, never from rank or label', () => {
  const browseOnly = { type: 'similar', productUrl: 'https://shop.com/a', matchScore: 0.99, similarityPercentage: 99 };
  assert.equal(canShopProduct(browseOnly), false, 'a perfect score does not make it buyable');

  const topRanked = { type: 'retail', price: '', productUrl: 'https://shop.com/b', matchScore: 1 };
  assert.equal(canShopProduct(topRanked), false, 'rank position is not a commercial fact');

  const real = { type: 'retail', price: '$120.00', productUrl: 'https://shop.com/c' };
  assert.equal(canShopProduct(real), true);
});

test('the client trusts the server classification when present, and re-derives it when not', () => {
  const serverSaid = { commercialUsability: 'BROWSE_ONLY', type: 'retail', price: '$10.00', productUrl: 'https://shop.com/a' };
  assert.equal(productCommercialUsability(serverSaid), 'BROWSE_ONLY');
  assert.equal(canShopProduct(serverSaid), false);

  const legacyRow = { type: 'retail', price: '$10.00', productUrl: 'https://shop.com/a' };
  assert.equal(productCommercialUsability(legacyRow), 'TRANSACTION_READY', 'an older response still classifies');
});

test('an unrecognised server classification is not trusted', () => {
  assert.equal(
    resolveCommercialUsability({ commercialUsability: 'DEFINITELY_BUY_THIS', type: 'similar', destinationUrl: 'https://a.com/x' }),
    'BROWSE_ONLY',
  );
});

test('a declared out-of-stock offer cannot activate Buy, and says so honestly', () => {
  const oos = { type: 'retail', price: '$10.00', availability: 'out_of_stock', productUrl: 'https://shop.com/a' };
  const usability = productCommercialUsability(oos);
  assert.equal(usability, 'BROWSE_ONLY');
  assert.equal(canActivateTransaction(usability), false);
  assert.equal(availabilityLabel(usability, 'out_of_stock'), 'Out of stock');
});

test('ProductShelf actually routes its Shop action through the shared authority', () => {
  assert.match(
    PRODUCT_SHELF_SOURCE,
    /from '\.\.\/services\/commerce\/commercialUsability'/,
    'the component must not hand-roll a second usability rule',
  );
  assert.match(PRODUCT_SHELF_SOURCE, /const canShop = canShopProduct\(p\);/);
  assert.match(
    PRODUCT_SHELF_SOURCE,
    /onShop=\{canShop && hasLink \? \(\) => handleLinkPress\(purchaseUrl\) : undefined\}/,
    'the Shop entry point must be gated on usability, not only on having a link',
  );
  assert.equal(
    /onShop=\{hasLink \?/.test(PRODUCT_SHELF_SOURCE),
    false,
    'no ungated Shop entry point may remain',
  );
});

test('Watch eligibility remains the existing server-authored decision, untouched', () => {
  assert.equal(canWatchProduct({ watchCapability: 'refreshable_listing' }), true);
  assert.equal(canWatchProduct({ watchCapability: 'unsupported' }), false);
  // Usability and watchability are independent: this lane did not redesign
  // either, and a transactable listing is not automatically watchable.
  assert.equal(canWatchProduct({ type: 'retail', price: '$10.00', productUrl: 'https://shop.com/a' }), false);
});

// ── Labels ─────────────────────────────────────────────────────────────────

test('there are no four fixed marketing roles to fill', () => {
  const plain = [facts({ usability: 'BROWSE_ONLY' }), facts({ usability: 'BROWSE_ONLY' }), facts({ usability: 'BROWSE_ONLY' })];
  const labels = plain.map((f, i) => recommendationLabel({ rankIndex: i, facts: f }));
  assert.deepEqual(labels, [null, null, null], 'nothing distinctive to say means nothing is said');
});

test('CLOSEST VISUAL MATCH is not available, because no visual signal supports it', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../services/commerce/commerceRationale.ts'), 'utf8');
  const labelUnion = src.match(/export type RecommendationLabel = ([^;]+);/)[1];
  assert.equal(/VISUAL/.test(labelUnion), false);
});

// ── Client → server transport (§11 fast path) ──────────────────────────────

test('a request with no context sends no context field at all', () => {
  const body = buildCommerceOnlyBody({ identification: { item_type: 'outerwear' } });
  assert.equal('shoppingContext' in body, false, 'the cold path must be byte-identical to before');
  assert.equal('shoppingText' in body, false);
});

test('assembled context rides the existing commerce_only body', () => {
  const context = buildShoppingContext([
    closetContribution({
      actorId: 'actor-1',
      category: 'boot',
      items: [{ title: 'Black Leather Chelsea Boot', category: 'boot', color: 'black', material: 'leather' }],
    }),
    signatureStyleContribution({ actorId: 'actor-1', tokens: ['minimal', 'neutral'] }),
    packingGapContribution({ gapCode: 'missing_weather_layer', label: 'A light rain layer', certainty: 'confirmed' }),
  ]);
  const body = buildCommerceOnlyBody({
    identification: { item_type: 'footwear' },
    shoppingContext: context,
    shoppingText: 'something under $200',
  });
  assert.equal(body.requestMode, 'commerce_only');
  assert.equal(body.shoppingContext.length, 3);
  assert.equal(body.shoppingText, 'something under $200');
});

test('Closet context carries no item ids off the device', () => {
  const contribution = closetContribution({
    actorId: 'actor-1',
    items: [{ title: 'Black Leather Chelsea Boot', category: 'boot', color: 'black', material: 'leather', id: 'secret-uuid' }],
  });
  assert.equal(JSON.stringify(contribution).includes('secret-uuid'), false);
});

test('Closet context is filtered to the category actually being shopped for', () => {
  const contribution = closetContribution({
    actorId: 'actor-1',
    category: 'boot',
    items: [
      { title: 'Black Leather Chelsea Boot', category: 'boot' },
      { title: 'Navy Wool Coat', category: 'outerwear' },
    ],
  });
  assert.equal(contribution.relevantOwned.length, 1);
  assert.equal(contribution.relevantOwned[0].descriptor, 'black leather chelsea boot');
});

test('a gap contribution copies certainty and refuses to invent one', () => {
  assert.equal(packingGapContribution({ gapCode: 'g', label: 'L', certainty: 'confirmed' }).gapRelationship.certainty, 'confirmed');
  assert.equal(packingGapContribution({ gapCode: 'g', label: 'L', certainty: 'unconfirmed' }).gapRelationship.certainty, 'unconfirmed');
  assert.equal(packingGapContribution({ gapCode: 'g', label: 'L', certainty: 'probably' }), null);
  assert.equal(packingGapContribution({ gapCode: 'g', label: 'L' }), null);
});

test('an empty assembly returns null so the caller can omit the field', () => {
  assert.equal(buildShoppingContext([null, undefined]), null);
  assert.equal(closetContribution({ actorId: 'a', items: [] }), null);
  assert.equal(signatureStyleContribution({ actorId: 'a', tokens: [] }), null);
});
