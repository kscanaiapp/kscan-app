// Live Scan Results integration of the independent Black-owned discovery
// request: primary-first ordering, deferred invocation, cancellation and
// supersession, privacy of the request, async ownership badges keyed by id,
// stable primary order, duplicate suppression, sponsored exclusion, and the
// disabled path. Platform-neutral: no Platform.OS branch exists, so the same
// rules hold on iOS and Android (device layout still needs device review).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const ROOT = path.join(__dirname, '..');
const plain = (v) => JSON.parse(JSON.stringify(v));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
function load(file, resolve = () => undefined) {
  const js = ts.transpileModule(read(file), { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(js, { module, exports: module.exports, require: (name) => resolve(name) ?? require(name), URL, Date, Set, Map, Promise, AbortController, setTimeout, clearTimeout, JSON, Object, Array, Number, String });
  return module.exports;
}

const client = load('services/blackOwnedDiscovery.ts');
const host = load('services/blackOwnedDiscoveryHost.ts', (n) => (n === './blackOwnedDiscovery' ? client : undefined));
const FUTURE = '2099-01-01T00:00:00Z';
const identity = (brandId = 'brand-1', overrides = {}) => ({ brandId, brandName: 'Fixture Brand', ownershipVerificationStatus: 'verified', publicOwnershipLabelAllowed: true, verifiedUntil: FUTURE, ...overrides });
const secondary = (overrides = {}) => ({ id: 'sec-1', productId: 'sec-1', brandId: 'brand-1', merchantId: 'm', brandName: 'Fixture Brand', title: 'Fixture bomber', productUrl: 'https://kscan.app/fixture/sec-1', type: 'similar', matchType: 'similar', placementType: 'organic', inventoryVerifiedAt: FUTURE, relevanceExplanation: 'Similar style', checkoutCapability: 'product_destination', ...overrides });
const response = (overrides = {}) => ({ version: 'black-owned-discovery-v1', status: 'ready', products: [secondary()], primaryOwnership: {}, generatedAt: FUTURE, ...overrides });

const analysis = {
  type: 'fashion',
  result: 'PRIVATE ANALYSIS PROSE',
  metadata: { category: 'outerwear', primaryItem: 'bomber', color: 'black, white', silhouette: 'cropped', material: 'leather' },
  identificationSnapshot: { category: 'outerwear', subtype: 'bomber', colors: { primary: 'black', secondary: ['white'] }, material: ['leather'], silhouette: ['cropped'], pattern: [], attributes: { distinctive: ['ribbed cuffs', '<script>'] } },
  scanImageUri: 'file:///private/photo.jpg',
  imageBase64: 'PRIVATE_IMAGE_BYTES',
  conversation: 'PRIVATE CHAT',
};

// ── Ordering: primary settles first ─────────────────────────────────────────
test('secondary waits for primary commerce to settle', () => {
  assert.equal(host.isPrimaryCommerceSettled({ ...analysis, commerceDeferred: true }, 'pending'), false);
  assert.equal(host.isPrimaryCommerceSettled({ ...analysis, commerceDeferred: true }, 'idle'), false);
  for (const s of ['success', 'empty', 'error']) assert.equal(host.isPrimaryCommerceSettled({ ...analysis, commerceDeferred: true }, s), true);
  assert.equal(host.isPrimaryCommerceSettled(analysis, 'idle'), true, 'inline products are already settled');
  assert.equal(host.isPrimaryCommerceSettled({ ...analysis, confirmationCandidates: [{ id: 'c' }] }, 'idle'), false, 'no request during multi-item confirmation');
  assert.equal(host.isPrimaryCommerceSettled({ type: 'non-fashion' }, 'idle'), false, 'non-fashion never requests');
  assert.equal(host.isPrimaryCommerceSettled(null, 'success'), false);
});

// ── Privacy: structured attributes only ─────────────────────────────────────
test('request carries sanitized structured attributes, market and primary ids/URLs only', () => {
  const primary = host.primaryIdentities([{ id: 'p1', productUrl: 'https://shop.example.com/a', imageUrl: 'x', title: 'PRIVATE' }]);
  const input = host.buildBlackOwnedDiscoveryInput(analysis, primary);
  assert.deepEqual(JSON.parse(JSON.stringify(input)), {
    garment: { item_type: 'outerwear', subtype: 'bomber', primary_color: 'black', secondary_color: 'white', material_estimate: 'leather', silhouette: 'cropped', distinctive_features: ['ribbed cuffs'] },
    market: 'US',
    primaryProducts: [{ id: 'p1', productUrl: 'https://shop.example.com/a' }],
  });
  const wire = JSON.stringify(input);
  for (const secret of ['PRIVATE', 'photo.jpg', 'file://', 'IMAGE_BYTES', 'CHAT', '<script>']) assert.equal(wire.includes(secret), false, secret);
  assert.equal(host.buildBlackOwnedDiscoveryInput({ metadata: {} }, []), null, 'no category -> no request');
  const legacy = host.buildBlackOwnedDiscoveryInput({ metadata: { category: 'top', primaryItem: 'top', color: 'navy, red' } }, []);
  assert.deepEqual(JSON.parse(JSON.stringify(legacy.garment)), { item_type: 'top', primary_color: 'navy' }, 'legacy metadata fallback; subtype equal to category omitted');
});

test('the actual wire body from the request helper contains no image or prose', async () => {
  let sent;
  const input = host.buildBlackOwnedDiscoveryInput(analysis, []);
  await client.requestBlackOwnedDiscovery(async (name, { body }) => { sent = { name, body }; return { data: response({ status: 'empty', products: [] }), error: null }; }, input, { enabled: true, primarySettled: true });
  assert.equal(sent.name, 'black-owned-discovery');
  assert.doesNotMatch(JSON.stringify(sent.body), /PRIVATE|photo|IMAGE|CHAT|base64/);
});

test('primary identities keep display order, de-duplicate and cap at 30', () => {
  const ids = host.primaryIdentities([{ id: 'b' }, { id: 'a', productUrl: 'https://x.example.com/a' }, { id: 'b' }], [{ id: 'c' }, { id: '' }, null]);
  assert.deepEqual(plain(ids.map((p) => p.id)), ['b', 'a', 'c']);
  assert.equal(host.primaryIdentities(Array.from({ length: 40 }, (_, i) => ({ id: `p${i}` }))).length, 30);
});

// ── Badges and duplicates ───────────────────────────────────────────────────
test('ownership badges: only verified, current, permitted identities for rendered primary ids', () => {
  const map = host.primaryOwnershipById(response({ primaryOwnership: {
    p1: identity(), p2: identity('b2', { verifiedUntil: '2020-01-01T00:00:00Z' }), p3: identity('b3', { publicOwnershipLabelAllowed: false }),
    p4: identity('b4', { ownershipVerificationStatus: 'pending_review' }), ghost: identity('b5'),
  } }), ['p1', 'p2', 'p3', 'p4']);
  assert.deepEqual(plain(Object.keys(map)), ['p1']);
  assert.deepEqual(plain(host.primaryOwnershipById(undefined, ['p1'])), {}, 'unavailable secondary leaves primary unchanged');
  assert.deepEqual(plain(host.primaryOwnershipById(response({ status: 'empty', products: [] }), ['p1'])), {});
});

test('secondary shelf: organic only, never duplicates a primary card, hides empty/unavailable', () => {
  const primary = [{ id: 'p1', productUrl: 'https://kscan.app/fixture/dup#frag' }];
  const shown = host.displayableSecondary(response({ products: [
    secondary(), secondary({ id: 'p1' }), secondary({ id: 'sec-2', productUrl: 'https://kscan.app/fixture/dup' }),
    secondary({ id: 'sec-3', placementType: 'sponsored' }), secondary(),
  ] }), primary);
  assert.deepEqual(plain(shown.products.map((p) => p.id)), ['sec-1']);
  assert.equal(host.displayableSecondary(response({ status: 'empty', products: [] }), primary), undefined);
  assert.equal(host.displayableSecondary(response({ status: 'unavailable', products: [] }), primary), undefined);
  assert.equal(host.displayableSecondary(response({ products: [secondary({ id: 'p1' })] }), primary), undefined, 'all-duplicate -> hidden');
  assert.equal(host.displayableSecondary(undefined, primary), undefined);
});

// ── Hook lifecycle: deferred, cancelled, superseded ─────────────────────────
function createHooks() {
  let slots = [], index = 0, effects = [], dirty = false;
  const react = {
    useState(initial) {
      const i = index++;
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial };
      const slot = slots[i];
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next; dirty = true; }];
    },
    useEffect(fn, deps) {
      const i = index++;
      const prev = slots[i];
      const changed = !prev || !deps || deps.some((d, k) => !Object.is(d, prev.deps[k]));
      if (changed) effects.push(() => { prev?.cleanup?.(); slots[i] = { deps, cleanup: fn() }; });
      else slots[i] = prev;
    },
  };
  return {
    react,
    render(fn) { index = 0; effects = []; dirty = false; const out = fn(); effects.forEach((e) => e()); return out; },
    unmount() { for (const s of slots) s?.cleanup?.(); },
    get dirty() { return dirty; },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 0));
