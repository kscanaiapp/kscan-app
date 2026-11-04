// OC-01 mobile contract (`oc01-products-v1`): the real parser, the real
// provider transport, the real hook wiring and the real results block.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  byTestId,
  byType,
  createReactNativeStub,
  createRenderer,
  deepStub,
  findAll,
  runModule,
  settle,
  textContent,
} = require('./helpers/componentRenderer');

const ROOT = path.resolve(__dirname, '..');
const destination = runModule('services/commerceDestination.ts', {}, { jsx: false });
const discovery = runModule('services/blackOwnedDiscovery.ts', {}, { jsx: false });
const contract = runModule('services/style-chat/eliseCommerceResults.ts', {
  '../commerceDestination': destination,
  '../blackOwnedDiscovery': discovery,
}, { jsx: false });

const future = new Date(Date.now() + 86_400_000).toISOString();
function product(n, extra = {}) {
  return {
    number: n,
    title: `Black leather bomber jacket ${n}`,
    merchant: 'Nordline',
    productUrl: `https://www.nordline.shop/p/${n}`,
    imageUrl: `https://cdn.nordline.shop/${n}.jpg`,
    listedPrice: '$89.00',
    currency: 'USD',
    source: 'shopping_provider',
    observedAt: new Date().toISOString(),
    ...extra,
  };
}
const payload = (extra = {}) => ({ version: 'oc01-products-v1', kind: 'find', status: 'ready', reasonCode: null, products: [product(1), product(2)], ...extra });

// ── Parser ──────────────────────────────────────────────────────────────────

test('valid oc01-products-v1 payload parses to closed records', () => {
  const parsed = contract.parseEliseCommerceResults(payload());
  assert.equal(parsed.products.length, 2);
  assert.deepEqual(Object.keys(parsed).sort(), ['kind', 'products', 'reasonCode', 'status', 'version']);
  const block = contract.toEliseCommerceBlock(parsed);
  assert.equal(block.type, 'elise_commerce_results');
  assert.deepEqual(contract.parseEliseCommerceBlock(JSON.parse(JSON.stringify(block))), parsed, 'stored block round-trips');
});

test('unknown version, malformed envelope or any malformed product renders nothing', () => {
  const bad = [
    null, 'x', [], payload({ version: 'oc01-products-v2' }), payload({ version: undefined }),
    payload({ kind: 'purchase' }), payload({ status: 'bought' }), payload({ products: 'x' }),
    payload({ products: Array.from({ length: 9 }, (_, i) => product(i + 1)) }),
    payload({ products: [] }), payload({ status: 'empty' }),
    payload({ products: [product(2)] }),
    payload({ products: [product(1, { productUrl: 'javascript:alert(1)' })] }),
    payload({ products: [product(1, { productUrl: 'http://www.nordline.shop/p/1' })] }),
    payload({ products: [product(1, { productUrl: 'https://192.168.0.1/p' })] }),
    payload({ products: [product(1, { title: '<script>' })] }),
    payload({ products: [product(1, { source: 'model' })] }),
    payload({ products: [product(1, { observedAt: 'yesterday' })] }),
    payload({ reasonCode: { nested: true } }),
  ];
  for (const value of bad) assert.equal(contract.parseEliseCommerceResults(value), null, JSON.stringify(value)?.slice(0, 120));
  assert.equal(contract.parseEliseCommerceBlock({ type: 'other', ...payload() }), null);
});

test('ownership labels survive only on verified-catalog records with a live verified identity', () => {
  const identity = { brandId: 'b1', brandName: 'Nordline', ownershipVerificationStatus: 'verified', publicOwnershipLabelAllowed: true, verifiedUntil: future };
  const shopping = contract.parseEliseCommerceResults(payload({ products: [product(1, { ownershipIdentity: identity })] }));
  assert.equal('ownershipIdentity' in shopping.products[0], false, 'never on a shopping-provider record');
  const catalog = contract.parseEliseCommerceResults(payload({ kind: 'black_owned', products: [product(1, { source: 'verified_catalog', ownershipIdentity: identity })] }));
  assert.deepEqual(catalog.products[0].ownershipIdentity, identity);
  const expired = contract.parseEliseCommerceResults(payload({ kind: 'black_owned', products: [product(1, { source: 'verified_catalog', ownershipIdentity: { ...identity, verifiedUntil: '2020-01-01T00:00:00Z' } })] }));
  assert.equal('ownershipIdentity' in expired.products[0], false);
  const unlabelled = contract.parseEliseCommerceResults(payload({ kind: 'black_owned', products: [product(1, { source: 'verified_catalog', ownershipIdentity: { ...identity, publicOwnershipLabelAllowed: false } })] }));
  assert.equal('ownershipIdentity' in unlabelled.products[0], false);
});

