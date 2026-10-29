import assert from 'node:assert/strict';
import { normalizeFeed, synchronizeCatalog, type AuthorizedMerchant, type CatalogStore, type FeedProduct } from './catalog.ts';
import { createShopifyAdapter } from './shopifyAdapter.ts';
import { row } from './fixtures.test.ts';
const merchant: AuthorizedMerchant = { id: 'fixture-merchant', brandId: 'fixture-brand', status: 'active', catalogStatus: 'approved', identityExpiresAt: '2099-01-01T00:00:00Z', sourceAuthorizedUntil: '2099-01-01T00:00:00Z', sourceKind: 'authorized_json', authorizationRef: 'fixture:feed-license', approvedDomains: row.approved_domains, imageDomains: row.image_domains, markets: ['US'] };
const product: FeedProduct = { sourceProductId: 'fixture-source', title: row.title, category: row.category, subtype: row.subtype!, attributes: row.attributes, productUrl: row.product_url, imageUrl: row.image_url, priceAmount: 120, markets: ['US'], availability: 'in_stock', provenanceRef: 'fixture:feed-license' };
Deno.test('catalog normalizer preserves unknown currency, variants and declared availability', () => {
  const normalized = normalizeFeed([product], merchant)[0];
  assert.equal(normalized.currency, null); assert.equal(normalized.price_amount, 120); assert.equal(normalized.variant_id, ''); assert.equal(normalized.availability, 'in_stock');
  assert.equal(normalizeFeed([{ ...product, availability: undefined, priceAmount: null }], merchant)[0].availability, 'unknown');
  assert.equal(normalizeFeed([{ ...product, availability: undefined, priceAmount: null }], merchant)[0].price_amount, null);
});
Deno.test('catalog validates all rows before any upsert: duplicates, invalid amounts, hosts, market, attributes', () => {
  assert.throws(() => normalizeFeed([product, product], merchant));
  assert.throws(() => normalizeFeed([{ ...product, sku: 'same' }, { ...product, sourceProductId: 'two', sku: 'same' }], merchant));
  for (const changes of [{ priceAmount: '12oops' }, { priceAmount: -2 }, { priceAmount: Infinity }, { currency: 'USDD' }, { productUrl: 'https://10.0.0.1/secret' }, { markets: ['GB'] }, { category: 'spaceship' }]) assert.throws(() => normalizeFeed([{ ...product, ...changes }], merchant));
});
Deno.test('worker authorizes before source calls; reserves quota; idempotent retries avoid source I/O', async () => {
  let calls = 0; let writes = 0; let stored = false;
  const store: CatalogStore = { merchant: async () => merchant, begin: async () => ({ status: stored ? 'succeeded' : 'running', productCount: stored ? 1 : 0 }), ingest: async (_id,_key,rows,complete) => { writes++; stored = true; assert.equal(rows.length,1); assert.equal(complete,true); return 1; }, failed: async () => {} };
  const adapter = () => ({ kind: 'authorized_json' as const, snapshot: async () => { calls++; return { products: [product], complete: true }; } });
  assert.equal(await synchronizeCatalog(store,merchant.id,'fixture-sync-key',adapter),1);
  assert.equal(await synchronizeCatalog(store,merchant.id,'fixture-sync-key',adapter),1);
  assert.equal(calls,1); assert.equal(writes,1);
  store.merchant = async () => ({ ...merchant, status: 'inactive' });
  await assert.rejects(synchronizeCatalog(store,merchant.id,'fixture-sync-two',adapter)); assert.equal(calls,1);
});
Deno.test('invalid feed and source failures record only allowlisted errors and never publish or withdraw', async () => {
  let writes = 0; const errors: string[] = [];
  const store: CatalogStore = { merchant: async () => merchant, begin: async () => ({ status: 'running', productCount: 0 }), ingest: async () => { writes++; return 0; }, failed: async (_id,_key,code) => { errors.push(code); } };
  await assert.rejects(synchronizeCatalog(store,merchant.id,'fixture-fail-one',()=>({kind:'authorized_json',snapshot:async()=>{throw new Error('secret upstream body');}})));
  await assert.rejects(synchronizeCatalog(store,merchant.id,'fixture-fail-two',()=>({kind:'authorized_json',snapshot:async()=>({products:[{...product,priceAmount:-1}],complete:true})})));
  assert.deepEqual(errors,['source_unavailable','invalid_feed']); assert.equal(writes,0);
});
const shopMerchant = { ...merchant, sourceKind: 'shopify_storefront' as const, approvedDomains: [...merchant.approvedDomains, 'fixture-shop.myshopify.com'] };
const config = { shopDomain: 'fixture-shop.myshopify.com', privateStorefrontToken: 'synthetic-fixture-token', marketCountry: 'US', fashionByProductId: { 'gid://shopify/Product/fixture': { category: product.category, subtype: product.subtype!, attributes: product.attributes! } } };
function shopPayload(overrides: Record<string,unknown> = {}) { return { data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [{ id: 'gid://shopify/Product/fixture', title: product.title, onlineStoreUrl: product.productUrl, featuredImage: { url: product.imageUrl }, variants: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'gid://shopify/ProductVariant/fixture', sku: 'fixture-sku', availableForSale: true, price: { amount: '120.00', currencyCode: 'USD' }, selectedOptions: [{ name: 'Size', value: 'M' }] }] }, ...overrides }] } } }; }
Deno.test('authorized Shopify adapter queries only the fixed API, uses private server token, no images/customer transmission',async()=>{
  let calls=0;
  const adapter=createShopifyAdapter(shopMerchant,config,async(url,init)=>{
    calls++; assert.equal(url,'https://fixture-shop.myshopify.com/api/2026-10/graphql.json');assert.equal(init?.redirect,'error');
    const body=JSON.parse(String(init?.body)); assert.equal(body.variables.country,'US');assert.equal('image' in body,false);assert.equal((init?.headers as Record<string,string>)['Shopify-Storefront-Private-Token'],'synthetic-fixture-token');
    return Response.json(shopPayload());
  });
  const snapshot=await adapter.snapshot(new AbortController().signal);
  assert.equal(calls,1);assert.equal(snapshot.complete,true);assert.equal(snapshot.products[0].currency,'USD');assert.equal(snapshot.products[0].availability,'in_stock');
  assert.equal(normalizeFeed(snapshot.products,shopMerchant)[0].sku,'fixture-sku');
});
Deno.test('Shopify rejects unauthorized hosts/access; incomplete variants and API errors cannot become full snapshots',async()=>{
  for(const domain of ['localhost','127.0.0.1','fixture-shop.myshopify.com.evil.com','evil.com'])assert.throws(()=>createShopifyAdapter(shopMerchant,{...config,shopDomain:domain}));
  assert.throws(()=>createShopifyAdapter(shopMerchant,{...config,privateStorefrontToken:''}));
  assert.throws(()=>createShopifyAdapter({...shopMerchant,status:'inactive'},config));
  const incomplete=createShopifyAdapter(shopMerchant,config,async()=>Response.json(shopPayload({variants:{pageInfo:{hasNextPage:true},nodes:[]}})));
  await assert.rejects(incomplete.snapshot(new AbortController().signal));
  const broken=createShopifyAdapter(shopMerchant,config,async()=>Response.json({errors:[{message:'private provider content'}]}));
  await assert.rejects(broken.snapshot(new AbortController().signal));
});