function mountHook() {
  const hooks = createHooks();
  const { useBlackOwnedDiscovery } = load('hooks/useBlackOwnedDiscovery.ts', (n) => (n === 'react' ? hooks.react : n === '../services/supabaseClient' ? { supabase: { functions: { invoke: () => { throw new Error('default client must not be used in tests'); } } } } : n === '../services/blackOwnedDiscovery' ? client : undefined));
  return { hooks, use: (...args) => hooks.render(() => useBlackOwnedDiscovery(...args)) };
}

test('hook never invokes before primary settles, then exactly once after', async () => {
  const { use } = mountHook();
  const input = host.buildBlackOwnedDiscoveryInput(analysis, []);
  const key = host.discoveryRequestKey(input);
  let calls = 0;
  const invoke = async () => { calls++; return { data: response(), error: null }; };
  assert.equal(use(input, key, { enabled: true, primarySettled: false, invoke }), undefined);
  await tick();
  assert.equal(calls, 0, 'deferred: no request while primary is pending');
  use(input, key, { enabled: true, primarySettled: true, invoke });
  await tick();
  assert.equal(calls, 1);
  const result = use(input, key, { enabled: true, primarySettled: true, invoke });
  assert.equal(result.status, 'ready');
  use(input, key, { enabled: true, primarySettled: true, invoke });
  await tick();
  assert.equal(calls, 1, 'equivalent re-render does not refetch');
});