test('non-ready states are closed and carry no products', () => {
  for (const status of ['empty', 'unavailable', 'expired', 'unsupported_action', 'denied']) {
    const r = contract.parseEliseCommerceResults(payload({ status, reasonCode: status === 'expired' ? 'foreign_or_stale_reference' : null, products: [] }));
    assert.equal(r.status, status);
    assert.equal(typeof contract.ELISE_COMMERCE_NOTICE[status], 'string');
  }
  for (const copy of [...Object.values(contract.ELISE_COMMERCE_NOTICE), contract.ELISE_COMMERCE_BLACK_OWNED_EMPTY]) {
    assert.doesNotMatch(copy, /\$\d|in stock|approv|confirm|soon|yet/i);
  }
});

// ── Provider transport ─────────────────────────────────────────────────────

const providerSource = fs.readFileSync(path.join(ROOT, 'services/style-chat/providers/edgeStyleChatProvider.ts'), 'utf8');
function loadProvider(invoke) {
  return runModule('services/style-chat/providers/edgeStyleChatProvider.ts', {
    '../../supabaseClient': { supabase: { functions: { invoke } } },
    '../../../constants/styleChat': require('../constants/styleChat.ts'),
    '../../../constants/featureFlags': { ELISE_ADVICE_METADATA_CLIENT_V1: false },
    '../styleChatErrors': { getFriendlyStyleChatError: () => 'error' },
    '../../../types/styleChatAttachments': require('../types/styleChatAttachments.ts'),
    '../../../types/fashionIdentificationV2': { ELISE_FASHION_CONTEXT_V2: 'elise-fashion-context-v2' },
    '../eliseFashionContextV2': { prepareContextForTransport: () => ({ kind: 'invalid' }) },
  }, { jsx: false }).EdgeStyleChatProvider;
}

test('provider advertises the capability by HEADER and keeps the exact v1 body', async () => {
  const calls = [];
  const Provider = loadProvider(async (name, options) => {
    calls.push(options);
    return { data: { status: 'success', message: { sender: 'assistant', content: 'Here you go.', model: 'm', tokenEstimate: 3 }, usage: { messagesUsed: 1, messagesLimit: 50 }, commerceResults: payload() }, error: null };
  });
  const result = await new Provider().generateReply({ sessionId: '11111111-1111-4111-8111-111111111111', message: 'Find a bomber' });
  assert.deepEqual(calls[0].body, { sessionId: '11111111-1111-4111-8111-111111111111', message: 'Find a bomber' });
  assert.deepEqual(calls[0].headers, { 'X-KScan-Client-Capabilities': contract.ELISE_COMMERCE_CLIENT_CAPABILITY });
  assert.equal(contract.ELISE_COMMERCE_CLIENT_CAPABILITY, 'oc01-products-v1');
  assert.ok(result.commerceResults, 'passed through for the hook to validate');
  assert.match(providerSource, /ELISE_CLIENT_CAPABILITIES = 'oc01-products-v1'/);
});

test('provider omits non-object commerce payloads and ordinary replies stay unchanged', async () => {
  for (const commerceResults of [undefined, 'x', 7, null]) {
    const Provider = loadProvider(async () => ({ data: { status: 'success', message: { sender: 'assistant', content: 'Navy works.', model: 'm', tokenEstimate: 3 }, usage: { messagesUsed: 1, messagesLimit: 50 }, ...(commerceResults === undefined ? {} : { commerceResults }) }, error: null }));
    const result = await new Provider().generateReply({ sessionId: '11111111-1111-4111-8111-111111111111', message: 'hi' });
    assert.equal('commerceResults' in result, false);
    assert.equal(result.message.content, 'Navy works.');
  }
});

test('hook validates once and stores only a validated block; bubble re-validates on render', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useStyleChat.ts'), 'utf8');
  assert.match(hook, /const commerceResults = parseEliseCommerceResults\(result\.commerceResults\);/);
  assert.match(hook, /toEliseCommerceBlock\(commerceResults\)/);
  const bubble = fs.readFileSync(path.join(ROOT, 'components/style-chat/StyleChatBubble.tsx'), 'utf8');
  assert.match(bubble, /const results = parseEliseCommerceBlock\(block\);/);
});

