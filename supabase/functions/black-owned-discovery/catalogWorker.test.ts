// Isolated synthetic merchants and feeds. No live merchant, credential or request.
import assert from 'node:assert/strict';
import { createAuthorizedJsonAdapter } from './authorizedJsonAdapter.ts';
import { normalizeFeed, type AuthorizedMerchant, type CatalogStore, type FeedProduct } from './catalog.ts';
import { createCatalogWorkerHandler, syncKey, WORKER_HEADER, type CatalogWorkerDependencies } from './catalogWorker.ts';
import { rankCatalog } from './engine.ts';
import { subtypeKey, subtypeMatchKeys } from './validation.ts';
import { input, row, NOW } from './fixtures.test.ts';

const on = { discovery: true, badges: true, sponsored: false };
const merchant: AuthorizedMerchant = { id: 'fixture-merchant', brandId: 'fixture-brand', status: 'active', catalogStatus: 'approved', identityExpiresAt: '2099-01-01T00:00:00Z', sourceAuthorizedUntil: '2099-01-01T00:00:00Z', sourceKind: 'authorized_json', authorizationRef: 'fixture:feed-license', approvedDomains: row.approved_domains, imageDomains: row.image_domains, markets: ['US'] };
const product: FeedProduct = { sourceProductId: 'fixture-source', title: row.title, category: row.category, subtype: 'Bombers', attributes: row.attributes, productUrl: row.product_url, imageUrl: row.image_url, priceAmount: 120, markets: ['US'], availability: 'in_stock', provenanceRef: 'fixture:feed-license' };
const feedUrl = 'https://fixture-fashion.com/kscan/catalog.json';

Deno.test('subtype keys canonicalize scanner phrasing without widening the head noun', () => {
  assert.equal(subtypeKey('Chelsea Boots'), 'chelsea boot');
  assert.equal(subtypeKey('chelsea-boot'), 'chelsea boot');
  assert.equal(subtypeKey('Dresses'), 'dress');
  assert.equal(subtypeKey('jeans'), 'jean');
  assert.equal(subtypeKey('  '), null); assert.equal(subtypeKey(42), null);
  assert.deepEqual(subtypeMatchKeys('Black Leather Chelsea Boots'), ['black leather chelsea boot', 'leather chelsea boot', 'chelsea boot', 'boot']);
  assert.deepEqual(subtypeMatchKeys(undefined), []);
});
Deno.test('ingest stores canonical subtypes, and ranking matches scanner phrasing', () => {
  assert.equal(normalizeFeed([product], merchant)[0].subtype, 'bomber');
  const scan = { ...input, garment: { ...input.garment, subtype: 'Cropped Bomber Jackets' } };
  assert.equal(rankCatalog(scan, [{ ...row, subtype: 'bomber jacket' }], on, NOW).length, 1);
  assert.equal(rankCatalog({ ...input, garment: { ...input.garment, subtype: 'Bombers' } }, [row], on, NOW).length, 1);
});
Deno.test('incorrect or more-specific subtypes never fill the shelf', () => {
  const boots = { ...input, garment: { ...input.garment, item_type: 'footwear', subtype: 'chelsea boots' } };
  const footwear = { ...row, category: 'footwear' };
  assert.equal(rankCatalog(boots, [{ ...footwear, subtype: 'sandal' }], on, NOW).length, 0);
  assert.equal(rankCatalog({ ...boots, garment: { ...boots.garment, subtype: 'boots' } }, [{ ...footwear, subtype: 'chelsea boot' }], on, NOW).length, 0);
  assert.equal(rankCatalog({ ...boots, garment: { ...boots.garment, subtype: undefined } }, [{ ...footwear, subtype: 'boot' }], on, NOW).length, 0);
  assert.equal(rankCatalog(boots, [{ ...footwear, subtype: 'boot' }], on, NOW).length, 1);
});

function feedResponse(body: unknown, init?: ResponseInit) { return new Response(JSON.stringify(body), init); }
Deno.test('authorized JSON feed: reviewed host only, no redirects, server bearer, explicit complete', async () => {
  let seen: RequestInit | undefined;
  const adapter = createAuthorizedJsonAdapter(merchant, { feedUrl, bearerToken: 'synthetic-fixture-token' }, async (url, init) => {
    assert.equal(url, feedUrl); seen = init;
    return feedResponse({ complete: true, products: [{ ...product, provenanceRef: undefined }] });
  });
  const snapshot = await adapter.snapshot(new AbortController().signal);
  assert.equal(seen?.redirect, 'error'); assert.equal((seen?.headers as Record<string, string>).Authorization, 'Bearer synthetic-fixture-token');
  assert.equal(snapshot.complete, true); assert.equal(snapshot.products[0].provenanceRef, merchant.authorizationRef);
  const partial = createAuthorizedJsonAdapter(merchant, { feedUrl }, async () => feedResponse({ products: [product] }));
  assert.equal((await partial.snapshot(new AbortController().signal)).complete, false);
  for (const bad of ['http://fixture-fashion.com/feed.json', 'https://evil.com/feed.json', 'https://fixture-fashion.com/redirect?url=x', 'https://127.0.0.1/feed.json']) {
    assert.throws(() => createAuthorizedJsonAdapter(merchant, { feedUrl: bad }), bad);
  }
  assert.throws(() => createAuthorizedJsonAdapter(merchant, { feedUrl, bearerToken: 'a\r\nInjected: x' }));
  assert.throws(() => createAuthorizedJsonAdapter({ ...merchant, sourceKind: 'shopify_storefront' }, { feedUrl }));
  assert.throws(() => createAuthorizedJsonAdapter({ ...merchant, sourceAuthorizedUntil: '2000-01-01T00:00:00Z' }, { feedUrl }));
});
Deno.test('authorized JSON feed rejects failures, malformed, oversized and over-limit payloads', async () => {
  const signal = new AbortController().signal;
  const cases: (() => Response)[] = [
    () => new Response('nope', { status: 503 }),
    () => feedResponse({ items: [] }),
    () => feedResponse({ products: Array.from({ length: 501 }, () => product) }),
    () => new Response('x'.repeat(2_000_001)),
    () => new Response('{not json'),
  ];
  for (const respond of cases) await assert.rejects(createAuthorizedJsonAdapter(merchant, { feedUrl }, async () => respond()).snapshot(signal));
});