test('disabled feature performs no request and exposes nothing', async () => {
  const { use } = mountHook();
  const input = host.buildBlackOwnedDiscoveryInput(analysis, []);
  let calls = 0;
  const invoke = async () => { calls++; return { data: response(), error: null }; };
  assert.equal(use(input, host.discoveryRequestKey(input), { enabled: false, primarySettled: true, invoke }), undefined);
  assert.equal(use(null, null, { enabled: true, primarySettled: true, invoke }), undefined);
  await tick();
  assert.equal(calls, 0);
});

test('supersession aborts the stale request and discards its late response', async () => {
  const { use, hooks } = mountHook();
  const a = host.buildBlackOwnedDiscoveryInput(analysis, [{ id: 'a' }]);
  const b = host.buildBlackOwnedDiscoveryInput(analysis, [{ id: 'b' }]);
  const signals = [];
  const resolvers = [];
  const invoke = (_n, { signal, body }) => { signals.push(signal); return new Promise((resolve) => resolvers.push(() => resolve({ data: response({ products: [secondary({ id: `for-${body.primaryProducts[0].id}` })] }), error: null }))); };
  use(a, host.discoveryRequestKey(a), { enabled: true, primarySettled: true, invoke });
  await tick();
  use(b, host.discoveryRequestKey(b), { enabled: true, primarySettled: true, invoke });
  await tick();
  assert.equal(signals.length, 2);
  assert.equal(signals[0].aborted, true, 'the first scan request is cancelled');
  resolvers[0]();
  resolvers[1]();
  await tick(); await tick();
  const out = use(b, host.discoveryRequestKey(b), { enabled: true, primarySettled: true, invoke });
  assert.deepEqual(plain(out.products.map((p) => p.id)), ['for-b'], 'never shows the superseded scan');
  hooks.unmount();
  assert.equal(signals[1].aborted, true, 'unmount cancels the in-flight request');
});

test('secondary errors leave the result absent (primary untouched)', async () => {
  const { use } = mountHook();
  const input = host.buildBlackOwnedDiscoveryInput(analysis, []);
  const key = host.discoveryRequestKey(input);
  const invoke = async () => ({ data: null, error: new Error('500') });
  use(input, key, { enabled: true, primarySettled: true, invoke });
  await tick(); await tick();
  assert.equal(use(input, key, { enabled: true, primarySettled: true, invoke }), undefined);
});

// ── Rendering ───────────────────────────────────────────────────────────────
const native = { View: 'div', Text: 'span', Image: 'img', Pressable: 'button', ScrollView: 'div', TouchableOpacity: 'button', ActivityIndicator: 'progress', StyleSheet: { create: (x) => x } };
const theme = { SPACING: { sm: 8, md: 12, xs: 4, lg: 16 }, RADIUS: { sm: 8, md: 12 }, SHADOWS: {}, LUXURY: { cards: { product: { shadow: {} } }, colors: {}, typography: { brandMark: {}, caption: {}, bodyStrong: {}, body: {}, ctaSecondary: {} } } };
const ui = (n) => (n === 'react' ? React : n === 'react-native' ? native : n === '../../constants/theme' ? theme : n === '../../services/blackOwnedDiscovery' ? client : undefined);
const expiry = load('hooks/useOwnershipExpiryRefresh.ts', (n) => n === '../services/blackOwnedDiscovery' ? client : undefined);
const { ProductCard } = load('components/luxury/ProductCard.tsx', (n) => n === '../../hooks/useOwnershipExpiryRefresh' ? expiry : ui(n));
const opened = [];
const stubs = (n) => ui(n) ?? ({
  '../luxury/ProductCard': { ProductCard },
  '../luxury/SectionHeader': { SectionHeader: ({ title }) => React.createElement('h2', null, title) },
  '../luxury/EmptyStateCard': { EmptyStateCard: () => React.createElement('p', null, 'empty') },
  '../luxury/InlineNotice': { InlineNotice: () => null },
  './formatMatchPercent': { formatMatchPercent: () => null },
  '../../services/openExternalUrl': { openExternalUrl: async (url) => { opened.push(url); return true; } },
  '../../services/blackOwnedDiscoveryTelemetry': { trackBlackOwnedDiscovery: () => undefined },
})[n];
const { SimilarFindsShelf } = load('components/scan-results/SimilarFindsShelf.tsx', stubs);
const { BlackOwnedDiscoveryShelf } = load('components/scan-results/BlackOwnedDiscoveryShelf.tsx', stubs);