// ── Rendered results block ─────────────────────────────────────────────────

function renderBlock(results) {
  const renderer = createRenderer();
  const opened = [];
  const ProductCard = (props) => ({ type: 'ProductCard', props, key: null });
  const InlineNotice = (props) => ({ type: 'InlineNotice', props, key: null });
  const mod = runModule('components/style-chat/EliseCommerceResultsBlock.tsx', {
    ...renderer.runtimeModules,
    'react-native': createReactNativeStub(),
    '../../constants/theme': { LUXURY: deepStub(), RADIUS: deepStub(), SPACING: deepStub() },
    '../luxury/ProductCard': { ProductCard },
    '../luxury/InlineNotice': { InlineNotice },
    '../../services/openExternalUrl': { openExternalUrl: async (url) => { opened.push(url); return url.startsWith('https://'); } },
    '../../services/style-chat/eliseCommerceResults': contract,
  });
  const tree = renderer.render({ type: mod.EliseCommerceResultsBlock, props: { results }, key: null });
  return { tree, opened, renderer, mod };
}

test('ready results render merchant cards that open only the merchant link', async () => {
  const { tree, opened } = renderBlock(contract.parseEliseCommerceResults(payload()));
  const cards = findAll(tree, (n) => n.type === 'ProductCard');
  assert.equal(cards.length, 2);
  assert.equal(cards[0].props.title, 'Black leather bomber jacket 1');
  assert.equal(cards[0].props.subtitle, 'Nordline');
  assert.equal(cards[0].props.price, '$89.00');
  assert.match(cards[0].props.accessibilityLabel, /Opens in your browser/, 'no destinationKind: never claimed as the merchant page');
  cards[1].props.onPress();
  await settle();
  assert.deepEqual(opened, ['https://www.nordline.shop/p/2']);
  assert.match(textContent(byTestId(tree, 'elise-commerce-results-disclosure')), /as listed by the merchant/);
  assert.equal(byTestId(tree, 'elise-commerce-results-comparison').length, 0);
});

test('comparison renders a table of listed facts only, with explicit gaps', () => {
  const results = contract.parseEliseCommerceResults(payload({ kind: 'compare', products: [product(1), product(2, { listedPrice: undefined, currency: undefined })] }));
  const { tree } = renderBlock(results);
  const table = textContent(byTestId(tree, 'elise-commerce-results-comparison'));
  assert.match(table, /Listed \$89\.00/);
  assert.match(table, /Price not listed/);
  assert.doesNotMatch(table, /in stock|ships|best|winner/i);
});

test('empty, expired, unavailable and declined states render deterministic notices, never cards', () => {
  for (const [status, kind, expected] of [
    ['empty', 'find', contract.ELISE_COMMERCE_NOTICE.empty],
    ['empty', 'black_owned', contract.ELISE_COMMERCE_BLACK_OWNED_EMPTY],
    ['expired', 'compare', contract.ELISE_COMMERCE_NOTICE.expired],
    ['unavailable', 'find', contract.ELISE_COMMERCE_NOTICE.unavailable],
    ['unsupported_action', 'action', contract.ELISE_COMMERCE_NOTICE.unsupported_action],
  ]) {
    const { tree } = renderBlock(contract.parseEliseCommerceResults(payload({ status, kind, products: [] })));
    assert.equal(findAll(tree, (n) => n.type === 'ProductCard').length, 0);
    const notices = findAll(tree, (n) => n.type === 'InlineNotice');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].props.body, expected);
  }
});

test('destination kind: merchant pages and shopping-search handoffs are labelled honestly', () => {
  const parsed = contract.parseEliseCommerceResults(payload({ products: [
    product(1, { destinationKind: 'merchant' }),
    product(2, { destinationKind: 'shopping_search', productUrl: 'https://www.google.com/shopping/product/2' }),
    product(3, { destinationKind: 'bogus' }),
  ] }));
  assert.deepEqual(parsed.products.map((p) => p.destinationKind), ['merchant', 'shopping_search', undefined]);
  const { tree } = renderBlock(parsed);
  const cards = findAll(tree, (n) => n.type === 'ProductCard');
  assert.match(cards[0].props.accessibilityLabel, /Opens the merchant's site/);
  assert.equal(cards[0].props.subtitle, 'Nordline');
  assert.match(cards[1].props.accessibilityLabel, /shopping search results/);
  assert.equal(cards[1].props.subtitle, 'Nordline · via shopping search');
  assert.match(cards[2].props.accessibilityLabel, /Opens in your browser/);
});