const SECRET = 'synthetic-worker-secret';
function deps(overrides: Partial<CatalogWorkerDependencies> = {}) {
  const calls = { merchants: 0, fetches: 0, ingests: [] as { id: string; key: string; complete: boolean }[] };
  const store: CatalogStore = {
    merchant: async (id) => ({ ...merchant, id }),
    begin: async () => ({ status: 'running', productCount: 0 }),
    ingest: async (id, key, products, complete) => { calls.ingests.push({ id, key, complete }); return products.length; },
    failed: async () => {},
  };
  const value: CatalogWorkerDependencies = {
    secret: () => SECRET, enabled: () => true, secretsEqual: async (a, b) => a === b,
    merchants: async () => { calls.merchants++; return [{ id: 'merchant-a', credentialRef: 'FIXTURE_A' }, { id: 'merchant-b', credentialRef: 'FIXTURE_B' }, { id: 'merchant-c', credentialRef: null }]; },
    sourceConfig: (ref) => (ref === 'FIXTURE_A' || ref === 'FIXTURE_B' ? { feedUrl: `https://fixture-fashion.com/${ref}.json` } : null),
    store, now: () => NOW,
    fetcher: async (url) => { calls.fetches++; if (String(url).includes('FIXTURE_B')) return new Response('down', { status: 502 }); return feedResponse({ complete: true, products: [product] }); },
    ...overrides,
  };
  return { value, calls };
}
const post = (headers: Record<string, string> = { [WORKER_HEADER]: SECRET }) => new Request('https://fixture.invalid/black-owned-catalog-sync', { method: 'POST', headers, body: '{}' });

Deno.test('worker refuses every non-worker caller before any catalog I/O', async () => {
  const { value, calls } = deps();
  const handler = createCatalogWorkerHandler(value);
  assert.equal((await handler(post({}))).status, 401);
  assert.equal((await handler(post({ [WORKER_HEADER]: 'wrong' }))).status, 401);
  assert.equal((await handler(post({ Authorization: `Bearer ${SECRET}` }))).status, 401);
  assert.equal((await handler(new Request('https://fixture.invalid/x', { method: 'GET', headers: { [WORKER_HEADER]: SECRET } }))).status, 405);
  assert.equal((await createCatalogWorkerHandler({ ...value, secret: () => null })(post())).status, 401);
  assert.equal(calls.merchants, 0); assert.equal(calls.fetches, 0);
});
Deno.test('kill switch off returns enabled:false with zero I/O', async () => {
  const { value, calls } = deps({ enabled: () => false });
  const body = await (await createCatalogWorkerHandler(value)(post())).json();
  assert.equal(body.enabled, false); assert.equal(calls.merchants, 0); assert.equal(calls.fetches, 0);
});
Deno.test('worker isolates merchant failures, skips unconfigured sources, reports counts only', async () => {
  const { value, calls } = deps();
  const response = await createCatalogWorkerHandler(value)(post());
  const body = await response.json();
  assert.deepEqual(body, { mode: 'catalog_sync', enabled: true, merchants: 3, succeeded: 1, failed: 1, skipped: 1, products: 1 });
  assert.deepEqual(calls.ingests, [{ id: 'merchant-a', key: syncKey(NOW), complete: true }]);
  assert.equal(JSON.stringify(body).includes('merchant-'), false);
  assert.equal(syncKey(NOW), 'catalog:2026102912');
});
Deno.test('malformed credential references are never resolved to secrets', async () => {
  const asked: string[] = [];
  const { value } = deps({ merchants: async () => [{ id: 'merchant-a', credentialRef: 'lower-case' }, { id: 'merchant-b', credentialRef: 'A'.repeat(65) }], sourceConfig: (ref) => { asked.push(ref); return { feedUrl }; } });
  const body = await (await createCatalogWorkerHandler(value)(post())).json();
  assert.equal(body.skipped, 2); assert.deepEqual(asked, []);
});
Deno.test('merchant inventory failure is a bounded 503, not a partial success', async () => {
  const { value } = deps({ merchants: async () => { throw new Error('private store detail'); } });
  const response = await createCatalogWorkerHandler(value)(post());
  assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'catalog_sync_unavailable' });
});