test('async badge attaches to the matching primary card without reordering or reclassifying', () => {
  const finds = [{ id: 'p2', title: 'Second' }, { id: 'p1', title: 'First' }, { id: 'p3', title: 'Third' }];
  const before = renderToStaticMarkup(React.createElement(SimilarFindsShelf, { similarFinds: finds }));
  const after = renderToStaticMarkup(React.createElement(SimilarFindsShelf, { similarFinds: finds, ownershipById: { p1: identity() } }));
  const order = (html) => [...html.matchAll(/(Second|First|Third)</g)].map((m) => m[1]);
  assert.deepEqual(order(after), order(before));
  assert.deepEqual(order(after), ['Second', 'First', 'Third']);
  assert.equal((before.match(/Black-owned brand/g) || []).length, 0);
  assert.equal((after.match(/Black-owned brand/g) || []).length, 1);
  assert.ok(after.indexOf('Black-owned brand') > after.indexOf('Second') && after.indexOf('Black-owned brand') < after.indexOf('Third'), 'badge on p1 only');
});

test('badge is overlaid on the fixed-ratio image, not inserted into card text flow', () => {
  const card = read('components/luxury/ProductCard.tsx');
  const imageWrapEnd = card.indexOf('<View style={styles.meta}>');
  assert.ok(card.indexOf('Black-owned brand') > 0 && card.indexOf('Black-owned brand') < imageWrapEnd, 'badge lives inside the image container');
  assert.match(card, /ownershipBadge: \{\s*position: 'absolute'/);
  const html = renderToStaticMarkup(React.createElement(ProductCard, { title: 'Ordinary product' }));
  assert.doesNotMatch(html, /Black-owned brand|Sponsored/);
});

test('organic shelf renders genuine products with heading and Shop; hides when empty', () => {
  const html = renderToStaticMarkup(React.createElement(BlackOwnedDiscoveryShelf, { enabled: true, response: response() }));
  assert.match(html, /Discover Black-Owned Brands/);
  assert.match(html, /Fixture bomber/);
  assert.match(html, /Fixture Brand/);
  assert.doesNotMatch(html, /Sponsored|Sandbox/);
  for (const r of [response({ status: 'empty', products: [] }), response({ status: 'unavailable', products: [] }), undefined]) {
    assert.equal(renderToStaticMarkup(React.createElement(BlackOwnedDiscoveryShelf, { enabled: true, response: r })), '');
  }
  assert.equal(renderToStaticMarkup(React.createElement(BlackOwnedDiscoveryShelf, { enabled: false, response: response() })), '');
});

// ── Host wiring (source-level contract on the real surface) ────────────────
test('ScanResultV2 mounts the organic shelf after primary commerce, gated and settle-ordered; no sponsored surface', () => {
  const src = read('components/scan-results/ScanResultV2.tsx');
  const purchase = src.indexOf('<PurchaseOptionsPanel');
  const shelf = src.indexOf('<BlackOwnedDiscoveryShelf');
  assert.ok(purchase > 0 && shelf > purchase, 'secondary shelf renders after primary panels');
  assert.match(src, /primarySettled: isPrimaryCommerceSettled\(analysis, commerceStatus\)/);
  assert.match(src, /enabled: priceDiscoveryEnabled && !SCAN_RESULTS_DEMO_UI_ENABLED/);
  assert.match(src, /ownershipById=\{ownershipById\}/);
  assert.doesNotMatch(src, /SponsorshipSandboxShelf|sponsorship-sandbox/);
  for (const file of ['app.js', ...fs.readdirSync(path.join(ROOT, 'app')).filter((f) => /\.(tsx?|js)$/.test(f)).map((f) => `app/${f}`)]) {
    assert.doesNotMatch(read(file), /SponsorshipSandboxShelf/, `${file} must not expose sponsorship to customers`);
  }
  for (const file of ['services/blackOwnedDiscoveryHost.ts', 'hooks/useBlackOwnedDiscovery.ts']) assert.doesNotMatch(read(file), /Platform\.OS|scanImageUri|base64/, file);
});
